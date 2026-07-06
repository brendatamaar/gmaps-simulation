// Browser ALT data loader and heuristic functions.
// alt.bin layout: see src/export-alt.ts header comment.

export type AltData = {
  n: number;
  L: number;
  landmarks: Int32Array;
  fwd: Float32Array[]; // fwd[l][v] = free-flow dist from landmark l to v
  bwd: Float32Array[]; // bwd[l][v] = free-flow dist from v to landmark l
  // Optional node remap for graphs extended after preprocessing (restriction
  // split copies): remap[node] = original node id the tables were built for.
  // A split copy is only harder to reach/leave than its original, so the
  // original's landmark bounds remain admissible lower bounds.
  remap?: Int32Array | null;
};

// expectedN: node count of the graph the tables must be indexed by (the
// pre-split graph.bin n). A stale alt.bin silently corrupts the heuristic —
// misaligned bounds can be inadmissible, so reject rather than degrade.
export async function loadAlt(expectedN: number): Promise<AltData | null> {
  try {
    const resp = await fetch('alt.bin');
    if (!resp.ok) { console.warn(`[alt] alt.bin not found (${resp.status})`); return null; }
    const ab  = await resp.arrayBuffer();
    const hdr = new Int32Array(ab, 0, 4);
    if (hdr[0] !== 0x414C5448) throw new Error('bad alt.bin magic');
    const n   = hdr[1]!;
    const L   = hdr[2]!;
    if (n !== expectedN) {
      console.warn(`[alt] alt.bin is stale: built for ${n.toLocaleString()} nodes, graph has ${expectedN.toLocaleString()} — re-run pnpm export:alt. ALT disabled.`);
      return null;
    }

    const offLandmarks = 16;
    const offFwd = offLandmarks + 4 * L;
    const offBwd = offFwd + 4 * L * n;

    const landmarks = new Int32Array(ab, offLandmarks, L);
    const fwd: Float32Array[] = [];
    const bwd: Float32Array[] = [];
    for (let l = 0; l < L; l++) {
      fwd.push(new Float32Array(ab, offFwd + 4 * l * n, n));
      bwd.push(new Float32Array(ab, offBwd + 4 * l * n, n));
    }

    console.log(`[alt] loaded: ${L} landmarks, ${n.toLocaleString()} nodes`);
    return { n, L, landmarks, fwd, bwd };
  } catch (err) {
    console.warn('[alt] loadAlt failed:', err);
    return null;
  }
}

// How many landmarks the per-query heuristics actually consult. Scoring all L
// landmarks once at query start and keeping only the strongest few for this
// (s, t) gives near-identical bounds at a fraction of the per-node cost — the
// classic "active landmarks" optimization.
const ACTIVE_LANDMARKS = 3;

export type QueryHeuristics = {
  // Lower bound on dist(u → t).
  hF: (u: number) => number;
  // Lower bound on dist(s → v).
  hB: (v: number) => number;
};

// Build both heuristics for one (s, t) query using only the landmarks that
// give the best bound on dist(s → t). Any subset of landmarks stays admissible
// and consistent; selection just concentrates effort where it pays.
export function makeQueryHeuristics(alt: AltData, s: number, t: number): QueryHeuristics {
  const { L, fwd, bwd, remap } = alt;
  const ss = remap ? remap[s]! : s;
  const tt = remap ? remap[t]! : t;

  // Score each landmark by the bound it yields for the full query. Unreached
  // table entries are Infinity, so a score can be NaN (∞−∞) or ±∞ — only
  // finite scores select a landmark; if none qualify the heuristic degrades
  // to 0 (plain bidirectional Dijkstra), matching the old code's behavior.
  const maxK = Math.min(ACTIVE_LANDMARKS, L);
  const chosen: number[] = [];
  const chosenScore: number[] = [];
  for (let l = 0; l < L; l++) {
    const score = Math.max(fwd[l]![tt]! - fwd[l]![ss]!, bwd[l]![ss]! - bwd[l]![tt]!);
    if (!Number.isFinite(score)) continue;
    // Insert into the tiny top-K list (K ≤ 3, so linear insert is fine).
    let k = chosen.length;
    while (k > 0 && score > chosenScore[k - 1]!) k--;
    if (k < maxK) {
      chosen.splice(k, 0, l);
      chosenScore.splice(k, 0, score);
      if (chosen.length > maxK) { chosen.pop(); chosenScore.pop(); }
    }
  }
  const K = chosen.length;

  // Pre-extract the active rows and their endpoint values.
  const fwdRows: Float32Array[] = [];
  const bwdRows: Float32Array[] = [];
  const atT = new Float64Array(K);
  const atS = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const l = chosen[k]!;
    fwdRows.push(fwd[l]!);
    bwdRows.push(bwd[l]!);
    atT[k] = fwd[l]![tt]!;
    atS[k] = bwd[l]![ss]!;
  }

  const hF = (u: number): number => {
    const uu = remap ? remap[u]! : u;
    let h = 0;
    for (let k = 0; k < K; k++) {
      const d = atT[k]! - fwdRows[k]![uu]!;
      if (d > h) h = d;
    }
    return h;
  };
  // Lower bound on dist(s → v): triangle inequality via landmark l gives
  // dist(s,l) <= dist(s,v) + dist(v,l), i.e. dist(s,v) >= bwd[l][s] - bwd[l][v]
  // (atS[k] - bwdRows[k][vv], NOT the reverse — swapping the operands makes
  // this inadmissible, since it flips sign whenever v is farther from l than
  // s is, and an inadmissible ALT heuristic silently returns non-shortest
  // paths from the bidirectional search below).
  const hB = (v: number): number => {
    const vv = remap ? remap[v]! : v;
    let h = 0;
    for (let k = 0; k < K; k++) {
      const d = atS[k]! - bwdRows[k]![vv]!;
      if (d > h) h = d;
    }
    return h;
  };
  return { hF, hB };
}
