// ============================================================
// SYNTHETIC TRAFFIC DATA LOADERS — SIMULATION ONLY
// ============================================================
// Loads files produced by src/gen-traffic.ts.
// DOM-free: works in browser (fetch) and Node.js (readFile).
//
// Two files, two loaders — use the right one for the job:
//
//   traffic.bin       → loadTrafficData() → getMultiplier()
//     Compact routing file (~43 MB). uint8 multiplier per
//     (edge × hour). Use in the A* weight computation.
//
//   traffic-full.bin  → loadTrafficFull() → getVolumeFull() / getSpeedFull()
//     Full analytics file (~130 MB). uint16 volume + uint8 speed
//     stored directly as generated — no BPR inversion, no loss.
//     Use for inspection, charting, and verification.
//
// ── Integration into fillWeights (zero A* / ETA change) ──────
//
//   const td = loadTrafficData(await fetch('traffic.bin').then(r => r.arrayBuffer()));
//   // Replace the per-edge weight computation in fillWeights():
//   //   was: weight[ei] = (len × STRETCH[cls]) × staticMult[ei] × byClass[cls]
//   //   now:
//   const mult = trafficOn ? getMultiplier(td, ei, hour) : 1;
//   weight[ei] = (len × STRETCH[cls]) × mult;
//
//   getMultiplier() already folds in both spatial (CBD proximity)
//   and temporal (hourly demand curve) effects. Do NOT also apply
//   staticMult from precompute() — that would double-count the
//   CBD spatial factor already present in the demand model.
//   The A* heuristic, ETA formula, and color mapping are unchanged.
// ============================================================

// ── Compact routing file (traffic.bin) ───────────────────────

const MAGIC_ROUTE = 0x43465254; // 'TRFC' as LE int32
const T_HEADER    = 16;         // bytes

// Encoding parameters by version.
// v1: multMax=5.0 (textbook BPR, underpredicted congestion)
// v2: multMax=8.0 (calibrated BPR, α=1.9 β=2, Jakarta arterials)
function multParamsForVersion(v: number): { min: number; max: number; range: number } {
  const max = v >= 2 ? 8.0 : 5.0;
  return { min: 1.0, max, range: max - 1.0 };
}

export type TrafficData = {
  readonly e:       number;
  readonly version: number;
  readonly _data:   Uint8Array;
  readonly _range:  number; // multMax - multMin for decode
};

// Parse an ArrayBuffer from fetch() or readFile().
// Accepts version 1 (legacy) and version 2 (calibrated).
export function loadTrafficData(buf: ArrayBuffer): TrafficData {
  const hdr = new Int32Array(buf, 0, 4);
  if (hdr[0] !== MAGIC_ROUTE) throw new Error('traffic.bin bad magic — re-run gen:traffic');
  const e       = hdr[1]!;
  const version = hdr[2]!;
  if (version < 1) throw new Error(`traffic.bin version ${version} unsupported`);
  const { range } = multParamsForVersion(version);
  const _data = new Uint8Array(buf, T_HEADER, e * 24);
  return { e, version, _data, _range: range };
}

// Congestion multiplier for one edge at one (fractional) hour.
// Returns ≥ 1.0; 1.0 = free-flow, higher = congested.
// Drop-in for congestionMultiplier(hour, cls) — indexed by edge
// for per-edge spatial accuracy rather than class-only.
export function getMultiplier(td: TrafficData, edgeIdx: number, hour: number): number {
  const h = Math.floor(((hour % 24) + 24) % 24);
  return 1.0 + (td._data[edgeIdx * 24 + h]! / 255) * td._range;
}

// Speed from the routing multiplier: speed = freeFlowKmh / mult.
// For authoritative stored speed, use getSpeedFull() instead.
export function getSpeed(
  td: TrafficData, edgeIdx: number, hour: number, freeFlowKmh: number,
): number {
  return freeFlowKmh / getMultiplier(td, edgeIdx, hour);
}

// ── Full analytics file (traffic-full.bin) ────────────────────

const MAGIC_FULL = 0x32465254; // 'TRF2' as LE int32

export type TrafficDataFull = {
  readonly e:        number;
  readonly version:  number;
  readonly _volumes: Uint16Array; // [ei*24+h] veh/h, stored directly
  readonly _speeds:  Uint8Array;  // [ei*24+h] km/h, stored directly
};

// Parse traffic-full.bin. Requires version ≥ 2.
export function loadTrafficFull(buf: ArrayBuffer): TrafficDataFull {
  const hdr = new Int32Array(buf, 0, 4);
  if (hdr[0] !== MAGIC_FULL) throw new Error('traffic-full.bin bad magic — re-run gen:traffic');
  const e       = hdr[1]!;
  const version = hdr[2]!;
  if (version < 2) throw new Error(`traffic-full.bin version ${version} unsupported (need ≥ 2)`);
  const volByteOffset = T_HEADER;
  const spdByteOffset = T_HEADER + e * 24 * 2;
  return {
    e,
    version,
    _volumes: new Uint16Array(buf, volByteOffset, e * 24),
    _speeds:  new Uint8Array(buf, spdByteOffset, e * 24),
  };
}

// Volume (veh/h) for edge ei at hour h — stored directly, no BPR inversion.
export function getVolumeFull(td: TrafficDataFull, edgeIdx: number, hour: number): number {
  const h = Math.floor(((hour % 24) + 24) % 24);
  return td._volumes[edgeIdx * 24 + h]!;
}

// Speed (km/h) for edge ei at hour h — stored directly, no BPR inversion.
export function getSpeedFull(td: TrafficDataFull, edgeIdx: number, hour: number): number {
  const h = Math.floor(((hour % 24) + 24) % 24);
  return td._speeds[edgeIdx * 24 + h]!;
}
