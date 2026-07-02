// ============================================================
// SYNTHETIC TRAFFIC DATA GENERATOR — SIMULATION ONLY
// ============================================================
// Output is NOT real measurement. It is a plausible simulation
// grounded in road class, calibrated BPR speed-flow theory, and
// assumed Jakarta demand patterns. All parameters live in
// src/traffic-assumptions.ts.
//
// Reads:  web/public/graph.bin  (version ≥ 2; run export:graph first)
// Writes: web/public/traffic-full.bin  — volume + speed, for analytics
//         web/public/traffic.bin       — multiplier only, for the router
//
// ── traffic-full.bin layout (all little-endian) ───────────────
//   [0]   magic    i32  = 0x32465254  ('T','R','F','2')
//   [4]   e        i32  edge count
//   [8]   version  i32  = 2
//   [12]  reserved i32  = 0
//   [16 .. 16+e*24*2-1]
//         volume[ei*24+h]  uint16  veh/h, rounded, clamped 0..65535
//         SOURCE OF TRUTH for volume; stored directly, no BPR inversion.
//   [16+e*24*2 .. 16+e*24*3-1]
//         speed[ei*24+h]   uint8   km/h, rounded, floored at 1
//         Stored directly; also derivable as freeFlow/mult.
//   Total ≈ 16 + e×72 bytes  (~130 MB for 1.8 M edges)
//
// ── traffic.bin layout (all little-endian) ────────────────────
//   [0]   magic    i32  = 0x43465254  ('T','R','F','C')
//   [4]   e        i32  edge count
//   [8]   version  i32  = 2
//   [12]  reserved i32  = 0
//   [16 .. 16+e*24-1]
//         mult[ei*24+h]  uint8  encoded congestion multiplier
//         encode: byte = clamp(round((mult−1)/(8−1)×255), 0, 255)
//         decode: mult = 1.0 + (byte/255) × 7.0
//         version 1 used multMax=5; version 2 uses multMax=8.
//   Total ≈ 16 + e×24 bytes  (~43 MB for 1.8 M edges)
//
// Run: pnpm gen:traffic
// ============================================================

import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ASSUMPTIONS as A } from './lib/traffic-constants.ts';
import { haversine } from './lib/geo.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB     = path.join(__dirname, '../web/public');   // read-only: graph.bin
const GEN_OUT = path.join(__dirname, '../gen-out');      // write: analytics + traffic bins

// Deterministic per-(edge, hour) noise in [−noiseAmplitude, +noiseAmplitude].
// Stateless multiplicative hash — same inputs always produce the same output.
function deterministicNoise(ei: number, h: number): number {
  let s = ((A.noiseSeed * 2654435761 + ei * 40503 + h * 6700417) >>> 0);
  s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
  s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0);
  s = (s ^ (s >>> 16)) >>> 0;
  return A.noiseAmplitude * (2 * (s / 0x100000000) - 1); // [−amp, +amp]
}

// Calibrated BPR multiplier: mult = 1 + α*(V/C)^β.
// α=1.9, β=2 are calibrated for Jakarta urban arterials; see
// traffic-assumptions.ts for the textbook-vs-calibrated discussion.
function bprMult(vc: number): number {
  return 1 + A.bprAlpha * vc ** A.bprBeta;
}

// Encode multiplier into a uint8 for the routing file.
// Range [multMin=1.0, multMax=8.0] → [0, 255].
// Version 2 of traffic.bin uses multMax=8.0 (raised from 5.0 in v1).
const MULT_RANGE = A.multMax - A.multMin; // 7.0 for v2
function encodeMult(mult: number): number {
  const clamped = Math.max(A.multMin, Math.min(A.multMax, mult));
  return Math.round((clamped - A.multMin) / MULT_RANGE * 255);
}

// ── Read graph.bin ───────────────────────────────────────────

console.log('Reading graph.bin...');
const rawBuf = await readFile(path.join(PUB, 'graph.bin')).catch(() => {
  throw new Error('graph.bin not found — run pnpm export:graph first');
});
const ab = rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength);

const hdr = new Int32Array(ab, 0, 4);
if (hdr[0] !== 0x47524150) throw new Error('bad magic — run pnpm export:graph first');
const n = hdr[1]!, e = hdr[2]!, gVersion = hdr[3]!;
if (gVersion < 2) throw new Error('graph.bin too old — need version ≥ 2 (run pnpm export:graph)');

