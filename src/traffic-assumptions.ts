// ============================================================
// SYNTHETIC TRAFFIC ASSUMPTIONS — SIMULATION ONLY
// ============================================================
// All parameters that drive src/gen-traffic.ts live here.
// Tune the model by editing this file; no logic changes needed.
//
// Road class index = src/lib/roadclass.ts RoadClass enum value:
//   0 Motorway  1 Trunk  2 Primary   3 Secondary
//   4 Tertiary  5 Residential  6 Unclassified  7 Service

export const ASSUMPTIONS = {
  // ── CBD spatial demand factor ─────────────────────────────
  // Anchors demand density around the Jakarta CBD (Monas).
  // Must stay in sync with web/src/traffic.ts CENTER_LAT/LON.
  cbdLat: -6.1754, // degrees — Monas (national monument)
  cbdLon: 106.8272, // degrees
  cbdScaleM: 8000, // metres — gaussian falloff σ;
  //   boost = cbdDemandBoost × exp(-(d/σ)²)
  //   at d=8 km from CBD, factor ≈ 0.37
  cbdDemandBoost: 0.6, // fractional demand uplift at CBD core;
  //   edge at centre gets ×1.60 baseline demand

  // ── Free-flow speeds, km/h ───────────────────────────────
  // Index = RoadClass. MUST equal web/src/traffic.ts SPEED_KMH.
  // Kept as a literal copy so the generator and ETA model agree.
  freeFlowKmh: [100, 80, 60, 50, 40, 30, 30, 20] as const,
  //             ^0    ^1  ^2  ^3  ^4  ^5  ^6  ^7

  // ── Default lane counts per class ────────────────────────
  // v1 NOTE: the CSR stores no `lanes` OSM tag.
  //   OSM `lanes` exists in PBF raw tags (parser.ts stores all
  //   tags) but build-graph.ts Edge only carries {to,dist,cls,name}.
  //   TODO: add `lanes?: number` to Edge, pull way.tags['lanes'] in
  //   build-graph.ts, propagate through csr.ts and export-graph.ts,
  //   then replace this lookup with per-edge values here.
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
  // motorway: 2200 — controlled access, no at-grade crossings
  // trunk/primary: 1800 — signalised urban arterial class I
  // secondary: 1500 — signalised urban arterial class II
  // tertiary: 1200 — minor signalised or priority junction
  // residential: 800 — local, friction from on-street parking
  // unclassified: 600 — no standard; conservative estimate
  // service: 400 — shared lane, heavy side-friction (ojek, PKL)
  capacityPerLane: [2200, 1800, 1800, 1500, 1200, 800, 600, 400] as const,

  // ── Peak demand ratio ────────────────────────────────────
  // Volume at demand-curve peak = capacity × peakDemandRatio.
  // Keeps most roads below saturation at peak; CBD boost can push
  // nearby edges transiently over capacity (V/C > 1 → gridlock).
  peakDemandRatio: [0.85, 0.8, 0.75, 0.7, 0.5, 0.35, 0.3, 0.2] as const,

  // ── BPR speed-flow parameters ────────────────────────────
  // speed = free_flow / (1 + α × (V/C)^β)
  //
  // COUPLING NOTE: speed is DERIVED from volume here.
  // A "speed layer" built on this output is NOT independent of
  // the volume model. If you later want free-standing speed
  // assumptions (e.g. from GPS probe data), speed must come from
  // its own empirical curve — not from applying BPR to simulated
  // volumes. See web/src/trafficData.ts getSpeed() for context.
  //
  // Calibration note: the textbook BPR uses α=0.15, β=4 (HCM
  // freeway calibration). Those values are flat below V/C≈0.8 and
  // badly underpredict congestion on signalised urban arterials —
  // in the Jakarta verify run they produced avg peak mult 1.009
  // (essentially free-flow city-wide). Jakarta arterials commonly
  // run at V/C 0.8–1.1 and show speeds ~50% below free-flow at
  // peak. α=1.9, β=2 reproduces that behaviour:
  //   V/C 0.7 → ×1.93  (speed ~52% of free-flow)
  //   V/C 0.9 → ×2.54  (speed ~39%)
  //   V/C 1.1 → ×3.30  (speed ~30%)
  // Source calibration: MKJI 1997 speed-flow curves for urban
  // arterials; consistent with Akçelik (1991) urban α≈1.5–2.0.
  // Lower β=2 gives a smoother falloff that avoids the sharp BPR
  // cliff at V/C=1 that is unrealistic for signalised networks.
  bprAlpha: 1.9,
  bprBeta: 2,

  // ── 24-point hourly demand curve ─────────────────────────
  // Index h = hour of day (0 = 00:00, 8 = 08:00, 18 = 18:00).
  // Value = fraction of peak demand (1.00 = demand-curve peak).
  // Shape rationale:
  //   • Dual peaks at 07-08 (AM commute) and 17-18 (PM commute)
  //   • Jakarta AM ≈ PM peak; diverse work-start times flatten AM
  //   • Lunch bump at 12: shorter + smaller than commute peaks
  //   • Overnight trough 02-04: Imsak window slightly lifts 04:00
  //   • Hour 08 is the reference anchor (ratio = 1.0 by convention)
  hourlyDemandCurve: [
    0.08, // 00 — overnight low; mostly long-haul trucks
    0.05, // 01
    0.04, // 02
    0.04, // 03 — trough; speed should be ≈ free-flow
    0.08, // 04 — Subuh prayer + early logistics start
    0.22, // 05 — pre-rush ramp
    0.6, // 06 — school/office ramp-up
    0.9, // 07 — AM peak ramp
    1.0, // 08 — AM peak apex (reference; ratio anchored here)
    0.82, // 09 — post-peak tail
    0.65, // 10
    0.58, // 11
    0.68, // 12 — lunch spike (warung runs, mall trips)
    0.62, // 13
    0.55, // 14 — afternoon trough
    0.58, // 15 — school dismissal
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
  // Real commuter traffic is centripetal in the morning (flows toward
  // CBD) and centrifugal in the evening (flows away from CBD).
  // For each directed edge we compute a signed dot product:
  //   dot ∈ [−1, +1]  where +1 = points directly toward CBD
  //                         −1 = points directly away from CBD
  // Then demand is modulated by:
  //   dirFactor = 1 + directionalBoost × amPmShape[h] × dot
  // so at AM peak (amPmShape > 0):  inbound edges (dot > 0) get boosted,
  //                                 outbound edges (dot < 0) are suppressed.
  // At PM peak (amPmShape < 0) the effect inverts.
  // Perpendicular or off-peak edges (dot≈0 or shape≈0) are unaffected.
  directionalBoost: 0.45, // ±45% swing between inbound and outbound at peak
  amPmShape: [
     0.00, // 00 — overnight: no directional bias
     0.00, // 01
     0.00, // 02
     0.00, // 03
     0.00, // 04
     0.10, // 05 — early inbound ramp
     0.45, // 06 — inbound growing
     0.80, // 07 — strong inbound
     1.00, // 08 — AM peak: max inbound bias
     0.70, // 09 — inbound fading
     0.25, // 10
     0.05, // 11
     0.00, // 12 — midday: no directional bias
     0.00, // 13
    -0.10, // 14 — outbound starts
    -0.35, // 15 — school dismissal, outbound building
    -0.65, // 16 — PM ramp
    -0.85, // 17 — strong outbound
    -1.00, // 18 — PM peak: max outbound bias
    -0.70, // 19 — outbound fading
    -0.25, // 20
    -0.05, // 21
     0.00, // 22
     0.00, // 23
  ] as const,

  // ── Noise ────────────────────────────────────────────────
  // Per-(edge, hour) deterministic noise breaks the "all roads of
  // the same class look identical" texture. Stateless hash —
  // no RNG state carried across edges, so order-independent.
  noiseSeed: 42, // change for a different-but-valid realisation
  noiseAmplitude: 0.06, // ±6% of computed volume

  // ── traffic.bin encoding ─────────────────────────────────
  // One uint8 per (edge × hour). Encodes the congestion multiplier.
  //   encoded = clamp(round((mult − multMin) / (multMax − multMin) × 255), 0, 255)
  //   decoded = multMin + (byte / 255) × (multMax − multMin)
  //   resolution ≈ (multMax − multMin) / 255 ≈ 0.027 per step
  // multMax raised from 5.0 → 8.0 to avoid clipping the tails of
  // the calibrated BPR: at V/C=2 α=1.9 β=2 gives mult≈8.6, which
  // was previously clipped to 5.0.
  multMin: 1.0, // free-flow = 1.0× (no congestion)
  multMax: 8.0, // 8× slower than free-flow = extreme gridlock
} as const;

export type Assumptions = typeof ASSUMPTIONS;
