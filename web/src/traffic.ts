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
// Congestion weights are now generated in-browser from the shared BPR model
// (src/lib/traffic-constants.ts), rather than loaded from traffic.bin.
// The Web Worker (traffic-gen.worker.ts) precomputes per-edge geometry factors
// (cbdFactor, edgeDot) once at startup; fillWeights applies the BPR formula
// per query using the current departure hour.
//
// Fallback path (while the worker is still running): the static Level-1
// spatial field (staticMult) × a class-based time-of-day multiplier.

import { cheapestEdge, haversine, type Graph } from './graph.ts';
import { ASSUMPTIONS as A } from '../../src/lib/traffic-constants.ts';

export type TravelMode = 'drive' | 'walk' | 'bike';

// Free-flow driving speed per road class, km/h — imported from shared constants.
const SPEED_KMH = A.freeFlowKmh as unknown as number[];
const MAX_SPEED_KMH = 100; // motorway free-flow; A.freeFlowKmh[0]
export const MAX_SPEED_MPS = (MAX_SPEED_KMH * 1000) / 3600;

// metres-equivalent stretch factor per road class.
const STRETCH = SPEED_KMH.map((s) => MAX_SPEED_KMH / s);

// Non-driving modes: one speed for every road, no traffic sensitivity.
const WALK_KMH = 5;
const BIKE_KMH = 15;
const WALK_STRETCH = MAX_SPEED_KMH / WALK_KMH;
const BIKE_STRETCH = MAX_SPEED_KMH / BIKE_KMH;

// Road capacity (veh/h per direction) per class — derived from ASSUMPTIONS.
const roadCapacity = A.capacityPerLane.map((cap, c) => cap * A.defaultLanes[c]!);

// Jakarta city centre (Monas) — Level-1 fallback spatial field.
// Intentionally simpler than the full BPR model (different σ).
const CENTER_LAT   = -6.1754;
const CENTER_LON   = 106.8272;
const CENTER_PEAK  = 0.6;
const CENTER_SCALE = 6000; // metres; smaller σ than A.cbdScaleM=8000 for tighter fallback

export type TrafficModel = {
  // staticMult[e] — Level-1 CBD spatial factor, ≥1.
  // Used as fallback while the Web Worker is still computing cbdFactor/edgeDot.
  staticMult: Float64Array;
  // cbdFactor[e] — Gaussian CBD demand factor per edge, computed by the worker.
  // Null until the worker posts its result.
  cbdFactor: Float64Array | null;
  // edgeDot[e] — cosine similarity of edge direction vs. toward-CBD vector.
  // Null until the worker posts its result.
  edgeDot: Float64Array | null;
};

// Precompute the static spatial fallback field. Called once at boot before
// the Web Worker result arrives.
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
      staticMult[ei] = 1 + CENTER_PEAK * Math.exp(-((d / CENTER_SCALE) ** 2));
    }
  }
  return { staticMult, cbdFactor: null, edgeDot: null };
}

// ── BPR helpers ───────────────────────────────────────────────

// Deterministic per-(edge, hour) noise — identical to gen-traffic.ts so
// in-browser multipliers match the offline-generated values.
function deterministicNoise(ei: number, h: number): number {
  let s = ((A.noiseSeed * 2654435761 + ei * 40503 + h * 6700417) >>> 0);
  s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
  s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
  s = (s ^ (s >>> 16)) >>> 0;
  return A.noiseAmplitude * (2 * (s / 0x100000000) - 1);
}

// BPR congestion multiplier for a single edge given precomputed geometry factors.
// Uses β=2 so `vc²` is explicit rather than Math.pow for hot-path speed.
function bprEdgeMult(
  cbdFactor: Float64Array, edgeDot: Float64Array,
  ei: number, cls: number, h: number,
): number {
  const cap = roadCapacity[cls]!;
  const dirFactor = 1 + A.directionalBoost * A.amPmShape[h]! * edgeDot[ei]!;
  const rawVol = cap * A.peakDemandRatio[cls]! * A.hourlyDemandCurve[h]! * cbdFactor[ei]! * dirFactor;
  const vol = rawVol * (1 + deterministicNoise(ei, h));
  const vc  = Math.min(vol / cap, 2.0);
  return 1 + A.bprAlpha * vc * vc; // β=2
}

