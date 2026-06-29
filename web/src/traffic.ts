// Traffic + ETA model (browser side).
//
// The WASM A* minimises Σ edge-weight with a haversine-METRES heuristic, so for
// the heuristic to stay admissible once weights encode travel time we keep
// weights in "metres-equivalent" units:
//
//   weight[e] = length[e] · (MAX_SPEED / speed) · congestion
//
// Because (MAX_SPEED / speed) ≥ 1 and congestion ≥ 1, every weight ≥ length,
// so haversine(node,end) ≤ Σ length ≤ Σ weight, and the heuristic never
// over-estimates. Minimising Σ weight is identical to minimising Σ travel-time
// (they differ only by the constant MAX_SPEED), so the route is the true
// shortest-time path and ETA = Σweight / MAX_SPEED. No WASM change needed.
//
// Speed constants mirror src/lib/roadclass.ts (kept in sync by hand).

import { cheapestEdge, haversine, type Graph } from './graph.ts';
import type { TrafficData } from './trafficData.ts';

export type TravelMode = 'drive' | 'walk' | 'bike';

// Free-flow driving speed per road class id, km/h (motorway..service).
const SPEED_KMH = [100, 80, 60, 50, 40, 30, 30, 20];
const ARTERIAL_MAX_CLASS = 3; // classes 0..3 (motorway..secondary) are arterials

// Non-driving modes: one speed for every road, no traffic sensitivity.
const WALK_KMH = 5;
const BIKE_KMH = 15;

const MAX_SPEED_KMH = Math.max(...SPEED_KMH);
export const MAX_SPEED_MPS = (MAX_SPEED_KMH * 1000) / 3600;

// metres-equivalent stretch factor: how much longer a metre "feels" versus the
// fastest road at free flow. Driving uses the per-class table; walk/bike are flat.
const STRETCH = SPEED_KMH.map((s) => MAX_SPEED_KMH / s);
const WALK_STRETCH = MAX_SPEED_KMH / WALK_KMH;
const BIKE_STRETCH = MAX_SPEED_KMH / BIKE_KMH;

// Jakarta city centre (Monas) anchors the static spatial-congestion field.
// These constants are kept so precompute() still builds a valid staticMult
// fallback — used when traffic.bin has not yet loaded (td = null).
const CENTER_LAT = -6.1754;
const CENTER_LON = 106.8272;
const CENTER_PEAK = 0.6;
const CENTER_SCALE_M = 6000;

export type TrafficModel = {
  // staticMult[e] — Level-1 CBD spatial factor, ≥1. Used as fallback when
  // td is null. Dormant (not applied) once td is loaded, because td already
  // incorporates the spatial factor from the demand model.
  staticMult: Float64Array;
  // td — calibrated per-edge per-hour data from traffic.bin (null until loaded).
  // When non-null, REPLACES staticMult × congestionMultiplier in the drive path.
  td: TrafficData | null;
};

// Precompute the static spatial-congestion field once. This is the Level-1
// fallback model; it becomes dormant after traffic.bin loads (td takes over).
export function precompute(graph: Graph): TrafficModel {
  const { n, e, offsets, targets, lats, lons } = graph;
  const staticMult = new Float64Array(e);
  for (let i = 0; i < n; i++) {
    const la1 = lats[i]!, lo1 = lons[i]!;
    const end = offsets[i + 1]!;
    for (let ei = offsets[i]!; ei < end; ei++) {
      const j = targets[ei]!;
      const mLat = j >= 0 ? (la1 + lats[j]!) / 2 : la1;
      const mLon = j >= 0 ? (lo1 + lons[j]!) / 2 : lo1;
      const d = haversine(mLat, mLon, CENTER_LAT, CENTER_LON);
      staticMult[ei] = 1 + CENTER_PEAK * Math.exp(-((d / CENTER_SCALE_M) ** 2));
    }
  }
  return { staticMult, td: null };
}

function bump(hour: number, center: number, width: number): number {
  const d = hour - center;
  return Math.exp(-(d * d) / (2 * width * width));
}

// Level-2 time-of-day multiplier. Used in the fallback path (td = null).
// When td is loaded this function is no longer called for weight computation,
// but it remains exported for external consumers (e.g. tests, display code).
export function congestionMultiplier(hour: number, cls: number): number {
  const peak = bump(hour, 7.5, 1.3) + bump(hour, 17.5, 1.8);
  const midday = bump(hour, 13, 2.5);
  const arterial = cls <= ARTERIAL_MAX_CLASS;
  const intensity = arterial
    ? peak * 2.6 + midday * 0.4
    : peak * 0.7 + midday * 0.15;
  return 1 + intensity;
}

// Per-class time-of-day factors (fallback only).
function classFactors(hour: number, trafficOn: boolean): Float64Array {
  const f = new Float64Array(8);
  for (let c = 0; c < 8; c++) f[c] = trafficOn ? congestionMultiplier(hour, c) : 1;
  return f;
}

