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
import type { SearchTrace } from './search-trace.ts';

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

export type RouteSearchResult = {
  options: RouteOption[];
  // Settlement-order trace of the winning (first, un-penalized) search, or
  // null if not requested. Used to drive the search-animation replay.
  trace: SearchTrace | null;
  // Node where the forward and backward searches met (bidirectional only).
  meetNode: number | null;
};

// Sort by a composite key — (rounded-minute, distance, exact ETA) — rather
// than a pairwise "same displayed minute ⇒ compare distance" comparator.
// The pairwise version isn't transitive (A ties B, B ties C, but A and C can
// differ), which Array.sort doesn't guarantee correct results for; a plain
// composite key is a genuine total order regardless of how many candidates
// there are, at no extra cost.
function sortOptions(options: RouteOption[]): void {
  options.sort((a, b) => {
    const ra = Math.round(a.etaSec / 60), rb = Math.round(b.etaSec / 60);
    if (ra !== rb) return ra - rb;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    return a.etaSec - b.etaSec;
  });
}

// One search attempt from a penalty-method iteration. `edges` must always be
// present (even if empty) since trimArrival/pathWeight/etc. index into it;
// `trace`/`meet` are only meaningful on the first iteration and are only
// checked when defined, so callers that don't support tracing simply omit them.
type SearchStep = {
  path: Int32Array;
  edges: Int32Array;
  nodesVisited: number;
  queryMs: number;
  trace?: SearchTrace | null;
  meet?: number | null;
} | null;

// Shared penalty-method loop: run `routeOnce` up to `maxRoutes` times,
// inflating each accepted route's edges before the next call so later calls
// are pushed onto different corridors, then re-score every candidate with the
// true (un-penalized) weights. `routeOnce(i)` must itself apply any pending
// penalty from the previous iteration (i.e. read `weights` fresh each call) —
// this function only decides *when* to penalize and *how much* to restore.
function runPenaltyLoop(
  graph: Graph, model: TrafficModel, weights: Float64Array,
  hour: number, trafficOn: boolean, mode: TravelMode,
  arrivalEnd: number | null, maxRoutes: number,
  routeOnce: (i: number) => SearchStep,
): RouteSearchResult {
  const seen = new Set<string>();
  const options: RouteOption[] = [];
  const snapshot = new Map<number, number>(); // original weights before penalization
  const acceptedEdges = new Set<number>();    // edges on already-accepted routes
  let trace: SearchTrace | null = null;
  let meetNode: number | null = null;

  try {
    for (let i = 0; i < maxRoutes; i++) {
      const r = routeOnce(i);
      if (!r) break;
      if (i === 0) {
        if (r.trace !== undefined) trace = r.trace;
        if (r.meet !== undefined) meetNode = r.meet;
      }
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
      if (i < maxRoutes - 1) penalizeSnapshot(weights, edges, snapshot);
    }
  } finally {
    // Restore only penalized edges — O(path edges) instead of O(all 1.8 M edges).
    for (const [ei, w] of snapshot) weights[ei] = w;
  }

  sortOptions(options);
  const best = options[0];
  return {
    options: best ? options.filter((o) => o.etaSec <= best.etaSec * MAX_RATIO) : [],
    trace,
    meetNode,
  };
}

// Returns 1 to MAX_ROUTES options, fastest first. The WASM weight buffer is left
// holding the clean live weights for the given (hour, trafficOn, mode).
// arrivalEnd: routing target override when `end` is a restriction-split via.
export function computeRoutes(
  graph: Graph, router: Router, model: TrafficModel,
  start: number, end: number, hour: number, trafficOn: boolean, mode: TravelMode,
  wantTrace = false,
  arrivalEnd: number | null = null,
): RouteSearchResult {
  fillWeights(router.weights, graph, model, hour, trafficOn, mode);
  const target = arrivalEnd ?? end;
  const hScale = modeHScale(mode);

  return runPenaltyLoop(
    graph, model, router.weights, hour, trafficOn, mode, arrivalEnd, MAX_ROUTES,
    (i) => {
      const r = router.route(start, target, hScale);
      if (!r) return null;
      let trace: SearchTrace | undefined;
      if (i === 0 && wantTrace) {
        const order = router.lastVisitOrder();
        trace = { order, side: new Uint8Array(order.length) };
      }
      return { path: r.path, edges: r.edges, nodesVisited: r.nodesVisited, queryMs: r.queryMs, trace };
    },
  );
}

// Same as computeRoutes but uses bidirectional A* + ALT instead of WASM A*.
// Used for drive + traffic ON queries.
// maxRoutes (default MAX_ROUTES): cap the penalty iterations. Pass 2 for the live
// drag path (one primary + one penalty check) to halve the bidir A* call count.
export function computeRoutesBidir(
  graph: Graph, rev: RevCSR, weights: Float64Array,
  alt: AltData | null, restrictions: Restrictions | null, model: TrafficModel,
  start: number, end: number, hour: number, trafficOn: boolean, mode: TravelMode,
  maxRoutes = MAX_ROUTES,
  wantTrace = false,
  arrivalEnd: number | null = null,
): RouteSearchResult {
  fillWeights(weights, graph, model, hour, trafficOn, mode);
  const target = arrivalEnd ?? end;

  return runPenaltyLoop(
    graph, model, weights, hour, trafficOn, mode, arrivalEnd, maxRoutes,
    (i) => {
      const br = bidirRoute(graph, rev, weights, alt, restrictions, start, target, wantTrace && i === 0);
      if (!br) return null;
      return { path: br.path, edges: br.edges, nodesVisited: br.settled, queryMs: br.queryMs, trace: br.trace, meet: br.meet };
    },
  );
}