const G_HEADER   = 16;
const offTargets = G_HEADER + 4 * (n + 1);
const offDist    = Math.ceil((offTargets + 4 * e) / 8) * 8;
const offLats    = offDist + 8 * e;
const offLons    = offLats + 8 * n;
const offClasses = offLons + 8 * n;

const offsets = new Int32Array(ab, G_HEADER, n + 1);
const targets = new Int32Array(ab, offTargets, e);
const lats    = new Float64Array(ab, offLats, n);
const lons    = new Float64Array(ab, offLons, n);
const classes = new Uint8Array(ab, offClasses, e);

console.log(`  ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges, graph.bin v${gVersion}`);

// ── Allocate output buffers ───────────────────────────────────

const T_HEADER = 16; // bytes, same for both files

// traffic-full.bin: 16B header + uint16 volumes + uint8 speeds
const volSection = e * 24 * 2; // uint16 — 2 bytes each
const spdSection = e * 24 * 1; // uint8  — 1 byte each
const fullAb = new ArrayBuffer(T_HEADER + volSection + spdSection);

const fullHdr = new Int32Array(fullAb, 0, 4);
fullHdr[0] = 0x32465254; // 'TRF2': bytes T,R,F,2 in memory on LE
fullHdr[1] = e;
fullHdr[2] = 2; // version
fullHdr[3] = 0; // reserved

const volData = new Uint16Array(fullAb, T_HEADER, e * 24);
const spdData = new Uint8Array(fullAb, T_HEADER + volSection, e * 24);

// traffic.bin: 16B header + uint8 multipliers
const routeAb = new ArrayBuffer(T_HEADER + e * 24);

const routeHdr = new Int32Array(routeAb, 0, 4);
routeHdr[0] = 0x43465254; // 'TRFC'
routeHdr[1] = e;
routeHdr[2] = 2; // version — multMax changed from 5 (v1) to 8 (v2)
routeHdr[3] = 0;

const multData = new Uint8Array(routeAb, T_HEADER, e * 24);

// ── Per-class constants (hoisted for speed) ───────────────────

// roadCapacity[cls] = veh/h per direction (one CSR edge = one direction).
const roadCapacity = new Float64Array(8);
for (let c = 0; c < 8; c++) {
  roadCapacity[c] = A.capacityPerLane[c] * A.defaultLanes[c];
}

// ── Generate ──────────────────────────────────────────────────
//
// Per-edge per-hour pipeline (for edge ei at hour h):
//
//   1. Volume (veh/h):
//        V = roadCapacity[cls]
//            × peakDemandRatio[cls]   ← class max utilisation
//            × hourlyDemandCurve[h]   ← 24-pt temporal shape
//            × cbdFactor              ← spatial demand (Gaussian on dist to CBD)
//            × dirFactor              ← directional AM/PM bias  ← NEW
//            × (1 + noise)            ← ±6% seeded noise
//
//      cbdFactor  = 1 + cbdDemandBoost × exp(−(d/cbdScaleM)²)
//      dirFactor  = 1 + directionalBoost × amPmShape[h] × dot
//        dot      = cosine similarity of edge direction vs. toward-CBD vector
//                   (+1 = points at CBD, −1 = points away, 0 = perpendicular)
//        amPmShape[h] > 0 at AM peak → inbound edges boosted, outbound cut
//        amPmShape[h] < 0 at PM peak → outbound edges boosted, inbound cut
//
//   2. V/C ratio: vc = clamp(V / roadCapacity[cls], 0, 2.0)
//
//   3. Congestion multiplier (calibrated BPR):
//        mult = 1 + α*(V/C)^β   where α=1.9, β=2
//      Speed = freeFlowKmh[cls] / mult
//
//   4. Write to traffic-full.bin: volume→uint16, speed→uint8
//      Write to traffic.bin:      encodeMult(mult)→uint8
//
// ⚠️ COUPLING NOTE: speed is derived from volume here.
// Oneway handling: CSR already bakes directionality.

console.log(`Generating ${e.toLocaleString()} edges × 24 hours...`);
const t0 = performance.now();

