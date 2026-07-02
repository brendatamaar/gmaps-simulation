// Contraction Hierarchies implementation. The whole pipeline:
//   1. CHGraph        mutable directed weighted graph (out + incoming lists).
//   2. biDijkstra     plain bidirectional Dijkstra (the stepping stone).
//   3. edgeDifference node importance metric.
//   4. contractNode   witness search + shortcut insertion for one node.
//   5. preprocess     lazy ordering, contract all nodes.
//   6. chQuery        bidirectional upward search + shortcut unpacking.
//
// Weights are whatever the CSR carries (haversine metres). CH is exact, so every
// chQuery distance must equal the Dijkstra/A* distance.

import { MinHeap } from "./heap.ts";

// mid = -1 → original road edge. Otherwise the node this shortcut bypasses:
// the shortcut u→w with mid=v stands for the path u→v→w. ca/cb are the two
// out-edges it was built from (u→v and v→w) so unpacking is pure pointer-
// following, no per-hop adjacency scan. twin links an inc-edge back to its
// out-edge counterpart so we can grab those children cheaply at shortcut time.
export type CHEdge = {
  to: number;
  weight: number;
  mid: number;
  ca: CHEdge | null;
  cb: CHEdge | null;
  twin: CHEdge | null;
};

export class CHGraph {
  n: number;
  // Full, append-only adjacency: the augmented graph (original edges + every
  // shortcut). Queries (biDijkstra/CHRouter) and serialization read these.
  out: CHEdge[][];
  inc: CHEdge[][];
  // Live working mirrors, used ONLY during preprocessing. They hold the same
  // CHEdge objects but shrink as nodes are contracted (see removeFromLive), so
  // witness searches and addOrRelax scan O(live-degree), not O(all-edges-ever).
  // Without this, surviving "core" nodes accumulate millions of dead edges and
  // the tail of the contraction order slows super-linearly to a near-hang.
  lout: CHEdge[][];
  linc: CHEdge[][];
  rank: Int32Array; // contraction order; assigned as nodes are contracted
  contracted: Uint8Array;

  constructor(n: number) {
    this.n = n;
    this.out = Array.from({ length: n }, () => []);
    this.inc = Array.from({ length: n }, () => []);
    this.lout = Array.from({ length: n }, () => []);
    this.linc = Array.from({ length: n }, () => []);
    this.rank = new Int32Array(n).fill(-1);
    this.contracted = new Uint8Array(n);
  }

  /** Insert u→w, or relax an existing live u→w to the smaller weight. */
  addOrRelax(
    u: number,
    w: number,
    weight: number,
    mid: number,
    ca: CHEdge | null,
    cb: CHEdge | null,
  ): void {
    // Only live edges can be relaxed during preprocessing; search the live list.
    const existing = this.lout[u]!.find((e) => e.to === w);
    if (existing) {
      if (weight < existing.weight) {
        existing.weight = weight;
        existing.mid = mid;
        existing.ca = ca;
        existing.cb = cb;
        const back = existing.twin!;
        back.weight = weight;
        back.mid = mid;
        back.ca = ca;
        back.cb = cb;
      }
      return;
    }
    const outE: CHEdge = { to: w, weight, mid, ca, cb, twin: null };
    const incE: CHEdge = { to: u, weight, mid, ca, cb, twin: outE }; // `to` is the *source*
    outE.twin = incE; // twin = the counterpart edge in the other list, both directions
    this.out[u]!.push(outE);
    this.inc[w]!.push(incE);
    this.lout[u]!.push(outE);
    this.linc[w]!.push(incE);
  }

  /** Drop v from its live neighbours' working lists once v is contracted.
   *  The full out/inc lists keep every edge for serialization + queries. */
  removeFromLive(v: number): void {
    for (const se of this.lout[v]!) removeRef(this.linc[se.to]!, se.twin!); // v→w : drop inc-edge at w
    for (const pe of this.linc[v]!) removeRef(this.lout[pe.to]!, pe.twin!); // u→v : drop out-edge at u
    this.lout[v] = [];
    this.linc[v] = [];
  }
}

/** Swap-remove an edge from an adjacency array by object identity (O(len)). */
function removeRef(list: CHEdge[], e: CHEdge): void {
  const i = list.indexOf(e);
  if (i === -1) return;
  const last = list.length - 1;
  if (i !== last) list[i] = list[last]!;
  list.pop();
}

