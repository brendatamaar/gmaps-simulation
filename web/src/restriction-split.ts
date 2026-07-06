// Bakes turn restrictions into the graph topology at load time so every
// shortest-path search is exactly correct without restriction-aware code in
// its hot loop.
//
// The node-based routers keep a single (g, parent) label per node, which
// cannot represent "the cheapest way into a via node arrives from a forbidden
// predecessor, but a slightly costlier entry could legally continue". Instead
// of multi-label search, we split each restricted via node v:
//
//   - For every restricted predecessor p of v (p appears as `from` in some
//     restriction pair at v), append a copy node c_p. The edge p→v is
//     retargeted to p→c_p, and c_p carries v's outgoing edges minus the
//     forbidden p→v→next turns. Entering v from p now lands on a node that
//     physically cannot make the forbidden turn.
//   - v itself keeps its outgoing edges (so departures FROM v when v is the
//     query origin are unrestricted) and its incoming edges from unrestricted
//     predecessors.
//   - Arrivals AT v need no turn, so any entry must be able to terminate
//     there: append an arrival node a_v with zero-length edges from v and
//     every copy, and no outgoing edges. Queries ending at v are remapped to
//     a_v (see arrivalOf); through-traffic can never use a_v as a shortcut
//     because it dead-ends.
//
// Copies and arrival nodes share v's coordinates, so rendering, directions
// and distance math need no special cases. They are marked scc=0 so
// nearestNode never snaps to them. ALT landmark tables are indexed by
// original node id; altRemap maps every split-graph node back to its
// physical original so the heuristics stay valid (a copy is only harder to
// reach/leave than its original, so the original's bounds remain admissible).
//
// Chained restrictions (via nodes that are also predecessors of other via
// nodes) work because retargeting is applied by physical identity: a cloned
// edge out of c_p targets the same copy of the next via that v's own edge
// does.

import type { Graph } from './graph.ts';
import type { Restrictions } from './router.ts';

export type SplitResult = {
  graph: Graph;
  // arrivalOf.get(v) = arrival node to use as the routing target when the
  // query destination is restricted via v. Undefined for all other nodes.
  arrivalOf: Map<number, number>;
  // altRemap[node] = original node id (identity for pre-existing nodes).
  altRemap: Int32Array;
  // First appended node id — every id >= this is a copy or arrival node.
  firstSplitNode: number;
};