// Fallback Level-2 time-of-day multiplier (class-only, no per-edge geometry).
// Used only when cbdFactor is not yet available.
function bump(hour: number, center: number, width: number): number {
  const d = hour - center;
  return Math.exp(-(d * d) / (2 * width * width));
}

const ARTERIAL_MAX_CLASS = 3;

export function congestionMultiplier(hour: number, cls: number): number {
  const peak = bump(hour, 7.5, 1.3) + bump(hour, 17.5, 1.8);
  const midday = bump(hour, 13, 2.5);
  const arterial = cls <= ARTERIAL_MAX_CLASS;
  const intensity = arterial
    ? peak * 2.6 + midday * 0.4
    : peak * 0.7 + midday * 0.15;
  return 1 + intensity;
}

function classFactors(hour: number, trafficOn: boolean): Float64Array {
  const f = new Float64Array(8);
  for (let c = 0; c < 8; c++) f[c] = trafficOn ? congestionMultiplier(hour, c) : 1;
  return f;
}

// ── Weight computation ────────────────────────────────────────

// Cache key capturing everything fillWeights' output actually depends on: walk/
// bike ignore hour and traffic entirely; drive+trafficOff ignores hour; only
// drive+trafficOn depends on the (floored) hour and whether the BPR worker has
// delivered cbdFactor/edgeDot yet. Keyed per output buffer (there's one router
// weights buffer per graph) so repeated calls with an unchanged key — e.g. every
// requestAnimationFrame while dragging the hour slider in walk mode, or between
// sub-integer hour ticks in drive mode — can skip the O(E) rewrite below.
function weightsKey(model: TrafficModel, hour: number, trafficOn: boolean, mode: TravelMode): string {
  if (mode !== 'drive') return mode;
  if (!trafficOn) return 'drive:off';
  const h = Math.floor(((hour % 24) + 24) % 24);
  return `drive:on:${h}:${model.cbdFactor !== null}`;
}

const lastFillKey = new WeakMap<Float64Array, string>();

// Write the live weights straight into `out` (a view over WASM linear memory).
//
// Drive mode — two sub-paths:
//   cbdFactor non-null → BPR model: per-edge calibrated multiplier computed in-browser.
//     weight[ei] = len × STRETCH[cls] × bprMult(hour, cbdFactor[ei], edgeDot[ei])
//   cbdFactor null → fallback: Level-1 (staticMult) × Level-2 (class-only).
//     weight[ei] = len × STRETCH[cls] × staticMult[ei] × byClass[cls]
// Walk / bike modes are unchanged: flat stretch, no traffic.
export function fillWeights(
  out: Float64Array, graph: Graph, model: TrafficModel,
  hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): void {
  const key = weightsKey(model, hour, trafficOn, mode);
  if (lastFillKey.get(out) === key) return;
  lastFillKey.set(out, key);
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
  const { cbdFactor, edgeDot, staticMult } = model;
  if (cbdFactor && edgeDot) {
    // BPR path: full calibrated model (same as gen-traffic.ts).
    // Hoist hour-constant lookups outside the loop for speed.
    const h         = Math.floor(((hour % 24) + 24) % 24);
    const demand_h  = A.hourlyDemandCurve[h]!;
    const shape_h   = A.amPmShape[h]!;
    const db        = A.directionalBoost;
    const alpha     = A.bprAlpha;
    const noiseAmp  = A.noiseAmplitude;
    const noiseSeed = A.noiseSeed;
    const peakRatio = A.peakDemandRatio;
    for (let i = 0; i < e; i++) {
      const cls       = classes[i]!;
      const cap       = roadCapacity[cls]!;
      const dirFactor = 1 + db * shape_h * edgeDot[i]!;
      const rawVol    = cap * peakRatio[cls]! * demand_h * cbdFactor[i]! * dirFactor;
      // Inline deterministicNoise for hot-path speed (avoids call overhead).
      let s = ((noiseSeed * 2654435761 + i * 40503 + h * 6700417) >>> 0);
      s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
      s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
      s = (s ^ (s >>> 16)) >>> 0;
      const vol  = rawVol * (1 + noiseAmp * (2 * (s / 0x100000000) - 1));
      const vc   = Math.min(vol / cap, 2.0);
      const mult = 1 + alpha * vc * vc; // β=2
      out[i] = distances[i]! * STRETCH[cls]! * mult;
    }
  } else {
    // Fallback: Level-1 × Level-2.
    const byClass = classFactors(hour, true);
    for (let i = 0; i < e; i++) {
      out[i] = distances[i]! * STRETCH[classes[i]!]! * staticMult[i]! * byClass[classes[i]!]!;
    }
  }
}

