// CSR graph (populated from JS via pointer accessors)
let N: i32 = 0;
let E: i32 = 0;
let offsetsPtr: usize = 0; // i32[N+1]
let targetsPtr: usize = 0; // i32[E]
let distPtr:    usize = 0; // f64[E]
let latsPtr:    usize = 0; // f64[N]
let lonsPtr:    usize = 0; // f64[N]

// A* scratch (allocated once in initGraph)
let gPtr:     usize = 0; // f64[N] g-scores
let parentPtr: usize = 0; // i32[N] parent pointers
let closedPtr: usize = 0; // u8[N]  closed set

// Result
let pathPtr:    usize = 0; // i32[N]
let pathLen:    i32   = 0;
let distResult: f64   = 0.0;
let visitedRes: i32   = 0;

// Binary min-heap (lazy, no decrease-key), parallel arrays
// Worst-case pushes = E (one per edge relaxation)
let hNodePtr:  usize = 0; // i32[E]
let hScorePtr: usize = 0; // f64[E]
let hSize:     i32   = 0;

// Turn restriction lookup (sparse, sorted by via node for binary search).
// rViaPtr[i]  = via node index (sorted ascending)
// rOffPtr[i]  = start index in rPairPtr for via i; end = next entry or rPairCount
// rPairPtr[j*2], rPairPtr[j*2+1] = (from, to) node indices of forbidden turn j
let rViaPtr:    usize = 0;
let rOffPtr:    usize = 0;
let rPairPtr:   usize = 0;
let rViaCount:  i32   = 0;
let rPairCount: i32   = 0;

const DEG2RAD: f64 = Math.PI / 180.0;
const EARTH_R: f64  = 6371000.0;

@inline
function haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64): f64 {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const sdLat = Math.sin(dLat * 0.5);
  const sdLon = Math.sin(dLon * 0.5);
  const a = sdLat * sdLat +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * sdLon * sdLon;
  return EARTH_R * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
}

export function initGraph(nodeCount: i32, edgeCount: i32): void {
  N = nodeCount;
  E = edgeCount;
  offsetsPtr = heap.alloc(<usize>((N + 1) << 2));
  targetsPtr = heap.alloc(<usize>(E << 2));
  distPtr    = heap.alloc(<usize>(E << 3));
  latsPtr    = heap.alloc(<usize>(N << 3));
  lonsPtr    = heap.alloc(<usize>(N << 3));
  gPtr       = heap.alloc(<usize>(N << 3));
  parentPtr  = heap.alloc(<usize>(N << 2));
  closedPtr  = heap.alloc(<usize>N);
  pathPtr    = heap.alloc(<usize>(N << 2));
  hNodePtr   = heap.alloc(<usize>(E << 2));
  hScorePtr  = heap.alloc(<usize>(E << 3));
}

export function initRestrictions(viaCount: i32, pairCount: i32): void {
  rViaCount  = viaCount;
  rPairCount = pairCount;
  if (viaCount  > 0) rViaPtr  = heap.alloc(<usize>(viaCount  << 2));
  if (viaCount  > 0) rOffPtr  = heap.alloc(<usize>(viaCount  << 2));
  if (pairCount > 0) rPairPtr = heap.alloc(<usize>(pairCount << 3)); // 2×i32 per pair
}

// Pointer accessors. JS writes graph data into these regions after initGraph()
export function getOffsetsPtr(): usize { return offsetsPtr; }
export function getTargetsPtr(): usize { return targetsPtr; }
export function getDistPtr():    usize { return distPtr; }
export function getLatsPtr():    usize { return latsPtr; }
export function getLonsPtr():    usize { return lonsPtr; }
export function getPathPtr():    usize { return pathPtr; }
export function getPathLen():    i32   { return pathLen; }
export function getDistMeters(): f64   { return distResult; }
export function getNodesVisited(): i32 { return visitedRes; }
export function getRViaPtr():    usize { return rViaPtr; }
export function getROffPtr():    usize { return rOffPtr; }
export function getRPairPtr():   usize { return rPairPtr; }

@inline
function hPush(node: i32, f: f64): void {
  let i = hSize;
  store<i32>(hNodePtr  + (<usize>i << 2), node);
  store<f64>(hScorePtr + (<usize>i << 3), f);
  hSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (load<f64>(hScorePtr + (<usize>p << 3)) <= load<f64>(hScorePtr + (<usize>i << 3))) break;
    const tn = load<i32>(hNodePtr  + (<usize>i << 2));
    const tf = load<f64>(hScorePtr + (<usize>i << 3));
    store<i32>(hNodePtr  + (<usize>i << 2), load<i32>(hNodePtr  + (<usize>p << 2)));
    store<f64>(hScorePtr + (<usize>i << 3), load<f64>(hScorePtr + (<usize>p << 3)));
    store<i32>(hNodePtr  + (<usize>p << 2), tn);
    store<f64>(hScorePtr + (<usize>p << 3), tf);
    i = p;
  }
}