// Write the live weights straight into `out` (a view over WASM linear memory).
//
// Drive mode — two sub-paths:
//   td non-null → data-driven (traffic.bin): per-edge calibrated multiplier.
//     weight[ei] = len × STRETCH[cls] × mult_from_traffic_bin
//     staticMult and congestionMultiplier are NOT applied: both CBD-spatial and
//     time-of-day effects are already baked into the calibrated multiplier.
//   td null → fallback (synthetic): Level-1 × Level-2 as before.
//     weight[ei] = len × STRETCH[cls] × staticMult[ei] × byClass[cls]
// Walk / bike modes are unchanged: flat stretch, no traffic.
// The A* heuristic (haversine metres) stays admissible: mult ≥ 1 means every
// weight ≥ length ≥ haversine, so the heuristic never overestimates.
export function fillWeights(
  out: Float64Array, graph: Graph, model: TrafficModel,
  hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): void {
  const { e, classes, distances } = graph;
  if (mode === 'walk') {
    for (let i = 0; i < e; i++) out[i] = distances[i]! * WALK_STRETCH;
    return;
  }
  if (mode === 'bike') {
    for (let i = 0; i < e; i++) out[i] = distances[i]! * BIKE_STRETCH;
    return;
  }
  // Drive ──────────────────────────────────────────────────────────────────
  if (!trafficOn) {
    for (let i = 0; i < e; i++) out[i] = distances[i]! * STRETCH[classes[i]!]!;
    return;
  }
  const { td, staticMult } = model;
  if (td) {
    // Data-driven path. Inlined for hot-path performance (avoids per-edge
    // function call and repeated h computation over 1.8 M edges).
    const h = Math.floor(((hour % 24) + 24) % 24);
    const data = td._data, range = td._range;
    for (let i = 0; i < e; i++) {
      out[i] = distances[i]! * STRETCH[classes[i]!]! * (1.0 + (data[i * 24 + h]! / 255) * range);
    }
  } else {
    // Fallback: synthetic Level-1 × Level-2.
    const byClass = classFactors(hour, true);
    for (let i = 0; i < e; i++) {
      out[i] = distances[i]! * STRETCH[classes[i]!]! * staticMult[i]! * byClass[classes[i]!]!;
    }
  }
}

// Σ true metres-equivalent weight along a path (independent of the WASM buffer),
// used to score alternative routes under the live model. Mirrors fillWeights logic.
export function pathWeight(
  graph: Graph, model: TrafficModel, path: Int32Array,
  hour: number, trafficOn: boolean, mode: TravelMode,
): number {
  const { classes, distances } = graph;
  let sum = 0;
  if (mode === 'walk') {
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei >= 0) sum += distances[ei]! * WALK_STRETCH;
    }
    return sum;
  }
  if (mode === 'bike') {
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei >= 0) sum += distances[ei]! * BIKE_STRETCH;
    }
    return sum;
  }
  // Drive
  if (!trafficOn) {
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei >= 0) sum += distances[ei]! * STRETCH[classes[ei]!]!;
    }
    return sum;
  }
  const { td, staticMult } = model;
  if (td) {
    const h = Math.floor(((hour % 24) + 24) % 24);
    const data = td._data, range = td._range;
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei < 0) continue;
      sum += distances[ei]! * STRETCH[classes[ei]!]! * (1.0 + (data[ei * 24 + h]! / 255) * range);
    }
  } else {
    const byClass = classFactors(hour, true);
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei < 0) continue;
      sum += distances[ei]! * STRETCH[classes[ei]!]! * staticMult[ei]! * byClass[classes[ei]!]!;
    }
  }
  return sum;
}

// Congestion multiplier → colour.
// Two-segment gradient matching the panel legend:
//   1.0 → #34a853 (green)  2.0 → #f9ab00 (amber)  ≥3.0 → #ea4335 (red)
export function congestionColor(mult: number): string {
  const x = Math.max(0, Math.min(1, (mult - 1) / 2)); // mult 1..3 → 0..1
  let r: number, g: number, b: number;
  if (x < 0.5) {
    const t = x * 2;                          // green → amber
    r = Math.round(52  + t * (249 - 52));
    g = Math.round(168 + t * (171 - 168));
    b = Math.round(83  + t * (0   - 83));
  } else {
    const t = (x - 0.5) * 2;                  // amber → red
    r = Math.round(249 + t * (234 - 249));
    g = Math.round(171 + t * (67  - 171));
    b = Math.round(0   + t * (53  - 0));
  }
  return `rgb(${r},${g},${b})`;
}

// ETA seconds from a metres-equivalent cost (A* return or pathWeight).
export function etaSeconds(costMetresEquiv: number): number {
  return costMetresEquiv / MAX_SPEED_MPS;
}

export function formatEta(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

// "08:00" from a fractional hour; arrival clock from a departure hour + ETA.
export function formatClock(hour: number): string {
  const total = ((hour % 24) + 24) % 24;
  const hh = Math.floor(total);
  const mm = Math.round((total - hh) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function arrivalClock(departHour: number, seconds: number): string {
  return formatClock(departHour + seconds / 3600);
}

// True road distance of a path, summing per-segment haversine.
export function pathDistanceMeters(graph: Graph, path: Int32Array): number {
  let m = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!, b = path[k]!;
    m += haversine(graph.lats[a]!, graph.lons[a]!, graph.lats[b]!, graph.lons[b]!);
  }
  return m;
}

// Per-segment congestion multiplier along a path, for colouring the route.
// model parameter added to access td; signature otherwise unchanged.
// Walk/bike always return all-1 (no traffic).
export function segmentMultipliers(
  graph: Graph, model: TrafficModel, path: Int32Array,
  hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): Float64Array {
  const out = new Float64Array(Math.max(0, path.length - 1));
  if (mode !== 'drive' || !trafficOn) { out.fill(1); return out; }
  const { classes } = graph;
  const { td } = model;
  if (td) {
    const h = Math.floor(((hour % 24) + 24) % 24);
    const data = td._data, range = td._range;
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      out[k - 1] = ei >= 0 ? 1.0 + (data[ei * 24 + h]! / 255) * range : 1.0;
    }
  } else {
    // Fallback: class-only congestion.
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      const cls = ei >= 0 ? classes[ei]! : 5;
      out[k - 1] = congestionMultiplier(hour, cls);
    }
  }
  return out;
}
