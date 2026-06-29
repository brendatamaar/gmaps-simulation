// ============================================================
// TRAFFIC DATA VALIDATION — SIMULATION ONLY
// ============================================================
// Loads graph.bin + traffic-full.bin + traffic.bin and checks:
//   • Corridor tables (Sudirman, TB Simatupang, HR Rasuna Said)
//     Volume and speed come from traffic-full.bin directly —
//     no BPR inversion, no quantization loss.
//   • Magnitude assertions (new): congestion is now real, not
//     textbook-BPR-flat. The calibrated α=1.9 β=2 model must
//     produce multi-fold slowdowns at peak.
//   • Bound/monotonic assertions (kept from v1).
//
// Run: pnpm verify:traffic-data
// ============================================================

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ASSUMPTIONS as A } from './traffic-assumptions.ts';
import {
  loadTrafficData, getMultiplier,
  loadTrafficFull, getVolumeFull, getSpeedFull,
} from '../web/src/trafficData.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');

// ── Load graph.bin ────────────────────────────────────────────

const rawG = await readFile(path.join(PUB, 'graph.bin')).catch(() => {
  throw new Error('graph.bin not found — run pnpm export:graph first');
});
const ab = rawG.buffer.slice(rawG.byteOffset, rawG.byteOffset + rawG.byteLength);
const gHdr = new Int32Array(ab, 0, 4);
if (gHdr[0] !== 0x47524150) throw new Error('bad graph.bin magic');
const n = gHdr[1]!, e = gHdr[2]!, gVersion = gHdr[3]!;
if (gVersion < 2) throw new Error('graph.bin too old — re-run pnpm export:graph');

const G_HDR   = 16;
const offTgt  = G_HDR + 4 * (n + 1);
const offDist = Math.ceil((offTgt + 4 * e) / 8) * 8;
const offLats = offDist + 8 * e;
const offLons = offLats + 8 * n;
const offCls  = offLons + 8 * n;
const offNId  = Math.ceil((offCls + e) / 4) * 4;

const classes = new Uint8Array(ab, offCls, e);
const nameIds = new Uint32Array(ab, offNId, e);
const names   = JSON.parse(await readFile(path.join(PUB, 'names.json'), 'utf8')) as string[];

console.log(`graph.bin v${gVersion}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges, ${names.length.toLocaleString()} names`);

// ── Load traffic-full.bin (volume + speed, authoritative) ─────

const rawF = await readFile(path.join(PUB, 'traffic-full.bin')).catch(() => {
  throw new Error('traffic-full.bin not found — run pnpm gen:traffic first');
});
const fbuf = rawF.buffer.slice(rawF.byteOffset, rawF.byteOffset + rawF.byteLength);
const tdFull = loadTrafficFull(fbuf);
if (tdFull.e !== e) throw new Error(`traffic-full.bin e=${tdFull.e} ≠ graph.bin e=${e}`);
console.log(`traffic-full.bin v${tdFull.version}: ${tdFull.e.toLocaleString()} edges × 24 h`);

// ── Load traffic.bin (routing multipliers) ────────────────────

const rawT = await readFile(path.join(PUB, 'traffic.bin')).catch(() => {
  throw new Error('traffic.bin not found — run pnpm gen:traffic first');
});
const tbuf = rawT.buffer.slice(rawT.byteOffset, rawT.byteOffset + rawT.byteLength);
const tdRoute = loadTrafficData(tbuf);
if (tdRoute.e !== e) throw new Error(`traffic.bin e=${tdRoute.e} ≠ graph.bin e=${e}`);
console.log(`traffic.bin v${tdRoute.version}: ${tdRoute.e.toLocaleString()} edges × 24 h\n`);

// ── Helpers ───────────────────────────────────────────────────

function pad(s: string | number, w: number, right = false): string {
  const t = String(s);
  return right ? t.padEnd(w) : t.padStart(w);
}