@inline
function hPop(): i32 {
  const top = load<i32>(hNodePtr);
  hSize--;
  if (hSize > 0) {
    store<i32>(hNodePtr,  load<i32>(hNodePtr  + (<usize>hSize << 2)));
    store<f64>(hScorePtr, load<f64>(hScorePtr + (<usize>hSize << 3)));
    let i: i32 = 0;
    while (true) {
      let min = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < hSize && load<f64>(hScorePtr + (<usize>l << 3)) < load<f64>(hScorePtr + (<usize>min << 3))) min = l;
      if (r < hSize && load<f64>(hScorePtr + (<usize>r << 3)) < load<f64>(hScorePtr + (<usize>min << 3))) min = r;
      if (min === i) break;
      const tn = load<i32>(hNodePtr  + (<usize>i << 2));
      const tf = load<f64>(hScorePtr + (<usize>i << 3));
      store<i32>(hNodePtr  + (<usize>i << 2), load<i32>(hNodePtr  + (<usize>min << 2)));
      store<f64>(hScorePtr + (<usize>i << 3), load<f64>(hScorePtr + (<usize>min << 3)));
      store<i32>(hNodePtr  + (<usize>min << 2), tn);
      store<f64>(hScorePtr + (<usize>min << 3), tf);
      i = min;
    }
  }
  return top;
}

// Binary search in the sorted via-node array; returns index or -1.
@inline
function findViaIndex(viaNode: i32): i32 {
  let lo: i32 = 0, hi: i32 = rViaCount - 1;
  while (lo <= hi) {
    const mid: i32 = (lo + hi) >>> 1;
    const v = load<i32>(rViaPtr + (<usize>mid << 2));
    if (v === viaNode) return mid;
    if (v < viaNode) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// Returns true when the turn prevNode→curNode→nextNode is forbidden.
@inline
function isForbidden(prevNode: i32, curNode: i32, nextNode: i32): bool {
  if (rViaCount === 0 || prevNode < 0) return false;
  const vi = findViaIndex(curNode);
  if (vi < 0) return false;
  const pStart = load<i32>(rOffPtr + (<usize>vi << 2));
  const pEnd   = vi < rViaCount - 1
    ? load<i32>(rOffPtr + (<usize>(vi + 1) << 2))
    : rPairCount;
  for (let pi = pStart; pi < pEnd; pi++) {
    if (load<i32>(rPairPtr + (<usize>pi * 2       << 2)) === prevNode &&
        load<i32>(rPairPtr + (<usize>(pi * 2 + 1) << 2)) === nextNode) return true;
  }
  return false;
}

// Returns 0 on success, -1 if no path exists.
// hScale: multiply the haversine heuristic so A* stays admissible when weights
// are scaled (walk ×20, bike ×6.67). Drive stays at 1.0 (motorway stretch = 1).
export function astar(startIdx: i32, endIdx: i32, hScale: f64): i32 {
  for (let i = 0; i < N; i++) {
    store<f64>(gPtr      + (<usize>i << 3), Infinity);
    store<i32>(parentPtr + (<usize>i << 2), -1);
    store<u8> (closedPtr + <usize>i,        0);
  }
  hSize      = 0;
  pathLen    = 0;
  visitedRes = 0;

  const endLat = load<f64>(latsPtr + (<usize>endIdx << 3));
  const endLon = load<f64>(lonsPtr + (<usize>endIdx << 3));

  store<f64>(gPtr + (<usize>startIdx << 3), 0.0);
  hPush(startIdx,
    hScale * haversine(load<f64>(latsPtr + (<usize>startIdx << 3)),
              load<f64>(lonsPtr + (<usize>startIdx << 3)),
              endLat, endLon));

  while (hSize > 0) {
    const cur = hPop();
    if (load<u8>(closedPtr + <usize>cur)) continue;
    store<u8>(closedPtr + <usize>cur, 1);
    visitedRes++;

    if (cur === endIdx) break;

    const edgeStart = load<i32>(offsetsPtr + (<usize> cur      << 2));
    const edgeEnd   = load<i32>(offsetsPtr + (<usize>(cur + 1) << 2));
    const curG      = load<f64>(gPtr        + (<usize>cur      << 3));
    const prevNode  = load<i32>(parentPtr   + (<usize>cur      << 2));

    for (let ei = edgeStart; ei < edgeEnd; ei++) {
      const nb = load<i32>(targetsPtr + (<usize>ei << 2));
      if (nb === -1 || load<u8>(closedPtr + <usize>nb)) continue;
      if (isForbidden(prevNode, cur, nb)) continue;
      const tentative = curG + load<f64>(distPtr + (<usize>ei << 3));
      if (tentative < load<f64>(gPtr + (<usize>nb << 3))) {
        store<f64>(gPtr      + (<usize>nb << 3), tentative);
        store<i32>(parentPtr + (<usize>nb << 2), cur);
        hPush(nb, tentative +
          hScale * haversine(load<f64>(latsPtr + (<usize>nb << 3)),
                    load<f64>(lonsPtr + (<usize>nb << 3)),
                    endLat, endLon));
      }
    }
  }

  const finalG = load<f64>(gPtr + (<usize>endIdx << 3));
  if (finalG === Infinity) return -1;

  distResult = finalG;

  // Reconstruct path (built in reverse, then flipped)
  let cur = endIdx;
  let len: i32 = 0;
  while (cur !== -1) {
    store<i32>(pathPtr + (<usize>len << 2), cur);
    cur = load<i32>(parentPtr + (<usize>cur << 2));
    len++;
  }
  for (let i = 0; i < len >> 1; i++) {
    const j = len - 1 - i;
    const tmp = load<i32>(pathPtr + (<usize>i << 2));
    store<i32>(pathPtr + (<usize>i << 2), load<i32>(pathPtr + (<usize>j << 2)));
    store<i32>(pathPtr + (<usize>j << 2), tmp);
  }
  pathLen = len;

  return 0;
}
