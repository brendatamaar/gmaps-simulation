// Bidirectional A* with ALT heuristic for live-traffic (dynamic) queries.
//
// Runs a forward search from s and a backward search from t simultaneously,
// using ALT landmark lower bounds as admissible, consistent heuristics.
// Terminates when minKey_forward + minKey_backward >= mu (best path so far).
//
// The backward search follows forward edges in reverse: for edge u→v it
// relaxes u from v's backward search. The reverse CSR stores (source node,
// forward edge index) per incoming edge so we can read weights[revEI[k]].

import type { Graph } from './graph.ts';
import type { AltData } from './alt.ts';
import { makeForwardHeuristic, makeBackwardHeuristic } from './alt.ts';
import { isForbidden, type Restrictions } from './router.ts';
import { TypedMinHeap } from './typed-heap.ts';

export type BidirResult = {
  path: Int32Array;
  cost: number;
  settled: number;
  queryMs: number;
};

export type RevCSR = {
  revOff: Int32Array; // [n+1]
  revSrc: Int32Array; // [e] source node of each reverse entry
  revEI:  Int32Array; // [e] forward edge index → use weights[revEI[k]]
};

export function buildRevCSR(graph: Graph): RevCSR {
  const { n, e, offsets, targets } = graph;
  const revDeg = new Int32Array(n);
  for (let u = 0; u < n; u++)
    for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++)
      revDeg[targets[ei]!]++;

  const revOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) revOff[i + 1] = revOff[i]! + revDeg[i]!;

  const revSrc = new Int32Array(e);
  const revEI  = new Int32Array(e);
  const pos    = new Int32Array(n);
  for (let u = 0; u < n; u++) {
    for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) {
      const v = targets[ei]!;
      const k = revOff[v]! + pos[v]!;
      revSrc[k] = u; revEI[k] = ei;
      pos[v]++;
    }
  }
  return { revOff, revSrc, revEI };
}

// Persistent scratch — allocated once, reused across queries via version stamps.
class BidirRouter {
  private ver    = 0;
  private gF:    Float64Array;
  private gB:    Float64Array;
  private parF:  Int32Array;
  private parB:  Int32Array;
  private stF:   Int32Array; // stamp: entry is valid iff stF[v] === ver
  private stB:   Int32Array;
  private closedVerF: Int32Array; // stF version when node was settled in forward search
  private closedVerB: Int32Array; // stB version when node was settled in backward search

  private heapF = new TypedMinHeap(4096);
  private heapB = new TypedMinHeap(4096);

  constructor(n: number) {
    this.gF         = new Float64Array(n);
    this.gB         = new Float64Array(n);
    this.parF       = new Int32Array(n);
    this.parB       = new Int32Array(n);
    this.stF        = new Int32Array(n);
    this.stB        = new Int32Array(n);
    this.closedVerF = new Int32Array(n);
    this.closedVerB = new Int32Array(n);
  }