for (let i = 0; i < n; i++) {
  const srcLat = lats[i]!;
  const srcLon = lons[i]!;
  const end = offsets[i + 1]!;

  for (let ei = offsets[i]!; ei < end; ei++) {
    const j = targets[ei]!;
    // Edge midpoint; fall back to source node when target is outside bbox.
    const midLat = j >= 0 ? (srcLat + lats[j]!) / 2 : srcLat;
    const midLon = j >= 0 ? (srcLon + lons[j]!) / 2 : srcLon;

    const cbdDist   = haversine(midLat, midLon, A.cbdLat, A.cbdLon);
    const cbdFactor = 1 + A.cbdDemandBoost * Math.exp(-((cbdDist / A.cbdScaleM) ** 2));

    // ── Directional dot product (computed once per edge) ────────
    // Projects the edge direction onto the toward-CBD unit vector.
    // cos-correct longitude so degree distances are isotropic.
    // dot > 0 → edge points toward CBD (inbound)
    // dot < 0 → edge points away from CBD (outbound)
    let dot = 0;
    if (j >= 0) {
      const cosLat = Math.cos((midLat * Math.PI) / 180);
      const ex = (lons[j]! - srcLon) * cosLat; // edge Δlon (cos-corrected)
      const ey = lats[j]! - srcLat;             // edge Δlat
      const cx = (A.cbdLon - midLon) * cosLat;  // toward-CBD Δlon
      const cy = A.cbdLat - midLat;              // toward-CBD Δlat
      const eMag = Math.sqrt(ex * ex + ey * ey);
      const cMag = Math.sqrt(cx * cx + cy * cy);
      if (eMag > 0 && cMag > 0) dot = (ex * cx + ey * cy) / (eMag * cMag);
    }

    const cls      = classes[ei]!;
    const cap      = roadCapacity[cls]!;
    const ff       = A.freeFlowKmh[cls]!;
    const peakBase = cap * A.peakDemandRatio[cls];

    const base = ei * 24;
    for (let h = 0; h < 24; h++) {
      // dirFactor: boosts inbound edges at AM peak, outbound at PM peak.
      // 1 + boost × shape[h] × dot is always positive: boost=0.45, |shape|≤1, |dot|≤1
      // → factor ∈ [0.55, 1.45]. No rawVol can go negative from this alone.
      const dirFactor = 1 + A.directionalBoost * A.amPmShape[h] * dot;
      const rawVol = peakBase * A.hourlyDemandCurve[h] * cbdFactor * dirFactor;
      const volume = Math.max(0, rawVol * (1 + deterministicNoise(ei, h)));

      // V/C capped at 2.0 so BPR stays finite; at vc=2 mult≈8.6.
      const vc   = Math.min(volume / cap, 2.0);
      const mult = bprMult(vc);
      const spd  = ff / mult;

      // traffic-full.bin: authoritative volume + speed.
      volData[base + h] = Math.max(0, Math.min(65535, Math.round(volume)));
      spdData[base + h] = Math.max(1, Math.min(255, Math.round(spd)));

      // traffic.bin: encoded multiplier for the router.
      multData[base + h] = encodeMult(mult);
    }
  }

  if (i > 0 && i % 200_000 === 0) {
    const pct = ((i / n) * 100).toFixed(0);
    process.stdout.write(`\r  node ${i.toLocaleString()} / ${n.toLocaleString()} (${pct}%)`);
  }
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
process.stdout.write(`\r  Done in ${elapsed}s.                     \n`);

// ── Write outputs ─────────────────────────────────────────────
// Both files go to gen-out/ (gitignored).
// traffic-full.bin: analytics only — never shipped to the browser.
// traffic.bin:      offline verification only — browser now generates
//                   congestion multipliers in-browser via BPR model.

fs.mkdirSync(GEN_OUT, { recursive: true });

const fullPath  = path.join(GEN_OUT, 'traffic-full.bin');
const routePath = path.join(GEN_OUT, 'traffic.bin');
fs.writeFileSync(fullPath,  Buffer.from(fullAb));
fs.writeFileSync(routePath, Buffer.from(routeAb));

const fullMB  = (T_HEADER + volSection + spdSection) / 1e6;
const routeMB = (T_HEADER + e * 24) / 1e6;

console.log(`\nWrote traffic-full.bin → ${fullPath}`);
console.log(`  Size:    ${fullMB.toFixed(1)} MB  (uint16 volume + uint8 speed, e×24 each)`);
console.log(`  Layout:  header[16] | volume[e×24×2] | speed[e×24×1]`);
console.log(`\nWrote traffic.bin → ${routePath}`);
console.log(`  Size:    ${routeMB.toFixed(1)} MB  (uint8 mult per edge×hour)`);
console.log(`  Version: 2  multMin=${A.multMin} multMax=${A.multMax} range=${MULT_RANGE.toFixed(1)}`);
console.log(`  Calibration: α=${A.bprAlpha} β=${A.bprBeta} (was textbook 0.15/4)`);
console.log(`\nNext: pnpm verify:traffic-data`);