export function applyRestrictionSplit(g: Graph, r: Restrictions): SplitResult | null {
  if (r.viaCount === 0) return null;

  const { n, offsets, targets, distances, classes, nameIds, lats, lons, scc } = g;

  // Per via: restricted predecessor → set of forbidden next nodes.
  const viaIndex = new Map<number, number>();
  const forbidden: Array<Map<number, Set<number>>> = [];
  for (let vi = 0; vi < r.viaCount; vi++) {
    viaIndex.set(r.viaNodes[vi]!, vi);
    const m = new Map<number, Set<number>>();
    const pStart = r.pairOffs[vi]!;
    const pEnd = vi < r.viaCount - 1 ? r.pairOffs[vi + 1]! : r.pairCount;
    for (let pi = pStart; pi < pEnd; pi++) {
      const from = r.pairs[pi * 2]!, to = r.pairs[pi * 2 + 1]!;
      let s = m.get(from);
      if (!s) m.set(from, (s = new Set()));
      s.add(to);
    }
    forbidden.push(m);
  }

  // Allocate ids for copies (one per restricted predecessor) and arrivals.
  let nextId = n;
  const copyOf: Array<Map<number, number>> = []; // copyOf[vi].get(pred) = copy id
  const arrival = new Int32Array(r.viaCount);
  const arrivalOf = new Map<number, number>();
  for (let vi = 0; vi < r.viaCount; vi++) {
    const m = new Map<number, number>();
    for (const pred of forbidden[vi]!.keys()) m.set(pred, nextId++);
    copyOf.push(m);
    arrival[vi] = nextId++;
    arrivalOf.set(r.viaNodes[vi]!, arrival[vi]!);
  }
  const n2 = nextId;

  // Where an edge from physical node `fromId` to `to` points in the split graph.
  const retarget = (fromId: number, to: number): number => {
    const vi = viaIndex.get(to);
    if (vi === undefined) return to;
    return copyOf[vi]!.get(fromId) ?? to;
  };

  // Out-degrees: originals keep theirs (+1 arrival edge for vias); copies get
  // via outdeg minus forbidden targets, +1 arrival edge; arrivals get 0.
  const off2 = new Int32Array(n2 + 1);
  for (let u = 0; u < n; u++) {
    off2[u + 1] = offsets[u + 1]! - offsets[u]! + (viaIndex.has(u) ? 1 : 0);
  }
  for (let vi = 0; vi < r.viaCount; vi++) {
    const v = r.viaNodes[vi]!;
    for (const [pred, c] of copyOf[vi]!) {
      const forb = forbidden[vi]!.get(pred)!;
      let deg = 1; // arrival edge
      for (let ei = offsets[v]!; ei < offsets[v + 1]!; ei++) {
        if (!forb.has(targets[ei]!)) deg++;
      }
      off2[c + 1] = deg;
    }
    // arrival node: off2[arrival+1] stays 0
  }
  for (let i = 0; i < n2; i++) off2[i + 1] = off2[i]! + off2[i + 1]!;
  const e2 = off2[n2]!;

  const targets2 = new Int32Array(e2);
  const dist2 = new Float64Array(e2);
  const classes2 = new Uint8Array(e2);
  const nameIds2 = new Uint32Array(e2);

  const copyEdge = (w: number, ei: number, fromId: number): void => {
    targets2[w] = retarget(fromId, targets[ei]!);
    dist2[w] = distances[ei]!;
    classes2[w] = classes[ei]!;
    nameIds2[w] = nameIds[ei]!;
  };
  // Zero-length connector into the arrival node: class 7 keeps it off the
  // traffic overlay, nameId 0 keeps it out of directions street names.
  const arrivalEdge = (w: number, a: number): void => {
    targets2[w] = a;
    dist2[w] = 0;
    classes2[w] = 7;
    nameIds2[w] = 0;
  };

  for (let u = 0; u < n; u++) {
    let w = off2[u]!;
    for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) copyEdge(w++, ei, u);
    const vi = viaIndex.get(u);
    if (vi !== undefined) arrivalEdge(w, arrival[vi]!);
  }
  for (let vi = 0; vi < r.viaCount; vi++) {
    const v = r.viaNodes[vi]!;
    for (const [pred, c] of copyOf[vi]!) {
      const forb = forbidden[vi]!.get(pred)!;
      let w = off2[c]!;
      for (let ei = offsets[v]!; ei < offsets[v + 1]!; ei++) {
        if (forb.has(targets[ei]!)) continue;
        copyEdge(w++, ei, v); // copy's physical identity is v
      }
      arrivalEdge(w, arrival[vi]!);
    }
  }

  const lats2 = new Float64Array(n2);
  const lons2 = new Float64Array(n2);
  const scc2 = new Uint8Array(n2); // appended nodes stay 0: never snap to them
  const altRemap = new Int32Array(n2);
  lats2.set(lats); lons2.set(lons); scc2.set(scc);
  for (let i = 0; i < n; i++) altRemap[i] = i;
  for (let vi = 0; vi < r.viaCount; vi++) {
    const v = r.viaNodes[vi]!;
    for (const c of copyOf[vi]!.values()) {
      lats2[c] = lats[v]!; lons2[c] = lons[v]!; altRemap[c] = v;
    }
    const a = arrival[vi]!;
    lats2[a] = lats[v]!; lons2[a] = lons[v]!; altRemap[a] = v;
  }

  return {
    graph: {
      n: n2, e: e2,
      offsets: off2, targets: targets2, distances: dist2,
      classes: classes2, nameIds: nameIds2, names: g.names,
      lats: lats2, lons: lons2, scc: scc2, bounds: g.bounds,
    },
    arrivalOf,
    altRemap,
    firstSplitNode: n,
  };
}