  query(
    graph: Graph, rev: RevCSR, weights: Float64Array,
    alt: AltData | null, restrictions: Restrictions | null, s: number, t: number,
  ): BidirResult | null {
    if (s === t) return { path: new Int32Array([s]), cost: 0, settled: 0, queryMs: 0 };
    const t0  = performance.now();
    const ver = ++this.ver;
    const { gF, gB, parF, parB, stF, stB, closedVerF, closedVerB } = this;
    const { offsets, targets } = graph;
    const { revOff, revSrc, revEI } = rev;

    const hF = alt ? makeForwardHeuristic(alt, t)  : (_: number) => 0;
    const hB = alt ? makeBackwardHeuristic(alt, s) : (_: number) => 0;

    const gFv = (v: number) => (stF[v] === ver ? gF[v]! : Infinity);
    const gBv = (v: number) => (stB[v] === ver ? gB[v]! : Infinity);

    gF[s] = 0; stF[s] = ver; parF[s] = -1;
    gB[t] = 0; stB[t] = ver; parB[t] = -1;

    const heapF = this.heapF; heapF.clear();
    const heapB = this.heapB; heapB.clear();
    heapF.push(s, hF(s));
    heapB.push(t, hB(t));

    let mu = Infinity, meet = -1, settled = 0;

    while (heapF.size > 0 || heapB.size > 0) {
      const minF = heapF.peekKey();
      const minB = heapB.peekKey();
      if (minF + minB >= mu) break;

      if (minF <= minB) {
        const u = heapF.pop();
        if (closedVerF[u] === ver) continue;
        closedVerF[u] = ver;
        settled++;
        // prevNode for the incoming edge at u — also the "from" side of the
        // turn restriction check when u is a meet-node candidate below.
        const prevU = stF[u] === ver ? parF[u]! : -1;
        const gU = gFv(u), gBU = gBv(u);
        if (stB[u] === ver && gU + gBU < mu) {
          // The joined path passes prevU -> u -> parB[u]; neither side's edge
          // relaxation checks that specific turn, so verify it before accepting.
          const nextU = parB[u]!;
          if (!restrictions || !isForbidden(restrictions, prevU, u, nextU)) {
            mu = gU + gBU; meet = u;
          }
        }
        for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) {
          const v = targets[ei]!;
          if (restrictions && isForbidden(restrictions, prevU, u, v)) continue;
          const ng = gU + weights[ei]!;
          if (ng < gFv(v)) {
            gF[v] = ng; stF[v] = ver; parF[v] = u;
            heapF.push(v, ng + hF(v));
          }
        }
      } else {
        const v = heapB.pop();
        if (closedVerB[v] === ver) continue;
        closedVerB[v] = ver;
        settled++;
        // In the forward path: any predecessor u arrives at v, then continues to parB[v].
        // Check restriction u→v→parB[v] for each candidate predecessor u.
        const nextV = stB[v] === ver ? parB[v]! : -1;
        const gV = gBv(v), gFV = gFv(v);
        if (stF[v] === ver && gFV + gV < mu) {
          // The joined path passes parF[v] -> v -> nextV; verify that turn too.
          const prevV = parF[v]!;
          if (!restrictions || !isForbidden(restrictions, prevV, v, nextV)) {
            mu = gFV + gV; meet = v;
          }
        }
        for (let k = revOff[v]!; k < revOff[v + 1]!; k++) {
          const u = revSrc[k]!;
          if (restrictions && nextV >= 0 && isForbidden(restrictions, u, v, nextV)) continue;
          const ng = gV + weights[revEI[k]!]!;
          if (ng < gBv(u)) {
            gB[u] = ng; stB[u] = ver; parB[u] = v;
            heapB.push(u, ng + hB(u));
          }
        }
      }
    }

    if (meet === -1) return null;

    const fwd: number[] = [meet];
    for (let v = meet; parF[v]! !== -1; v = parF[v]!) fwd.push(parF[v]!);
    fwd.reverse();
    for (let v = meet; parB[v]! !== -1; v = parB[v]!) fwd.push(parB[v]!);

    return { path: new Int32Array(fwd), cost: mu, settled, queryMs: performance.now() - t0 };
  }
}

// Keyed by graph (like graph.ts's _bestClassCache) so scratch arrays are
// correctly resized if a new graph — e.g. after a restriction-split rebuild —
// replaces the one bidirRoute was first called with. A module-level singleton
// sized for the first graph would silently read/write out of bounds once a
// larger graph came along.
const _routers = new WeakMap<Graph, BidirRouter>();

export function bidirRoute(
  graph: Graph, rev: RevCSR, weights: Float64Array,
  alt: AltData | null, restrictions: Restrictions | null, s: number, t: number,
): BidirResult | null {
  let router = _routers.get(graph);
  if (!router) { router = new BidirRouter(graph.n); _routers.set(graph, router); }
  return router.query(graph, rev, weights, alt, restrictions, s, t);
}
