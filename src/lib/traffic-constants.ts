// ============================================================
// SHARED TRAFFIC CONSTANTS — imported by Node generator and browser.
// ============================================================
// All parameters that drive the BPR traffic model live here.
// Tune the model by editing this file; no logic changes needed.
//
// Road class index = src/lib/roadclass.ts RoadClass enum value:
//   0 Motorway  1 Trunk  2 Primary   3 Secondary
//   4 Tertiary  5 Residential  6 Unclassified  7 Service

export const ASSUMPTIONS = {
  // ── CBD spatial demand factor ─────────────────────────────
  // Anchors demand density around the Jakarta CBD (Monas).
  cbdLat: -6.1754, // degrees — Monas (national monument)
  cbdLon: 106.8272, // degrees
  cbdScaleM: 8000, // metres — gaussian falloff σ;
  //   boost = cbdDemandBoost × exp(-(d/σ)²)
  //   at d=8 km from CBD, factor ≈ 0.37
  cbdDemandBoost: 0.6, // fractional demand uplift at CBD core;
  //   edge at centre gets ×1.60 baseline demand

  // ── Free-flow speeds, km/h ───────────────────────────────
  // Index = RoadClass. Must equal web/src/traffic.ts SPEED_KMH.
  freeFlowKmh: [100, 80, 60, 50, 40, 30, 30, 20] as const,
  //             ^0    ^1  ^2  ^3  ^4  ^5  ^6  ^7

  // ── Default lane counts per class ────────────────────────
  // Each value = lanes in ONE direction (CSR edge = one direction).
  // Source: typical Jakarta road widths from field observation.
  defaultLanes: [3, 2, 2, 2, 1, 1, 1, 1] as const,
  //              ^0 motorway:      3 lanes/dir (Tol Dalam Kota, JORR)
  //                 ^1 trunk:      2 lanes/dir
  //                    ^2 primary: 2 lanes/dir (Sudirman, Gatot Subroto)
  //                       ^3 sec:  2 lanes/dir
  //                          ^4 tertiary:     1 lane/dir
  //                             ^5 resident.: 1 lane/dir
  //                                ^6 unclass: 1 lane/dir
  //                                   ^7 service: 1 lane (shared)

  // ── Capacity per lane, veh/h ─────────────────────────────
  // Source: HCM 6th Ed. (2016) adjusted for Indonesian roads per
  // MKJI (Manual Kapasitas Jalan Indonesia, 1997).
  capacityPerLane: [2200, 1800, 1800, 1500, 1200, 800, 600, 400] as const,

  // ── Peak demand ratio ────────────────────────────────────
  // Volume at demand-curve peak = capacity × peakDemandRatio.
  peakDemandRatio: [0.85, 0.8, 0.75, 0.7, 0.5, 0.35, 0.3, 0.2] as const,

  // ── BPR speed-flow parameters ────────────────────────────
  // speed = free_flow / (1 + α × (V/C)^β)
  // Calibrated for Jakarta urban arterials: α=1.9, β=2.
  // Source: MKJI 1997; α≈1.5–2.0.
  bprAlpha: 1.9,
  bprBeta: 2,

  // ── 24-point hourly demand curve ─────────────────────────
  // Index h = hour of day (0 = 00:00, 8 = 08:00, 18 = 18:00).
  // Value = fraction of peak demand (1.00 = demand-curve peak).
  hourlyDemandCurve: [
    0.08, // 00 — overnight low; mostly long-haul trucks
    0.05, // 01
    0.04, // 02
    0.04, // 03 — trough; speed should be ≈ free-flow
    0.08, // 04 — Early logistics start
    0.22, // 05 — pre-rush ramp
    0.6, // 06 — school/office ramp-up
    0.9, // 07 — AM peak ramp
    1.0, // 08 — AM peak apex (reference; ratio anchored here)
    0.82, // 09 — post-peak tail
    0.65, // 10
    0.58, // 11
    0.68, // 12 — lunch spike
    0.62, // 13
    0.55, // 14 — afternoon trough
    0.58, // 15 — school/office dismissal
    0.72, // 16 — PM ramp-up
    0.95, // 17 — PM peak
    1.0, // 18 — PM peak apex (equal to AM for Jakarta)
    0.83, // 19
    0.6, // 20
    0.42, // 21
    0.25, // 22
    0.15, // 23
  ] as const,

  // ── Directional demand (AM inbound / PM outbound) ────────
  // dirFactor = 1 + directionalBoost × amPmShape[h] × dot
  // dot ∈ [−1, +1]: +1 = points toward CBD, −1 = away from CBD.
  directionalBoost: 0.45,
  amPmShape: [
    0.0, // 00 — overnight: no directional bias
    0.0, // 01
    0.0, // 02
    0.0, // 03
    0.0, // 04
    0.1, // 05 — early inbound ramp
    0.45, // 06 — inbound growing
    0.8, // 07 — strong inbound
    1.0, // 08 — AM peak: max inbound bias
    0.7, // 09 — inbound fading
    0.25, // 10
    0.05, // 11
    0.0, // 12 — midday: no directional bias
    0.0, // 13
    -0.1, // 14 — outbound starts
    -0.35, // 15 — school dismissal, outbound building
    -0.65, // 16 — PM ramp
    -0.85, // 17 — strong outbound
    -1.0, // 18 — PM peak: max outbound bias
    -0.7, // 19 — outbound fading
    -0.25, // 20
    -0.05, // 21
    0.0, // 22
    0.0, // 23
  ] as const,

  // ── Noise ────────────────────────────────────────────────
  // Per-(edge, hour) deterministic noise breaks the "all roads of
  // the same class look identical" texture. Stateless hash —
  // no RNG state carried across edges, so order-independent.
  noiseSeed: 42,
  noiseAmplitude: 0.06, // ±6% of computed volume

  // ── traffic.bin encoding (offline generation only) ───────
  // uint8 per (edge × hour). No longer used in the browser
  // after Workstream B; kept for offline verification only.
  multMin: 1.0,
  multMax: 8.0,
} as const;

export type Assumptions = typeof ASSUMPTIONS;
