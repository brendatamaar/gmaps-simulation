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
import type { CSR } from "./csr.ts";

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
  out: CHEdge[][];
  inc: CHEdge[][];
  rank: Int32Array; // contraction order; assigned as nodes are contracted
  contracted: Uint8Array;

  constructor(n: number) {
    this.n = n;
    this.out = Array.from({ length: n }, () => []);
    this.inc = Array.from({ length: n }, () => []);
    this.rank = new Int32Array(n).fill(-1);
    this.contracted = new Uint8Array(n);
  }

  /** Insert u→w, or relax an existing u→w to the smaller weight. */
  addOrRelax(
    u: number,
    w: number,
    weight: number,
    mid: number,
    ca: CHEdge | null,
    cb: CHEdge | null,
  ): void {
    const existing = this.out[u]!.find((e) => e.to === w);
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
  }
}

export function fromCSR(csr: CSR): CHGraph {
  const g = new CHGraph(csr.n);
  const { offsets, targets, distances } = csr;
  for (let u = 0; u < csr.n; u++) {
    const start = offsets[u]!,
      end = offsets[u + 1]!;
    for (let e = start; e < end; e++) {
      const v = targets[e]!;
      if (v === -1) continue;
      g.addOrRelax(u, v, distances[e]!, -1, null, null);
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

// Witness search. Is there a path u→w (avoiding v) no longer than `limit`,
// using only not-yet-contracted nodes? Bounded for tractability.

function witnessExists(
  g: CHGraph,
  u: number,
  w: number,
  avoid: number,
  limit: number,
  maxSettled: number,
): boolean {
  const dist = new Map<number, number>();
  const h = new MinHeap();
  dist.set(u, 0);
  h.push(u, 0);
  let settled = 0;

  while (h.size > 0) {
    const { node: x, f } = h.pop()!;
    if (f > (dist.get(x) ?? Infinity)) continue; // stale heap entry
    if (f > limit) return false; // everything beyond is too far
    if (x === w) return true;
    if (++settled > maxSettled) return false; // give up → caller adds shortcut
    for (const e of g.out[x]!) {
      if (e.to === avoid || g.contracted[e.to]) continue;
      const nd = f + e.weight;
      if (nd <= limit && nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        h.push(e.to, nd);
      }
    }
  }
  return false;
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

const WITNESS_MAX_SETTLED = 60;

function findShortcuts(g: CHGraph, v: number): Shortcut[] {
  const preds = g.inc[v]!.filter((e) => !g.contracted[e.to]);
  const succs = g.out[v]!.filter((e) => !g.contracted[e.to]);
  const shortcuts: Shortcut[] = [];

  for (const pe of preds) {
    const u = pe.to;
    for (const se of succs) {
      const w = se.to;
      if (w === u) continue;
      const through = pe.weight + se.weight;
      // Shortcut needed only if no path u→w (avoiding v) is as short as u→v→w.
      // An equal-length witness counts: the through-v path isn't uniquely shortest.
      if (!witnessExists(g, u, w, v, through, WITNESS_MAX_SETTLED)) {
        // Children: the out-edge u→v (pe's twin) and the out-edge v→w (se).
        shortcuts.push({ u, w, weight: through, ca: pe.twin!, cb: se });
      }
    }
  }
  return shortcuts;
}

function edgeDifference(g: CHGraph, v: number, shortcutCount: number): number {
  let deg = 0;
  for (const e of g.inc[v]!) if (!g.contracted[e.to]) deg++;
  for (const e of g.out[v]!) if (!g.contracted[e.to]) deg++;
  return shortcutCount - deg;
}

function contractNode(g: CHGraph, v: number): number {
  const shortcuts = findShortcuts(g, v);
  for (const s of shortcuts) g.addOrRelax(s.u, s.w, s.weight, v, s.ca, s.cb);
  return shortcuts.length;
}

// Full preprocessing with lazy edge-difference ordering.

export type PreprocessStats = { shortcuts: number; ms: number };

export function preprocess(
  g: CHGraph,
  onProgress?: (done: number, n: number) => void,
): PreprocessStats {
  const t0 = performance.now();
  const n = g.n;
  const pq = new MinHeap();
  for (let v = 0; v < n; v++) {
    pq.push(v, edgeDifference(g, v, findShortcuts(g, v).length));
  }

  let nextRank = 0,
    totalShortcuts = 0;
  while (pq.size > 0) {
    const { node: v } = pq.pop()!;
    if (g.contracted[v]) continue;

    // Lazy update: recompute v's priority; if it's no longer the minimum,
    // re-insert and defer. This keeps the ordering honest without eagerly
    // touching every neighbour on every contraction.
    const sc = findShortcuts(g, v);
    const ed = edgeDifference(g, v, sc.length);
    if (pq.size > 0 && ed > pq.peekF()) {
      pq.push(v, ed);
      continue;
    }

    for (const s of sc) g.addOrRelax(s.u, s.w, s.weight, v, s.ca, s.cb);
    g.contracted[v] = 1;
    g.rank[v] = nextRank++;
    totalShortcuts += sc.length;

    if (onProgress && nextRank % 20000 === 0) onProgress(nextRank, n);
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
