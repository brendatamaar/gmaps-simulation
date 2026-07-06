// Alternative-route search on top of the single-shot WASM A*.
//
// Penalty method: route once, inflate the winning route's edge weights so the
// next A* is pushed onto a genuinely different corridor, repeat. Each candidate
// is then scored with the true (un-penalised) live weights so its ETA is honest.
// This is the cheap, classic way to get Google's "2-3 options" without
// k-shortest machinery, and needs no preprocessing: it all rides the live A*.

import type { Graph } from './graph.ts';
import type { Router, Restrictions } from './router.ts';
import {
  fillWeights, pathWeight, pathDistanceMeters, etaSeconds, modeHScale,
  type TrafficModel, type TravelMode,
} from './traffic.ts';
import { bidirRoute, type RevCSR } from './bidir-router.ts';
import type { AltData } from './alt.ts';

export type RouteOption = {
  path: Int32Array;
  // Edge index actually traversed per hop ([path.length-1]); null for routes
  // from routers that don't report edges (CH).
  edges: Int32Array | null;
  etaSec: number;
  distanceM: number;
  nodesVisited: number;
  queryMs: number;
};

const PENALTY = 3.0;          // weight multiplier applied to an accepted route's edges
const MAX_RATIO = 1.6;        // drop alternatives slower than 1.6× the fastest
const MAX_ROUTES = 3;
const OVERLAP_THRESHOLD = 0.70; // reject candidates sharing >70% of distance with accepted routes

// Penalize a route's edges and snapshot their pre-penalty weights (first touch
// only, so the snapshot always holds the original clean weight for each edge).
function penalizeSnapshot(
  weights: Float64Array, edges: Int32Array, snapshot: Map<number, number>,
): void {
  for (let k = 0; k < edges.length; k++) {
    const ei = edges[k]!;
    if (!snapshot.has(ei)) snapshot.set(ei, weights[ei]!);
    weights[ei] *= PENALTY;
  }
}

function signature(path: Int32Array): string {
  return path.join(','); // paths are a few hundred entries, cheap enough
}

// Fraction of a candidate's distance that runs on edges already in `accepted`.
function overlapFraction(graph: Graph, edges: Int32Array, accepted: Set<number>): number {
  let sharedDist = 0, totalDist = 0;
  for (let k = 0; k < edges.length; k++) {
    const ei = edges[k]!;
    const d = graph.distances[ei]!;
    totalDist += d;
    if (accepted.has(ei)) sharedDist += d;
  }
  return totalDist > 0 ? sharedDist / totalDist : 1;
}

// When the destination is a restriction-split via node, the search targets its
// zero-length arrival node (see restriction-split.ts); trim that synthetic
// final hop so the displayed route ends on the real junction.
function trimArrival(
  path: Int32Array, edges: Int32Array, arrivalEnd: number | null,
): { path: Int32Array; edges: Int32Array } {
  if (arrivalEnd !== null && path.length >= 2 && path[path.length - 1] === arrivalEnd) {
    return { path: path.subarray(0, path.length - 1), edges: edges.subarray(0, edges.length - 1) };
  }
  return { path, edges };
}