type CSRLike = { n: number; offsets: Int32Array; targets: Int32Array; distances: Float64Array };

export function fromCSR(
  csr: CSRLike,
  weightFn?: (edgeIdx: number) => number,
): CHGraph {
  const g = new CHGraph(csr.n);
  const { offsets, targets, distances } = csr;
  for (let u = 0; u < csr.n; u++) {
    const start = offsets[u]!,
      end = offsets[u + 1]!;
    for (let e = start; e < end; e++) {
      const v = targets[e]!;
      if (v === -1) continue;
      g.addOrRelax(u, v, weightFn ? weightFn(e) : distances[e]!, -1, null, null);
    }
  }
  return g;
}

// Plain bidirectional Dijkstra (no contraction). Stepping stone.

export type BiResult = { dist: number; path: number[]; settled: number };

export function biDijkstra(g: CHGraph, s: number, t: number): BiResult | null {
  if (s === t) return { dist: 0, path: [s], settled: 0 };
  const n = g.n;
  const distF = new Float64Array(n).fill(Infinity);
  const distB = new Float64Array(n).fill(Infinity);
  const doneF = new Uint8Array(n);
  const doneB = new Uint8Array(n);
  const parF = new Int32Array(n).fill(-1);
  const parB = new Int32Array(n).fill(-1);

  distF[s] = 0;
  distB[t] = 0;
  const hF = new MinHeap();
  hF.push(s, 0);
  const hB = new MinHeap();
  hB.push(t, 0);

  let mu = Infinity,
    meet = -1,
    settled = 0;

  while (hF.size > 0 || hB.size > 0) {
    // Classic stopping rule: once the two frontiers' minima sum to ≥ best, done.
    if (hF.peekF() + hB.peekF() >= mu) break;

    if (hF.size > 0 && hF.peekF() <= hB.peekF()) {
      const { node: u } = hF.pop()!;
      if (doneF[u]) continue;
      doneF[u] = 1;
      settled++;
      if (doneB[u] && distF[u]! + distB[u]! < mu) {
        mu = distF[u]! + distB[u]!;
        meet = u;
      }
      for (const e of g.out[u]!) {
        const nd = distF[u]! + e.weight;
        if (nd < distF[e.to]!) {
          distF[e.to] = nd;
          parF[e.to] = u;
          hF.push(e.to, nd);
        }
      }
    } else {
      const { node: u } = hB.pop()!;
      if (doneB[u]) continue;
      doneB[u] = 1;
      settled++;
      if (doneF[u] && distF[u]! + distB[u]! < mu) {
        mu = distF[u]! + distB[u]!;
        meet = u;
      }
      for (const e of g.inc[u]!) {
        // backward: walk incoming edges (e.to is the source)
        const nd = distB[u]! + e.weight;
        if (nd < distB[e.to]!) {
          distB[e.to] = nd;
          parB[e.to] = u;
          hB.push(e.to, nd);
        }
      }
    }
  }

  if (meet === -1) return null;

  const path: number[] = [];
  for (let v = meet; v !== -1; v = parF[v]!) path.push(v);
  path.reverse();
  for (let v = parB[meet]!; v !== -1; v = parB[v]!) path.push(v);
  return { dist: mu, path, settled };
}

// Witness search context: pre-allocated arrays shared across all witness searches
// during preprocessing so we never allocate a Map or heap per search call.
// Version stamp gives O(1) reset — no array clearing needed between calls.
class WitnessCtx {
  private dist: Float64Array;
  private stamp: Int32Array;
  private ver = 0;
  // Growable heap for witness search. It must never silently drop frontier
  // nodes: a dropped node makes the search miss a real witness, which inserts
  // an unnecessary shortcut. In the densified tail those bogus shortcuts feed a
  // runaway clique, so we grow on demand instead of capping.
  private hNodes = new Int32Array(2048);
  private hKeys  = new Float64Array(2048);
  private hLen   = 0;

  constructor(n: number) {
    this.dist  = new Float64Array(n);
    this.stamp = new Int32Array(n);
  }