function capacityFor(cls: number): number {
  return A.capacityPerLane[cls]! * A.defaultLanes[cls]!;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

// ── Corridor definitions ──────────────────────────────────────

const CORRIDORS = [
  { label: 'Jl. Sudirman',       search: 'sudirman'    },
  { label: 'TB Simatupang',      search: 'simatupang'  },
  { label: 'Jl. HR Rasuna Said', search: 'rasuna said' },
];
const CHECK_HOURS = [3, 7, 13, 17, 22];

function findNameIds(search: string): Set<number> {
  const matched = new Set<number>();
  const lower = search.toLowerCase();
  for (let id = 0; id < names.length; id++) {
    if (names[id]!.toLowerCase().includes(lower)) matched.add(id);
  }
  return matched;
}

function findEdges(nameIdSet: Set<number>): number[] {
  const out: number[] = [];
  for (let ei = 0; ei < e; ei++) {
    if (nameIdSet.has(nameIds[ei]!)) out.push(ei);
  }
  return out;
}

// ── Corridor tables ───────────────────────────────────────────

// Collect corridor edges for assertion use.
const corridorArterialEdges: number[] = [];

for (const corridor of CORRIDORS) {
  const nameIdSet = findNameIds(corridor.search);
  const edgeList  = findEdges(nameIdSet);

  if (edgeList.length === 0) {
    console.log(`── ${corridor.label} ── (no edges found — name not in graph)\n`);
    continue;
  }

  // Collect arterial corridor edges for magnitude assertions.
  for (const ei of edgeList) {
    if (classes[ei]! <= 3) corridorArterialEdges.push(ei);
  }

  const step   = Math.max(1, Math.floor(edgeList.length / 6));
  const sample = edgeList.filter((_, i) => i % step === 0).slice(0, 6);

  console.log(`── ${corridor.label} (${edgeList.length} edges, showing ${sample.length}) ──`);
  console.log(
    pad('Edge', 8) + pad('Class', 7) + pad('Cap(veh/h)', 12) +
    CHECK_HOURS.map(h => pad(`${String(h).padStart(2,'0')}:00`, 26)).join(''),
  );
  console.log(pad('', 27) + CHECK_HOURS.map(() => pad('Vol   V/C  Spd(km/h)', 26)).join(''));

  for (const ei of sample) {
    const cls     = classes[ei]!;
    const cap     = capacityFor(cls);
    const ff      = A.freeFlowKmh[cls]!;
    const clsName = ['Mway','Trunk','Prim','Sec','Tert','Res','Unc','Svc'][cls] ?? '?';

    const cells = CHECK_HOURS.map(h => {
      // Volume and speed come directly from traffic-full.bin — no inversion.
      const vol = getVolumeFull(tdFull, ei, h);
      const spd = getSpeedFull(tdFull, ei, h);
      const vc  = vol / cap;
      return `${pad(vol, 5)} ${pad(vc.toFixed(2), 5)} ${pad(spd.toFixed(1), 9)}`;
    });

    console.log(pad(ei, 8) + pad(clsName, 7) + pad(Math.round(cap), 12) +
      cells.map(c => pad(c, 26)).join(''));
  }
  console.log();
}

// ── Assertions ────────────────────────────────────────────────

let passCount = 0, failCount = 0;
const ok = (pass: boolean, msg: string) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
  pass ? passCount++ : failCount++;
};

console.log('── Assertions ──────────────────────────────────────────────');

// ── Bound / monotonic checks (kept from v1) ───────────────────

let volNonNeg = true, spdBound = true, overnightFF = true,
    spdFallsAtPeak = true, peakVolHigher = true;

for (const ei of corridorArterialEdges) {
  const cls = classes[ei]!;
  const ff  = A.freeFlowKmh[cls]!;
  const cap = capacityFor(cls);

  const spd3  = getSpeedFull(tdFull, ei, 3);
  const spd7  = getSpeedFull(tdFull, ei, 7);
  const vol3  = getVolumeFull(tdFull, ei, 3);
  const vol8  = getVolumeFull(tdFull, ei, 8);

  if (vol3 < 0 || vol8 < 0) volNonNeg = false;
  if (spd3 > ff + 1 || spd7 > ff + 1) spdBound = false;
  if (spd3 < ff * 0.85) overnightFF = false;
  if (spd7 >= spd3) spdFallsAtPeak = false;
  if (vol8 < vol3) peakVolHigher = false;
  void cap; // used via vc in table above
}

ok(volNonNeg,     'volume ≥ 0 for all corridor arterial edges');
ok(spdBound,      'speed never exceeds free-flow (corridor arterials)');
ok(overnightFF,   'speed[03:00] ≥ 85% of free-flow (overnight near free-flow)');
ok(spdFallsAtPeak,'speed[07:00] < speed[03:00] on arterials — congestion visible');
ok(peakVolHigher, 'volume[08:00] > volume[03:00] — demand curve peaks AM');

// Global bound check: sample every ~1000 edges.
const STEP = Math.max(1, Math.floor(e / 1000));
let globalSpdFail = false;
for (let ei = 0; ei < e; ei += STEP) {
  const ff = A.freeFlowKmh[classes[ei]!]!;
  for (let h = 0; h < 24; h++) {
    const spd = getSpeedFull(tdFull, ei, h);
    if (spd > ff + 1 || spd < 1) { globalSpdFail = true; break; }
  }
  if (globalSpdFail) break;
}
ok(!globalSpdFail, 'speed ∈ [1, freeFlow+1] for 1000-edge global sample');

