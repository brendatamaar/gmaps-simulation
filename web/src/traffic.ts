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
const CENTER_LAT = -6.1754;
const CENTER_LON = 106.8272;
const CENTER_PEAK = 0.6;     // up to +60% slower in the core (Level 1, static)
const CENTER_SCALE_M = 6000; // gaussian falloff radius

export type TrafficModel = {
  staticMult: Float64Array; // [e] Level-1 spatial congestion, ≥1 (static, drive-only)
};

// Precompute the static spatial-congestion field once (it needs a haversine per
// edge). The per-class speed and time-of-day curve are cheap and applied later.
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
  return { staticMult };
}

function bump(hour: number, center: number, width: number): number {
  const d = hour - center;
  return Math.exp(-(d * d) / (2 * width * width));
}

// Level-2 time-of-day multiplier, ≥1. Deterministic, no data. Arterials clog
// hard at the 7:30/17:30 peaks; locals far less. Overnight ≈ free flow.
export function congestionMultiplier(hour: number, cls: number): number {
  const peak = bump(hour, 7.5, 1.3) + bump(hour, 17.5, 1.8);
  const midday = bump(hour, 13, 2.5);
  const arterial = cls <= ARTERIAL_MAX_CLASS;
  const intensity = arterial
    ? peak * 2.6 + midday * 0.4
    : peak * 0.7 + midday * 0.15;
  return 1 + intensity;
}

// Per-hour congestion factors, one per road class (drive only). Computing the 8
// values once avoids calling the curve per-edge across 1.8M edges.
function classFactors(hour: number, trafficOn: boolean): Float64Array {
  const f = new Float64Array(8);
  for (let c = 0; c < 8; c++) f[c] = trafficOn ? congestionMultiplier(hour, c) : 1;
  return f;
}

// metres-equivalent weight for one edge under a mode. Driving folds in road
// class + congestion; walk/bike are a flat stretch with no traffic.
function edgeWeight(
  len: number, cls: number, sMult: number, byClass: Float64Array,
  trafficOn: boolean, mode: TravelMode,
): number {
  if (mode === 'walk') return len * WALK_STRETCH;
  if (mode === 'bike') return len * BIKE_STRETCH;
  const ff = len * STRETCH[cls]!;
  return trafficOn ? ff * sMult * byClass[cls]! : ff;
}

// Write the live weights straight into `out` (a view over WASM linear memory).
export function fillWeights(
  out: Float64Array, graph: Graph, model: TrafficModel,
  hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): void {
  const { e, classes, distances } = graph;
  const { staticMult } = model;
  const byClass = classFactors(hour, trafficOn);
  for (let i = 0; i < e; i++) {
    out[i] = edgeWeight(distances[i]!, classes[i]!, staticMult[i]!, byClass, trafficOn, mode);
  }
}

// Σ true metres-equivalent weight along a path (independent of the WASM buffer's
// current contents), used to score alternative routes under the live model.
export function pathWeight(
  graph: Graph, model: TrafficModel, path: Int32Array,
  hour: number, trafficOn: boolean, mode: TravelMode,
): number {
  const { classes, distances } = graph;
  const byClass = classFactors(hour, trafficOn);
  let sum = 0;
  for (let k = 1; k < path.length; k++) {
    const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
    if (ei < 0) continue;
    sum += edgeWeight(distances[ei]!, classes[ei]!, model.staticMult[ei]!, byClass, trafficOn, mode);
  }
  return sum;
}

// Congestion multiplier → colour. 1.0 green (free) → ~2 amber → ≥3 red.
export function congestionColor(mult: number): string {
  const x = Math.max(0, Math.min(1, (mult - 1) / 2)); // 1..3 → 0..1
  const r = Math.round(46 + x * (255 - 46));
  const g = Math.round(194 - x * (194 - 59));
  const b = Math.round(126 - x * (126 - 92));
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

// True road distance of a path, summing per-segment haversine (edges are
// straight haversine segments, so this equals Σ length without an edge lookup).
export function pathDistanceMeters(graph: Graph, path: Int32Array): number {
  let m = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!, b = path[k]!;
    m += haversine(graph.lats[a]!, graph.lons[a]!, graph.lats[b]!, graph.lons[b]!);
  }
  return m;
}

// Per-segment congestion multiplier along a path, for colouring the route.
// Only driving is congestion-sensitive; walk/bike return all 1 (free).
export function segmentMultipliers(
  graph: Graph, path: Int32Array, hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): Float64Array {
  const out = new Float64Array(Math.max(0, path.length - 1));
  if (mode !== 'drive' || !trafficOn) { out.fill(1); return out; }
  const { classes } = graph;
  for (let k = 1; k < path.length; k++) {
    const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
    const cls = ei >= 0 ? classes[ei]! : 5; // 5 = residential default
    out[k - 1] = congestionMultiplier(hour, cls);
  }
  return out;
}