// Σ true metres-equivalent weight along a path. Mirrors fillWeights logic.
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
  if (!trafficOn) {
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei >= 0) sum += distances[ei]! * STRETCH[classes[ei]!]!;
    }
    return sum;
  }
  const { cbdFactor, edgeDot, staticMult } = model;
  const h = Math.floor(((hour % 24) + 24) % 24);
  if (cbdFactor && edgeDot) {
    for (let k = 1; k < path.length; k++) {
      const ei = cheapestEdge(graph, path[k - 1]!, path[k]!);
      if (ei < 0) continue;
      const mult = bprEdgeMult(cbdFactor, edgeDot, ei, classes[ei]!, h);
      sum += distances[ei]! * STRETCH[classes[ei]!]! * mult;
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

// Congestion multiplier for a single edge — used by buildTrafficOverlay.
export function edgeCongestionMult(
  model: TrafficModel, ei: number, cls: number, hour: number,
): number {
  const h = Math.floor(((hour % 24) + 24) % 24);
  const { cbdFactor, edgeDot, staticMult } = model;
  if (cbdFactor && edgeDot) return bprEdgeMult(cbdFactor, edgeDot, ei, cls, h);
  return staticMult[ei]! * congestionMultiplier(hour, cls);
}

// Congestion multiplier → colour.
export function congestionColor(mult: number): string {
  const x = Math.max(0, Math.min(1, (mult - 1) / 2));
  let r: number, g: number, b: number;
  if (x < 0.5) {
    const t = x * 2;
    r = Math.round(52  + t * (249 - 52));
    g = Math.round(168 + t * (171 - 168));
    b = Math.round(83  + t * (0   - 83));
  } else {
    const t = (x - 0.5) * 2;
    r = Math.round(249 + t * (234 - 249));
    g = Math.round(171 + t * (67  - 171));
    b = Math.round(0   + t * (53  - 0));
  }
  return `rgb(${r},${g},${b})`;
}

// Per-segment congestion multiplier along a path, for colouring the route.
export function segmentMultipliers(
  graph: Graph, model: TrafficModel, path: Int32Array,
  hour: number, trafficOn: boolean, mode: TravelMode = 'drive',
): Float64Array {
  const out = new Float64Array(Math.max(0, path.length - 1));
  if (mode !== 'drive' || !trafficOn) { out.fill(1); return out; }
  const { classes } = graph;
  const { cbdFactor, edgeDot } = model;
  const h = Math.floor(((hour % 24) + 24) % 24);
  if (cbdFactor && edgeDot) {
    for (let k = 1; k < path.length; k++) {
      const ei  = cheapestEdge(graph, path[k - 1]!, path[k]!);
      out[k - 1] = ei >= 0 ? bprEdgeMult(cbdFactor, edgeDot, ei, classes[ei]!, h) : 1;
    }
  } else {
    for (let k = 1; k < path.length; k++) {
      const ei  = cheapestEdge(graph, path[k - 1]!, path[k]!);
      const cls = ei >= 0 ? classes[ei]! : 5;
      out[k - 1] = congestionMultiplier(hour, cls);
    }
  }
  return out;
}

export function modeHScale(mode: TravelMode): number {
  if (mode === 'walk') return WALK_STRETCH;
  if (mode === 'bike') return BIKE_STRETCH;
  return 1.0;
}

export function etaSeconds(costMetresEquiv: number): number {
  return costMetresEquiv / MAX_SPEED_MPS;
}

export function formatEta(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export function formatClock(hour: number): string {
  const total = ((hour % 24) + 24) % 24;
  const hh = Math.floor(total);
  const mm = Math.round((total - hh) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function arrivalClock(departHour: number, seconds: number): string {
  return formatClock(departHour + seconds / 3600);
}

export function pathDistanceMeters(graph: Graph, path: Int32Array): number {
  let m = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!, b = path[k]!;
    m += haversine(graph.lats[a]!, graph.lons[a]!, graph.lats[b]!, graph.lons[b]!);
  }
  return m;
}