// Returns 1 to MAX_ROUTES options, fastest first. The WASM weight buffer is left
// holding the clean live weights for the given (hour, trafficOn, mode).
// arrivalEnd: routing target override when `end` is a restriction-split via.
export function computeRoutes(
  graph: Graph, router: Router, model: TrafficModel,
  start: number, end: number, hour: number, trafficOn: boolean, mode: TravelMode,
  arrivalEnd: number | null = null,
): RouteOption[] {
  fillWeights(router.weights, graph, model, hour, trafficOn, mode);
  const target = arrivalEnd ?? end;
  const hScale = modeHScale(mode);

  const seen = new Set<string>();
  const options: RouteOption[] = [];
  const snapshot = new Map<number, number>(); // original weights before penalization
  const acceptedEdges = new Set<number>();    // edges on already-accepted routes

  for (let i = 0; i < MAX_ROUTES; i++) {
    const r = router.route(start, target, hScale);
    if (!r) break;
    const { path, edges } = trimArrival(r.path, r.edges, arrivalEnd);
    if (path.length < 2) break;
    const sig = signature(path);
    if (!seen.has(sig) && overlapFraction(graph, edges, acceptedEdges) <= OVERLAP_THRESHOLD) {
      seen.add(sig);
      const trueCost = pathWeight(graph, model, edges, hour, trafficOn, mode);
      options.push({
        path,
        edges,
        etaSec: etaSeconds(trueCost),
        distanceM: pathDistanceMeters(graph, path, edges),
        nodesVisited: r.nodesVisited,
        queryMs: r.queryMs,
      });
      for (let k = 0; k < edges.length; k++) acceptedEdges.add(edges[k]!);
    }
    if (i < MAX_ROUTES - 1) penalizeSnapshot(router.weights, edges, snapshot);
  }

  // Restore only penalized edges — O(path edges) instead of O(all 1.8 M edges).
  for (const [ei, w] of snapshot) router.weights[ei] = w;

  // Primary sort: ETA. Tiebreaker: when both routes round to the same displayed
// minute, prefer the shorter distance so the more direct route comes first.
options.sort((a, b) =>
  Math.round(a.etaSec / 60) === Math.round(b.etaSec / 60)
    ? a.distanceM - b.distanceM
    : a.etaSec - b.etaSec,
);
  const best = options[0];
  return best ? options.filter((o) => o.etaSec <= best.etaSec * MAX_RATIO) : [];
}

// Same as computeRoutes but uses bidirectional A* + ALT instead of WASM A*.
// Used for drive + traffic ON queries.
// maxRoutes (default MAX_ROUTES): cap the penalty iterations. Pass 2 for the live
// drag path (one primary + one penalty check) to halve the bidir A* call count.
// arrivalEnd: routing target override when `end` is a restriction-split via.
export function computeRoutesBidir(
  graph: Graph, rev: RevCSR, weights: Float64Array,
  alt: AltData | null, restrictions: Restrictions | null, model: TrafficModel,
  start: number, end: number, hour: number, trafficOn: boolean, mode: TravelMode,
  maxRoutes = MAX_ROUTES,
  arrivalEnd: number | null = null,
): RouteOption[] {
  fillWeights(weights, graph, model, hour, trafficOn, mode);
  const target = arrivalEnd ?? end;

  const seen = new Set<string>();
  const options: RouteOption[] = [];
  const snapshot = new Map<number, number>();
  const acceptedEdges = new Set<number>();

  for (let i = 0; i < maxRoutes; i++) {
    const br = bidirRoute(graph, rev, weights, alt, restrictions, start, target);
    if (!br) break;
    const { path, edges } = trimArrival(br.path, br.edges, arrivalEnd);
    if (path.length < 2) break;
    const sig = signature(path);
    if (!seen.has(sig) && overlapFraction(graph, edges, acceptedEdges) <= OVERLAP_THRESHOLD) {
      seen.add(sig);
      const trueCost = pathWeight(graph, model, edges, hour, trafficOn, mode);
      options.push({
        path,
        edges,
        etaSec: etaSeconds(trueCost),
        distanceM: pathDistanceMeters(graph, path, edges),
        nodesVisited: br.settled,
        queryMs: br.queryMs,
      });
      for (let k = 0; k < edges.length; k++) acceptedEdges.add(edges[k]!);
    }
    if (i < maxRoutes - 1) penalizeSnapshot(weights, edges, snapshot);
  }

  for (const [ei, w] of snapshot) weights[ei] = w;

  // Primary sort: ETA. Tiebreaker: when both routes round to the same displayed
// minute, prefer the shorter distance so the more direct route comes first.
options.sort((a, b) =>
  Math.round(a.etaSec / 60) === Math.round(b.etaSec / 60)
    ? a.distanceM - b.distanceM
    : a.etaSec - b.etaSec,
);
  const best = options[0];
  return best ? options.filter((o) => o.etaSec <= best.etaSec * MAX_RATIO) : [];
}