  private hGrow(): void {
    const cap = this.hNodes.length * 2;
    const ns = new Int32Array(cap); ns.set(this.hNodes); this.hNodes = ns;
    const ks = new Float64Array(cap); ks.set(this.hKeys); this.hKeys = ks;
  }

  private hPush(node: number, key: number): void {
    if (this.hLen >= this.hNodes.length) this.hGrow();
    let i = this.hLen++;
    this.hNodes[i] = node; this.hKeys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.hKeys[p]! <= key) break;
      const tn = this.hNodes[p]!, tk = this.hKeys[p]!;
      this.hNodes[p] = this.hNodes[i]!; this.hKeys[p] = this.hKeys[i]!;
      this.hNodes[i] = tn; this.hKeys[i] = tk;
      i = p;
    }
  }

  private hPop(): { node: number; f: number } | undefined {
    if (this.hLen === 0) return undefined;
    const node = this.hNodes[0]!, f = this.hKeys[0]!;
    const last = --this.hLen;
    if (last > 0) {
      this.hNodes[0] = this.hNodes[last]!; this.hKeys[0] = this.hKeys[last]!;
      let i = 0;
      while (true) {
        let min = i;
        const l = 2*i+1, r = l+1;
        if (l < last && this.hKeys[l]! < this.hKeys[min]!) min = l;
        if (r < last && this.hKeys[r]! < this.hKeys[min]!) min = r;
        if (min === i) break;
        const tn = this.hNodes[min]!, tk = this.hKeys[min]!;
        this.hNodes[min] = this.hNodes[i]!; this.hKeys[min] = this.hKeys[i]!;
        this.hNodes[i] = tn; this.hKeys[i] = tk;
        i = min;
      }
    }
    return { node, f };
  }

  exists(
    g: CHGraph,
    u: number,
    w: number,
    avoid: number,
    limit: number,
    maxSettled: number,
  ): boolean {
    const ver = ++this.ver;
    const { dist, stamp } = this;
    this.hLen = 0;
    dist[u] = 0; stamp[u] = ver;
    this.hPush(u, 0);
    let settled = 0;

    while (this.hLen > 0) {
      const { node: x, f } = this.hPop()!;
      if (stamp[x] !== ver || f > dist[x]!) continue; // stale
      if (f > limit) return false;
      if (x === w) return true;
      if (++settled > maxSettled) return false;
      for (const e of g.lout[x]!) {
        // Live list holds only uncontracted targets; only `avoid` (the node
        // being contracted, still live) must be skipped.
        if (e.to === avoid) continue;
        const nd = f + e.weight;
        if (nd <= limit && (stamp[e.to] !== ver || nd < dist[e.to]!)) {
          dist[e.to] = nd; stamp[e.to] = ver;
          this.hPush(e.to, nd);
        }
      }
    }
    return false;
  }
}

// Contract one node, finding the shortcuts its removal requires.
// With apply=false this only counts them (used to score importance).

type Shortcut = {
  u: number;
  w: number;
  weight: number;
  ca: CHEdge;
  cb: CHEdge;
};

// Witness-search settle cap. Bounds witness cost on the large graph early on,
// where a true witness is normally a few hops away so the cap is rarely hit. In
// the small uncontracted core at the end the cap would instead cause missed
// witnesses (→ unnecessary shortcuts → densification), so preprocess lifts it
// to an effectively-exact value once the core is small (see contractMaxSettled).
const WITNESS_MAX_SETTLED = 60;

function findShortcuts(
  g: CHGraph,
  v: number,
  ctx: WitnessCtx,
  maxSettled = WITNESS_MAX_SETTLED,
): Shortcut[] {
  const preds = g.linc[v]!; // live lists already exclude contracted neighbours
  const succs = g.lout[v]!;
  const shortcuts: Shortcut[] = [];

  for (const pe of preds) {
    const u = pe.to;
    for (const se of succs) {
      const w = se.to;
      if (w === u) continue;
      const through = pe.weight + se.weight;
      // Shortcut needed only if no path u→w (avoiding v) is as short as u→v→w.
      // An equal-length witness counts: the through-v path isn't uniquely shortest.
      if (!ctx.exists(g, u, w, v, through, maxSettled)) {
        // Children: the out-edge u→v (pe's twin) and the out-edge v→w (se).
        shortcuts.push({ u, w, weight: through, ca: pe.twin!, cb: se });
      }
    }
  }
  return shortcuts;
}

