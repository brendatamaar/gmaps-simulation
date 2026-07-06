// Loads the AssemblyScript A* module and drives it from the browser. The graph
// lives in WASM linear memory; JS writes it once after initGraph, then each
// query is "two indices in, one path out".

import type { Graph } from './graph.ts';

type WasmExports = {
  memory: WebAssembly.Memory;
  initGraph(n: number, e: number): void;
  initRestrictions(viaCount: number, pairCount: number): void;
  getOffsetsPtr(): number;
  getTargetsPtr(): number;
  getDistPtr(): number;
  getLatsPtr(): number;
  getLonsPtr(): number;
  getPathPtr(): number;
  getPathLen(): number;
  getDistMeters(): number;
  getNodesVisited(): number;
  getRViaPtr(): number;
  getROffPtr(): number;
  getRPairPtr(): number;
  astar(startIdx: number, endIdx: number, hScale: number): number;
};

const RESTRICT_MAGIC = 0x52455354; // "REST"

// Parsed restriction data ready for upload into WASM memory and for the JS
// bidirectional A* (which cannot use the WASM restriction tables directly).
export type Restrictions = {
  viaCount: number;
  pairCount: number;
  viaNodes: Int32Array;  // sorted via node indices
  pairOffs: Int32Array;  // start offset in pairs section per via node
  pairs:    Int32Array;  // interleaved (from, to) pairs
};

function findViaIdx(viaNodes: Int32Array, via: number): number {
  let lo = 0, hi = viaNodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = viaNodes[mid]!;
    if (v === via) return mid;
    if (v < via) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// True when the turn prev -> via -> next is forbidden by a loaded restriction.
// Shared by the JS bidirectional router and by callers that need to validate
// a path assembled by a restriction-unaware router (e.g. CH).
export function isForbidden(r: Restrictions, prev: number, via: number, next: number): boolean {
  if (r.viaCount === 0 || prev < 0) return false;
  const vi = findViaIdx(r.viaNodes, via);
  if (vi < 0) return false;
  const pStart = r.pairOffs[vi]!;
  const pEnd   = vi < r.viaCount - 1 ? r.pairOffs[vi + 1]! : r.pairCount;
  for (let pi = pStart; pi < pEnd; pi++) {
    if (r.pairs[pi * 2]! === prev && r.pairs[pi * 2 + 1]! === next) return true;
  }
  return false;
}

// True when any consecutive triple along `path` is a forbidden turn. CH
// contraction/queries are not restriction-aware, so callers using CH must
// validate its path against this before trusting it.
export function pathViolatesRestriction(r: Restrictions, path: ArrayLike<number>): boolean {
  if (r.viaCount === 0) return false;
  for (let i = 1; i < path.length - 1; i++) {
    if (isForbidden(r, path[i - 1]!, path[i]!, path[i + 1]!)) return true;
  }
  return false;
}

export function emptyRestrictions(): Restrictions {
  return { viaCount: 0, pairCount: 0, viaNodes: new Int32Array(0), pairOffs: new Int32Array(0), pairs: new Int32Array(0) };
}

export async function loadRestrictions(): Promise<Restrictions> {
  const res = await fetch('restrictions.bin');
  if (!res.ok) return { viaCount: 0, pairCount: 0, viaNodes: new Int32Array(0), pairOffs: new Int32Array(0), pairs: new Int32Array(0) };
  const ab = await res.arrayBuffer();
  const hdr = new Uint32Array(ab, 0, 4);
  if (hdr[0] !== RESTRICT_MAGIC) return { viaCount: 0, pairCount: 0, viaNodes: new Int32Array(0), pairOffs: new Int32Array(0), pairs: new Int32Array(0) };
  const viaCount  = hdr[2]!;
  const pairCount = hdr[3]!;
  const viaSection  = new Int32Array(ab, 16, viaCount * 2);
  const pairSection = new Int32Array(ab, 16 + viaCount * 8, pairCount * 2);
  const viaNodes = new Int32Array(viaCount);
  const pairOffs = new Int32Array(viaCount);
  for (let i = 0; i < viaCount; i++) {
    viaNodes[i] = viaSection[i * 2]!;
    pairOffs[i] = viaSection[i * 2 + 1]!;
  }
  return { viaCount, pairCount, viaNodes, pairOffs, pairs: pairSection };
}

export type RouteResult = {
  path: Int32Array;      // node indices, start → end (copied out of WASM memory)
  cost: number;          // Σ edge weight (metres-equivalent; ÷MAX_SPEED ⇒ ETA seconds)
  nodesVisited: number;
  queryMs: number;
};

export type Router = {
  // Live view over the WASM weight buffer the A* reads. Write metres-equivalent
  // weights here (see traffic.fillWeights) before calling route().
  weights: Float64Array;
  restrictions: Restrictions;
  route(startIdx: number, endIdx: number, hScale?: number): RouteResult | null;
};

// `restrictions` are uploaded into the WASM A*'s turn-restriction tables. When
// the graph has already had restrictions baked in topologically (see
// restriction-split.ts), pass emptyRestrictions() so the runtime check is inert.
export async function initRouter(graph: Graph, restrictions: Restrictions): Promise<Router> {
  // AssemblyScript's NativeMath compiles to imports from the `Math` namespace,
  // plus env.abort. Cast: the DOM `Imports` type doesn't model the `Math` object.
  const importObject = {
    env: {
      abort(_msg: number, _file: number, line: number, col: number): never {
        throw new Error(`AS abort at ${line}:${col}`);
      },
    },
    Math,
  } as unknown as WebAssembly.Imports;

  const wasmRes = await fetch('release.wasm');
  const { instance } = await WebAssembly.instantiate(await wasmRes.arrayBuffer(), importObject);
  const w = instance.exports as unknown as WasmExports;

  // initGraph and initRestrictions grow WASM memory; all subsequent views are stable.
  w.initGraph(graph.n, graph.e);
  w.initRestrictions(restrictions.viaCount, restrictions.pairCount);
  const buf = w.memory.buffer;
  new Int32Array(buf, w.getOffsetsPtr(), graph.n + 1).set(graph.offsets);
  new Int32Array(buf, w.getTargetsPtr(), graph.e).set(graph.targets);
  new Float64Array(buf, w.getLatsPtr(), graph.n).set(graph.lats);
  new Float64Array(buf, w.getLonsPtr(), graph.n).set(graph.lons);
  if (restrictions.viaCount > 0) {
    new Int32Array(buf, w.getRViaPtr(),  restrictions.viaCount).set(restrictions.viaNodes);
    new Int32Array(buf, w.getROffPtr(),  restrictions.viaCount).set(restrictions.pairOffs);
    new Int32Array(buf, w.getRPairPtr(), restrictions.pairCount * 2).set(restrictions.pairs);
  }

  // Both init calls have run; buf is stable for the lifetime of the page.
  // The caller fills weights with live traffic values per query.
  const weights = new Float64Array(buf, w.getDistPtr(), graph.e);
  weights.set(graph.distances); // sensible default until the traffic model loads

  return {
    weights,
    restrictions,
    route(startIdx, endIdx, hScale = 1.0) {
      const t0 = performance.now();
      const rc = w.astar(startIdx, endIdx, hScale);
      const queryMs = performance.now() - t0;
      if (rc !== 0) return null;
      const len = w.getPathLen();
      // .slice() copies out of WASM memory into a JS-owned array.
      const path = new Int32Array(w.memory.buffer, w.getPathPtr(), len).slice();
      return { path, cost: w.getDistMeters(), nodesVisited: w.getNodesVisited(), queryMs };
    },
  };
}