// ── Magnitude checks (new) — congestion must be REAL ─────────

// Median multiplier of corridor arterials at AM peak (h=8).
// mult = freeFlow / speed (derived from stored speed, no BPR inversion).
const corridorPeakMults = corridorArterialEdges.map(ei => {
  const ff  = A.freeFlowKmh[classes[ei]!]!;
  const spd = getSpeedFull(tdFull, ei, 8);
  return ff / spd;
});
const medianArterialMult = median(corridorPeakMults);
ok(
  medianArterialMult >= 1.8,
  `arterial (cls≤3) median peak mult ≥ 1.8  (got ${medianArterialMult.toFixed(3)})`,
);

// Citywide average peak multiplier across the global sample.
const globalPeakMults: number[] = [];
for (let ei = 0; ei < e; ei += STEP) {
  const ff  = A.freeFlowKmh[classes[ei]!]!;
  const spd = getSpeedFull(tdFull, ei, 8);
  globalPeakMults.push(ff / spd);
}
const avgGlobalMult = globalPeakMults.reduce((s, x) => s + x, 0) / globalPeakMults.length;
ok(
  avgGlobalMult >= 1.3,
  `citywide avg peak mult ≥ 1.3  (got ${avgGlobalMult.toFixed(3)})`,
);

// At least some edges reach ≥ 3.0 (gridlock exists).
const maxGlobalMult = Math.max(...globalPeakMults);
ok(
  maxGlobalMult >= 3.0,
  `some edges reach mult ≥ 3.0 (gridlock exists)  (max got ${maxGlobalMult.toFixed(3)})`,
);

// Near-CBD arterial peak speed ≤ 60% of free-flow.
// Sudirman corridor edges serve as the near-CBD arterial proxy.
const sudirmanEdges = findEdges(findNameIds('sudirman')).filter(ei => classes[ei]! <= 3);
const sudirmanPeakSpeedRatios = sudirmanEdges.map(ei => {
  const ff  = A.freeFlowKmh[classes[ei]!]!;
  const spd = getSpeedFull(tdFull, ei, 8);
  return spd / ff;
});
const medianSudirmanRatio = median(sudirmanPeakSpeedRatios);
ok(
  medianSudirmanRatio <= 0.6,
  `Sudirman peak speed ≤ 60% of free-flow  (got ${(medianSudirmanRatio * 100).toFixed(1)}%)`,
);

// Routing traffic.bin consistency: routing multiplier should be in range.
const routingMults: number[] = [];
for (let ei = 0; ei < e; ei += STEP) {
  routingMults.push(getMultiplier(tdRoute, ei, 8));
}
const minRouteMult = Math.min(...routingMults);
const maxRouteMult = Math.max(...routingMults);
ok(
  minRouteMult >= 1.0 && maxRouteMult <= A.multMax + 0.05,
  `routing traffic.bin multipliers ∈ [1.0, ${A.multMax}]  (got [${minRouteMult.toFixed(2)}, ${maxRouteMult.toFixed(2)}])`,
);

// ── Summary ───────────────────────────────────────────────────

console.log();
if (failCount === 0) {
  console.log(`All ${passCount} assertions passed. Congestion model is internally consistent.`);
} else {
  console.log(`${failCount} assertion(s) FAILED. Check ASSUMPTIONS or re-run gen:traffic.`);
  process.exitCode = 1;
}

// ── Global stats ──────────────────────────────────────────────

const nightMults: number[] = [];
for (let ei = 0; ei < e; ei += STEP) {
  const ff   = A.freeFlowKmh[classes[ei]!]!;
  const spdN = getSpeedFull(tdFull, ei, 3);
  nightMults.push(ff / spdN);
}
const avgNight = nightMults.reduce((s, x) => s + x, 0) / nightMults.length;
const maxNight = Math.max(...nightMults);

console.log('\n── Global stats (sampled every ~1000 edges) ──');
console.log(`  AM peak   (08:00): avg mult ${avgGlobalMult.toFixed(3)},  max ${maxGlobalMult.toFixed(3)}`);
console.log(`  Overnight (03:00): avg mult ${avgNight.toFixed(3)},  max ${maxNight.toFixed(3)}`);
console.log(`  BPR calibration:   α=${A.bprAlpha}  β=${A.bprBeta}  multMax=${A.multMax}`);
console.log(`  (mult=1.0 = free-flow; mult=${A.multMax} = extreme gridlock)`);