function edgeDifference(g: CHGraph, v: number, shortcutCount: number): number {
  // Live lists are already pruned of contracted neighbours.
  const deg = g.linc[v]!.length + g.lout[v]!.length;
  return shortcutCount - deg;
}

// Full preprocessing with lazy edge-difference ordering.

export type PreprocessStats = { shortcuts: number; ms: number };

export function preprocess(
  g: CHGraph,
  onProgress?: (done: number, n: number) => void,
): PreprocessStats {
  const t0 = performance.now();
  const n = g.n;
  // One WitnessCtx for the entire preprocessing run — allocates typed arrays
  // once and reuses them for every witness search via version stamping.
  const ctx = new WitnessCtx(n);
  const pq = new MinHeap();
  for (let v = 0; v < n; v++) {
    pq.push(v, edgeDifference(g, v, findShortcuts(g, v, ctx).length));
  }

  // Cap re-insertions per node. High-degree tail nodes can bounce O(k²) times
  // without this limit, turning the last 0.3% into 90% of the runtime.
  // After MAX_BOUNCE deferred pops, contract the node in whatever order it lands.
  // Slightly sub-optimal ordering for the last few nodes; negligible in practice.
  const MAX_BOUNCE = 5;
  const bounceCount = new Int32Array(n);

  // Once the uncontracted core is this small, run witness searches to (near-)
  // exactness so they stop fabricating shortcuts and the core can't densify into
  // a clique. The core is tiny here, so an exact search is still cheap.
  const CORE_EXACT = 5000;

  let nextRank = 0,
    totalShortcuts = 0;
  while (pq.size > 0) {
    const { node: v } = pq.pop()!;
    if (g.contracted[v]) continue;

    const remaining = n - nextRank;
    const maxSettled = remaining <= CORE_EXACT ? remaining : WITNESS_MAX_SETTLED;

    // Lazy update: recompute v's priority; if it's no longer the minimum,
    // re-insert and defer. This keeps the ordering honest without eagerly
    // touching every neighbour on every contraction.
    const sc = findShortcuts(g, v, ctx, maxSettled);
    const ed = edgeDifference(g, v, sc.length);
    if (pq.size > 0 && ed > pq.peekF() && bounceCount[v]! < MAX_BOUNCE) {
      bounceCount[v]++;
      pq.push(v, ed);
      continue;
    }

    for (const s of sc) g.addOrRelax(s.u, s.w, s.weight, v, s.ca, s.cb);
    g.contracted[v] = 1;
    g.rank[v] = nextRank++;
    totalShortcuts += sc.length;
    g.removeFromLive(v); // prune v from neighbours' live lists so scans stay O(live-deg)

    if (onProgress && nextRank % 1000 === 0) onProgress(nextRank, n);
  }

  // Reset the contracted flags: queries use `rank`, not `contracted`, and the
  // flag would otherwise make the augmented graph look fully removed.
  g.contracted.fill(0);
  return { shortcuts: totalShortcuts, ms: performance.now() - t0 };
}

// Bidirectional upward query + shortcut unpacking.

export type CHResult = { dist: number; path: number[]; settled: number };

// CH queries settle only a handful of nodes, so allocating O(n) scratch per call
// would dominate the runtime. CHRouter keeps the scratch persistent and resets
// it in O(1) with a per-query version stamp. This is how CH earns its speed.
export class CHRouter {
  private g: CHGraph;
  private n: number;
  private ver = 0;
  private distF: Float64Array;
  private distB: Float64Array;
  private stF: Int32Array;
  private stB: Int32Array; // stamp: entry valid iff === ver
  private parF: Int32Array;
  private parB: Int32Array;
  private eF: (CHEdge | null)[];
  private eB: (CHEdge | null)[];

  constructor(g: CHGraph) {
    this.g = g;
    this.n = g.n;
    this.distF = new Float64Array(g.n);
    this.distB = new Float64Array(g.n);
    this.stF = new Int32Array(g.n);
    this.stB = new Int32Array(g.n);
    this.parF = new Int32Array(g.n);
    this.parB = new Int32Array(g.n);
    this.eF = new Array(g.n).fill(null);
    this.eB = new Array(g.n).fill(null);
  }

