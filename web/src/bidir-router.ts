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
import type { Restrictions } from './router.ts';

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

function isForbidden(r: Restrictions, prev: number, via: number, next: number): boolean {
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

  private hFN: number[] = [];
  private hFK: number[] = [];
  private hBN: number[] = [];
  private hBK: number[] = [];

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

  private hpush(ns: number[], ks: number[], node: number, key: number): void {
    let i = ns.length;
    ns.push(node); ks.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p]! <= ks[i]!) break;
      const tn = ns[p]!, tk = ks[p]!;
      ns[p] = ns[i]!; ks[p] = ks[i]!;
      ns[i] = tn;     ks[i] = tk;
      i = p;
    }
  }

  private hpop(ns: number[], ks: number[]): number {
    const node = ns[0]!;
    const last = ns.length - 1;
    if (last > 0) {
      ns[0] = ns[last]!; ks[0] = ks[last]!;
      ns.length = last; ks.length = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1, sz = ns.length;
        let m = i;
        if (l < sz && ks[l]! < ks[m]!) m = l;
        if (r < sz && ks[r]! < ks[m]!) m = r;
        if (m === i) break;
        const tn = ns[m]!, tk = ks[m]!;
        ns[m] = ns[i]!; ks[m] = ks[i]!;
        ns[i] = tn;     ks[i] = tk;
        i = m;
      }
    } else { ns.length = 0; ks.length = 0; }
    return node;
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

    const hFN = this.hFN; hFN.length = 0;
    const hFK = this.hFK; hFK.length = 0;
    const hBN = this.hBN; hBN.length = 0;
    const hBK = this.hBK; hBK.length = 0;
    this.hpush(hFN, hFK, s, hF(s));
    this.hpush(hBN, hBK, t, hB(t));

    let mu = Infinity, meet = -1, settled = 0;

    while (hFN.length > 0 || hBN.length > 0) {
      const minF = hFK[0] ?? Infinity;
      const minB = hBK[0] ?? Infinity;
      if (minF + minB >= mu) break;

      if (minF <= minB) {
        const u = this.hpop(hFN, hFK);
        if (closedVerF[u] === ver) continue;
        closedVerF[u] = ver;
        settled++;
        const gU = gFv(u), gBU = gBv(u);
        if (stB[u] === ver && gU + gBU < mu) { mu = gU + gBU; meet = u; }
        // prevNode for the incoming edge at u (for restriction check on departure)
        const prevU = stF[u] === ver ? parF[u]! : -1;
        for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) {
          const v = targets[ei]!;
          if (restrictions && isForbidden(restrictions, prevU, u, v)) continue;
          const ng = gU + weights[ei]!;
          if (ng < gFv(v)) {
            gF[v] = ng; stF[v] = ver; parF[v] = u;
            this.hpush(hFN, hFK, v, ng + hF(v));
          }
        }
      } else {
        const v = this.hpop(hBN, hBK);
        if (closedVerB[v] === ver) continue;
        closedVerB[v] = ver;
        settled++;
        const gV = gBv(v), gFV = gFv(v);
        if (stF[v] === ver && gFV + gV < mu) { mu = gFV + gV; meet = v; }
        // In the forward path: any predecessor u arrives at v, then continues to parB[v].
        // Check restriction u→v→parB[v] for each candidate predecessor u.
        const nextV = stB[v] === ver ? parB[v]! : -1;
        for (let k = revOff[v]!; k < revOff[v + 1]!; k++) {
          const u = revSrc[k]!;
          if (restrictions && nextV >= 0 && isForbidden(restrictions, u, v, nextV)) continue;
          const ng = gV + weights[revEI[k]!]!;
          if (ng < gBv(u)) {
            gB[u] = ng; stB[u] = ver; parB[u] = v;
            this.hpush(hBN, hBK, u, ng + hB(u));
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

let _router: BidirRouter | null = null;

export function bidirRoute(
  graph: Graph, rev: RevCSR, weights: Float64Array,
  alt: AltData | null, restrictions: Restrictions | null, s: number, t: number,
): BidirResult | null {
  if (!_router) _router = new BidirRouter(graph.n);
  return _router.query(graph, rev, weights, alt, restrictions, s, t);
}
