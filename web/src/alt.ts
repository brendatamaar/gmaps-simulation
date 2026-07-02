// Browser ALT data loader and heuristic functions.
// alt.bin layout: see src/export-alt.ts header comment.

export type AltData = {
  n: number;
  L: number;
  landmarks: Int32Array;
  fwd: Float32Array[]; // fwd[l][v] = free-flow dist from landmark l to v
  bwd: Float32Array[]; // bwd[l][v] = free-flow dist from v to landmark l
};

export async function loadAlt(): Promise<AltData | null> {
  try {
    const resp = await fetch('alt.bin');
    if (!resp.ok) { console.warn(`[alt] alt.bin not found (${resp.status})`); return null; }
    const ab  = await resp.arrayBuffer();
    const hdr = new Int32Array(ab, 0, 4);
    if (hdr[0] !== 0x414C5448) throw new Error('bad alt.bin magic');
    const n   = hdr[1]!;
    const L   = hdr[2]!;

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

// Lower bound on dist(u → t).  Call once per query with fixed `t`.
export function makeForwardHeuristic(alt: AltData, t: number): (u: number) => number {
  const { L, fwd } = alt;
  // Pre-read fwd[l][t] for each landmark — avoids repeated Float32Array indexing inside the hot loop.
  const atT = new Float32Array(L);
  for (let l = 0; l < L; l++) atT[l] = fwd[l]![t]!;
  return (u: number) => {
    let h = 0;
    for (let l = 0; l < L; l++) {
      const d = atT[l]! - fwd[l]![u]!;
      if (d > h) h = d;
    }
    return h > 0 ? h : 0;
  };
}

// Lower bound on dist(s → v).  Call once per query with fixed `s`.
export function makeBackwardHeuristic(alt: AltData, s: number): (v: number) => number {
  const { L, bwd } = alt;
  const atS = new Float32Array(L);
  for (let l = 0; l < L; l++) atS[l] = bwd[l]![s]!;
  return (v: number) => {
    let h = 0;
    for (let l = 0; l < L; l++) {
      const d = bwd[l]![v]! - atS[l]!;
      if (d > h) h = d;
    }
    return h > 0 ? h : 0;
  };
}
