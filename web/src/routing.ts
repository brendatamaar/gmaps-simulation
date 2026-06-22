// Alternative-route search on top of the single-shot WASM A*.
//
// Penalty method: route once, inflate the winning route's edge weights so the
// next A* is pushed onto a genuinely different corridor, repeat. Each candidate
// is then scored with the true (un-penalised) live weights so its ETA is honest.
// This is the cheap, classic way to get Google's "2-3 options" without
// k-shortest machinery, and needs no preprocessing: it all rides the live A*.

import { cheapestEdge, type Graph } from './graph.ts';
import type { Router } from './router.ts';
import {
  fillWeights, pathWeight, pathDistanceMeters, etaSeconds,
  type TrafficModel, type TravelMode,
} from './traffic.ts';

export type RouteOption = {
  path: Int32Array;
  etaSec: number;
  distanceM: number;
  nodesVisited: number;
  queryMs: number;
};

const PENALTY = 3.0;     // weight multiplier applied to an accepted route's edges
const MAX_RATIO = 1.6;   // drop alternatives slower than 1.6× the fastest
const MAX_ROUTES = 3;

function penalize(graph: Graph, weights: Float64Array, path: Int32Array): void {
  for (let k = 1; k < path.length; k++) {
    const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
    if (ei >= 0) weights[ei] *= PENALTY;
  }
}

function signature(path: Int32Array): string {
  return path.join(','); // paths are a few hundred entries, cheap enough
}

// Returns 1 to MAX_ROUTES options, fastest first. The WASM weight buffer is left
// holding the clean live weights for the given (hour, trafficOn, mode).
export function computeRoutes(
  graph: Graph, router: Router, model: TrafficModel,
  start: number, end: number, hour: number, trafficOn: boolean, mode: TravelMode,
): RouteOption[] {
  fillWeights(router.weights, graph, model, hour, trafficOn, mode);

  const seen = new Set<string>();
  const options: RouteOption[] = [];

  for (let i = 0; i < MAX_ROUTES; i++) {
    const r = router.route(start, end);
    if (!r || r.path.length < 2) break;
    const sig = signature(r.path);
    if (!seen.has(sig)) {
      seen.add(sig);
      const trueCost = pathWeight(graph, model, r.path, hour, trafficOn, mode);
      options.push({
        path: r.path,
        etaSec: etaSeconds(trueCost),
        distanceM: pathDistanceMeters(graph, r.path),
        nodesVisited: r.nodesVisited,
        queryMs: r.queryMs,
      });
    }
    if (i < MAX_ROUTES - 1) penalize(graph, router.weights, r.path);
  }

  // Restore clean weights, then rank: fastest first, drop the absurdly slow.
  fillWeights(router.weights, graph, model, hour, trafficOn, mode);
  options.sort((a, b) => a.etaSec - b.etaSec);
  const best = options[0];
  return best ? options.filter((o) => o.etaSec <= best.etaSec * MAX_RATIO) : [];
}
