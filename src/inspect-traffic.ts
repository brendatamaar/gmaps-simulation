// ============================================================
// TRAFFIC CORRIDOR INSPECTOR — SIMULATION ONLY
// ============================================================
// Prints a 24-row table (one row per hour) of median volume,
// V/C, and speed across all edges of a named corridor.
// Also writes web/public/corridor-traffic.csv for charting.
//
// Data source: traffic-full.bin (authoritative stored values,
// no BPR inversion). Volume in veh/h, speed in km/h.
//
// Built-in corridors: Sudirman · TB Simatupang · HR Rasuna Said
// Optional extra: pass any street name as a CLI argument.
//   e.g.  pnpm inspect:traffic "gatot subroto"
//
// Run: pnpm inspect:traffic [street-name]
// ============================================================

import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ASSUMPTIONS as A } from './traffic-assumptions.ts';
import { loadTrafficFull, getVolumeFull, getSpeedFull } from '../web/src/trafficData.ts';

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
void n; // used in offset computation above

// ── Load traffic-full.bin ─────────────────────────────────────

const rawF = await readFile(path.join(PUB, 'traffic-full.bin')).catch(() => {
  throw new Error('traffic-full.bin not found — run pnpm gen:traffic first');
});
const fbuf = rawF.buffer.slice(rawF.byteOffset, rawF.byteOffset + rawF.byteLength);
const tdFull = loadTrafficFull(fbuf);
if (tdFull.e !== e) throw new Error(`traffic-full.bin e=${tdFull.e} ≠ graph.bin e=${e}`);

// ── Helpers ───────────────────────────────────────────────────

function capacityFor(cls: number): number {
  return A.capacityPerLane[cls]! * A.defaultLanes[cls]!;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

function findNameIds(search: string): Set<number> {
  const lower = search.toLowerCase();
  const out = new Set<number>();
  for (let id = 0; id < names.length; id++) {
    if (names[id]!.toLowerCase().includes(lower)) out.add(id);
  }
  return out;
}

function findEdges(nameIdSet: Set<number>): number[] {
  const out: number[] = [];
  for (let ei = 0; ei < e; ei++) {
    if (nameIdSet.has(nameIds[ei]!)) out.push(ei);
  }
  return out;
}

function pad(s: string | number, w: number, right = false): string {
  const t = String(s);
  return right ? t.padEnd(w) : t.padStart(w);
}

// ── Corridor definitions ──────────────────────────────────────

const BUILT_IN_CORRIDORS = [
  { label: 'Jl. Sudirman',       search: 'sudirman'    },
  { label: 'TB Simatupang',      search: 'simatupang'  },
  { label: 'Jl. HR Rasuna Said', search: 'rasuna said' },
];

// Optional extra corridor from CLI arg (e.g. "gatot subroto").
const extraArg = process.argv[2]?.trim();
const CORRIDORS = extraArg
  ? [...BUILT_IN_CORRIDORS, { label: extraArg, search: extraArg.toLowerCase() }]
  : BUILT_IN_CORRIDORS;

// ── CSV accumulator ───────────────────────────────────────────

const csvRows: string[] = ['corridor,hour,volume_veh_h,vc,speed_kmh'];

// ── Per-corridor 24-row table ─────────────────────────────────

for (const corridor of CORRIDORS) {
  const nameIdSet = findNameIds(corridor.search);
  const edgeList  = findEdges(nameIdSet);

  if (edgeList.length === 0) {
    console.log(`\n── ${corridor.label} ──`);
    console.log('  No edges found — check the street name in names.json.');
    continue;
  }

  console.log(`\n── ${corridor.label} (${edgeList.length} edges) ──`);
  console.log(
    pad('Hour', 6) +
    pad('Med.Vol(veh/h)', 16) +
    pad('Med.V/C', 9) +
    pad('Med.Spd(km/h)', 14) +
    pad('Min.Spd', 9) +
    pad('Max.Spd', 9),
  );
  console.log('─'.repeat(63));

  for (let h = 0; h < 24; h++) {
    const volumes: number[] = [];
    const speeds:  number[] = [];
    const vcs:     number[] = [];

    for (const ei of edgeList) {
      const cls = classes[ei]!;
      const cap = capacityFor(cls);
      const vol = getVolumeFull(tdFull, ei, h);
      const spd = getSpeedFull(tdFull, ei, h);
      volumes.push(vol);
      speeds.push(spd);
      vcs.push(vol / cap);
    }

    const medVol = Math.round(median(volumes));
    const medVc  = median(vcs);
    const medSpd = median(speeds);
    const minSpd = Math.min(...speeds);
    const maxSpd = Math.max(...speeds);

    const isPeak = (h === 7 || h === 8 || h === 17 || h === 18) ? ' ◀' : '';
    console.log(
      pad(`${String(h).padStart(2, '0')}:00`, 6) +
      pad(medVol, 16) +
      pad(medVc.toFixed(2), 9) +
      pad(medSpd.toFixed(1), 14) +
      pad(minSpd.toFixed(1), 9) +
      pad(maxSpd.toFixed(1), 9) +
      isPeak,
    );

    csvRows.push(
      `"${corridor.label}",${h},${medVol},${medVc.toFixed(3)},${medSpd.toFixed(1)}`,
    );
  }
}

// ── Write CSV ─────────────────────────────────────────────────

const csvPath = path.join(PUB, 'corridor-traffic.csv');
fs.writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8');
console.log(`\nWrote ${csvPath}`);
console.log(`  ${csvRows.length - 1} data rows  (${CORRIDORS.length} corridors × 24 hours)`);
console.log('  Columns: corridor, hour, volume_veh_h, vc, speed_kmh');
