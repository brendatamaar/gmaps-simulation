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

// Lower bound on dist(u → t).  Call once per query with fixed `t`.
export function makeForwardHeuristic(alt: AltData, t: number): (u: number) => number {
  const { L, fwd, remap } = alt;
  const tt = remap ? remap[t]! : t;
  // Pre-read fwd[l][t] for each landmark — avoids repeated Float32Array indexing inside the hot loop.
  const atT = new Float32Array(L);
  for (let l = 0; l < L; l++) atT[l] = fwd[l]![tt]!;
  return (u: number) => {
    const uu = remap ? remap[u]! : u;
    let h = 0;
    for (let l = 0; l < L; l++) {
      const d = atT[l]! - fwd[l]![uu]!;
      if (d > h) h = d;
    }
    return h > 0 ? h : 0;
  };
}

// Lower bound on dist(s → v).  Call once per query with fixed `s`.
export function makeBackwardHeuristic(alt: AltData, s: number): (v: number) => number {
  const { L, bwd, remap } = alt;
  const ss = remap ? remap[s]! : s;
  const atS = new Float32Array(L);
  for (let l = 0; l < L; l++) atS[l] = bwd[l]![ss]!;
  return (v: number) => {
    const vv = remap ? remap[v]! : v;
    let h = 0;
    for (let l = 0; l < L; l++) {
      const d = bwd[l]![vv]! - atS[l]!;
      if (d > h) h = d;
    }
    return h > 0 ? h : 0;
  };
}