  query(s: number, t: number): CHResult | null {
    if (s === t) return { dist: 0, path: [s], settled: 0 };
    const g = this.g;
    const ver = ++this.ver;
    const { distF, distB, stF, stB, parF, parB, eF, eB } = this;
    const dF = (i: number) => (stF[i] === ver ? distF[i]! : Infinity);
    const dB = (i: number) => (stB[i] === ver ? distB[i]! : Infinity);

    distF[s] = 0;
    stF[s] = ver;
    parF[s] = -1;
    distB[t] = 0;
    stB[t] = ver;
    parB[t] = -1;
    const hF = new MinHeap();
    hF.push(s, 0);
    const hB = new MinHeap();
    hB.push(t, 0);

    let mu = Infinity,
      meet = -1,
      settled = 0;

    // Each search relaxes only edges that go *up* the hierarchy. Run both to
    // exhaustion; the upward search space is tiny, so no clever stopping needed.
    const run = (
      h: MinHeap,
      dist: Float64Array,
      st: Int32Array,
      dSelf: (i: number) => number,
      dOther: (i: number) => number,
      par: Int32Array,
      edge: (CHEdge | null)[],
      adj: CHEdge[][],
    ) => {
      while (h.size > 0) {
        const { node: u, f } = h.pop()!;
        if (f > dSelf(u)) continue;
        settled++;
        const ou = dOther(u);
        if (ou < Infinity && dSelf(u) + ou < mu) {
          mu = dSelf(u) + ou;
          meet = u;
        }
        for (const e of adj[u]!) {
          if (g.rank[e.to]! <= g.rank[u]!) continue; // upward only
          const nd = dSelf(u) + e.weight;
          if (nd < dSelf(e.to)) {
            dist[e.to] = nd;
            st[e.to] = ver;
            par[e.to] = u;
            edge[e.to] = e;
            h.push(e.to, nd);
          }
        }
      }
    };

    run(hF, distF, stF, dF, dB, parF, eF, g.out);
    run(hB, distB, stB, dB, dF, parB, eB, g.inc);

    if (meet === -1) return null;

    // Collect the (possibly-shortcut) edges on each half, then unpack into one
    // node array with push-only appends, no spreads, no adjacency scans.
    // Forward edges, s → meet (collected meet→s, so reversed).
    const fEdges: CHEdge[] = [];
    const fFrom: number[] = [];
    for (let v = meet; parF[v]! !== -1; v = parF[v]!) {
      fEdges.push(eF[v]!);
      fFrom.push(parF[v]!);
    }
    fEdges.reverse();
    fFrom.reverse();
    // Backward edges, meet → t. eB[v] is an inc-edge (its `.to` is the source);
    // its twin is the out-edge v→parB[v], with the right orientation + children.
    const bEdges: CHEdge[] = [];
    const bFrom: number[] = [];
    for (let v = meet; parB[v]! !== -1; v = parB[v]!) {
      bEdges.push(eB[v]!.twin!);
      bFrom.push(v);
    }

    const path: number[] = [fFrom.length > 0 ? fFrom[0]! : meet];
    for (let i = 0; i < fEdges.length; i++)
      unpackInto(path, fFrom[i]!, fEdges[i]!);
    for (let i = 0; i < bEdges.length; i++)
      unpackInto(path, bFrom[i]!, bEdges[i]!);

    return { dist: mu, path, settled };
  }
}

// Convenience wrapper: caches a CHRouter on the graph so repeat calls reuse its
// scratch. Used by tests; hot paths should hold a CHRouter directly.
const routerCache = new WeakMap<CHGraph, CHRouter>();
export function chQuery(g: CHGraph, s: number, t: number): CHResult | null {
  let r = routerCache.get(g);
  if (!r) {
    r = new CHRouter(g);
    routerCache.set(g, r);
  }
  return r.query(s, t);
}

// Append the original nodes of edge `from`→`e.to` to `out`, excluding `from`
// (the caller already placed it). A shortcut splits into its two child edges:
// from→mid (ca) then mid→to (cb), recursively, down to original road edges.
function unpackInto(out: number[], from: number, e: CHEdge): void {
  if (e.mid === -1) {
    out.push(e.to);
    return;
  }
  unpackInto(out, from, e.ca!);
  unpackInto(out, e.mid, e.cb!);
}
