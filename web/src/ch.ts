// Browser CH loader and bidirectional upward Dijkstra query.
//
// Loads web/public/ch.bin (produced by pnpm export:ch), reconstructs the
// upward adjacency in-browser, and answers free-flow shortest-path queries
// in microseconds by settling only a handful of nodes.
//
// ch.bin binary layout: see src/export-ch.ts header comment.

import { TypedMinHeap } from './typed-heap.ts';

export type CHData = {
  n: number;
  rank: Int32Array;
  outOff: Int32Array;    // CSR offsets for all out-edges (upward + downward)
  edgeTo: Int32Array;
  edgeMid: Int32Array;   // -1 = original road edge; else shortcut bypass node
  edgeCa: Int32Array;    // first child edge index (-1 if original)
  edgeCb: Int32Array;
  edgeW: Float64Array;   // free-flow travel time (metres-equivalent)
  // Derived in-browser (not stored in binary)
  edgeFrom: Int32Array;  // source node per edge, computed from outOff
  revOff: Int32Array;    // CSR offsets for reverse (incoming) adjacency
  revEi: Int32Array;     // edge indices of incoming edges (indexed by revOff)
};

export type CHQueryResult = {
  dist: number;      // free-flow travel time in metres-equivalent (divide by MAX_SPEED_MPS for seconds)
  path: number[];    // node indices, start → end
  settled: number;   // nodes settled by bidirectional search
  queryMs: number;
};

export async function loadCH(): Promise<CHData | null> {
  try {
    const resp = await fetch('ch.bin');
    if (!resp.ok) {
      console.warn(`[ch] ch.bin fetch failed: ${resp.status}`);
      return null;
    }
    const ab  = await resp.arrayBuffer();
    const hdr = new Int32Array(ab, 0, 4);
    if (hdr[0] !== 0x43484720) throw new Error('bad ch.bin magic');
    const n   = hdr[1]!;
    const E   = hdr[2]!;
    const ver = hdr[3]!;
    if (ver < 1) throw new Error('ch.bin version too old — re-run pnpm export:ch');

    const offRank   = 16;
    const offOutOff = offRank   + 4 * n;
    const offTo     = offOutOff + 4 * (n + 1);
    const offMid    = offTo     + 4 * E;
    const offCa     = offMid    + 4 * E;
    const offCb     = offCa     + 4 * E;
    const offW      = Math.ceil((offCb + 4 * E) / 8) * 8;

    const rank    = new Int32Array(ab, offRank,   n);
    const outOff  = new Int32Array(ab, offOutOff, n + 1);
    const edgeTo  = new Int32Array(ab, offTo,  E);
    const edgeMid = new Int32Array(ab, offMid, E);
    const edgeCa  = new Int32Array(ab, offCa,  E);
    const edgeCb  = new Int32Array(ab, offCb,  E);
    const edgeW   = new Float64Array(ab, offW, E);

    // Derive edgeFrom (source node) from the CSR outOff structure.
    const edgeFrom = new Int32Array(E);
    for (let u = 0; u < n; u++) {
      for (let ei = outOff[u]!; ei < outOff[u + 1]!; ei++) {
        edgeFrom[ei] = u;
      }
    }

    // Build reverse adjacency for the backward upward search.
    // revOff[w]..revOff[w+1]-1 indexes revEi entries for incoming edges to w.
    const revCount = new Int32Array(n);
    for (let ei = 0; ei < E; ei++) revCount[edgeTo[ei]!]++;
    const revOff = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) revOff[i + 1] = revOff[i]! + revCount[i]!;
    const revEi = new Int32Array(E);
    const cur   = revOff.slice(0, n);
    for (let u = 0; u < n; u++) {
      for (let ei = outOff[u]!; ei < outOff[u + 1]!; ei++) {
        const w = edgeTo[ei]!;
        revEi[cur[w]!++] = ei;
      }
    }

    console.log(`[ch] loaded: ${n.toLocaleString()} nodes, ${E.toLocaleString()} edges (incl. shortcuts)`);
    return { n, rank, outOff, edgeTo, edgeMid, edgeCa, edgeCb, edgeW, edgeFrom, revOff, revEi };
  } catch (err) {
    console.warn('[ch] loadCH failed:', err);
    return null;
  }
}

// Expand shortcut edge `ei` into original road edges, appending destination
// nodes to `path`.  Terminates at original edges (edgeMid[ei] === -1).
function unpackInto(path: number[], ei: number, ch: CHData): void {
  const mid = ch.edgeMid[ei]!;
  if (mid === -1) {
    path.push(ch.edgeTo[ei]!);
    return;
  }
  unpackInto(path, ch.edgeCa[ei]!, ch);
  unpackInto(path, ch.edgeCb[ei]!, ch);
}

// Persistent scratch storage for CHRouter so repeated queries avoid O(n) alloc.
export class CHRouter {
  private ch: CHData;
  private ver = 0;
  private distF: Float64Array;
  private distB: Float64Array;
  private stF: Int32Array;   // version stamp — entry valid iff === ver
  private stB: Int32Array;
  private parF: Int32Array;
  private parB: Int32Array;
  private eFIdx: Int32Array; // forward: edge index that settled this node
  private eBIdx: Int32Array; // backward: edge index that settled this node
  private heapF = new TypedMinHeap(1024);
  private heapB = new TypedMinHeap(1024);

  constructor(ch: CHData) {
    this.ch = ch;
    const n = ch.n;
    this.distF = new Float64Array(n);
    this.distB = new Float64Array(n);
    this.stF   = new Int32Array(n);
    this.stB   = new Int32Array(n);
    this.parF  = new Int32Array(n);
    this.parB  = new Int32Array(n);
    this.eFIdx = new Int32Array(n);
    this.eBIdx = new Int32Array(n);
  }

  query(s: number, t: number): CHQueryResult | null {
    if (s === t) return { dist: 0, path: [s], settled: 0, queryMs: 0 };
    const t0 = performance.now();
    const ch = this.ch;
    const { rank, outOff, edgeTo, edgeW, edgeFrom, revOff, revEi } = ch;
    const ver = ++this.ver;
    const { distF, distB, stF, stB, parF, parB, eFIdx, eBIdx } = this;

    const dF = (i: number) => (stF[i] === ver ? distF[i]! : Infinity);
    const dB = (i: number) => (stB[i] === ver ? distB[i]! : Infinity);

    // Init source and target
    distF[s] = 0; stF[s] = ver; parF[s] = -1;
    distB[t] = 0; stB[t] = ver; parB[t] = -1;

    const hF = this.heapF; hF.clear();
    const hB = this.heapB; hB.clear();
    hF.push(s, 0);
    hB.push(t, 0);

    let mu = Infinity, meet = -1, settled = 0;

    // Interleaved upward searches with pruning: in CH the shortest path is
    // up-then-down through its highest-rank node, so a direction whose min
    // queue key already reaches mu can never improve the answer and stops.
    // (This is per-direction, unlike bidirectional A*'s summed condition.)
    // Interleaving by the smaller key lets mu form early so pruning bites;
    // running each side to exhaustion (as before) settles far more nodes.
    while (hF.size > 0 || hB.size > 0) {
      const minF = hF.size > 0 && hF.peekKey() < mu ? hF.peekKey() : Infinity;
      const minB = hB.size > 0 && hB.peekKey() < mu ? hB.peekKey() : Infinity;
      if (minF === Infinity && minB === Infinity) break;

      if (minF <= minB) {
        // Forward upward step from s.
        const d = hF.peekKey();
        const u = hF.pop();
        if (d > dF(u)) continue;
        settled++;
        const ob = dB(u);
        if (ob < Infinity && d + ob < mu) { mu = d + ob; meet = u; }
        const rankU = rank[u]!;
        for (let ei = outOff[u]!; ei < outOff[u + 1]!; ei++) {
          const w = edgeTo[ei]!;
          if (rank[w]! <= rankU) continue; // upward only
          const nd = d + edgeW[ei]!;
          if (nd < dF(w)) {
            distF[w] = nd; stF[w] = ver; parF[w] = u; eFIdx[w] = ei;
            hF.push(w, nd);
          }
        }
      } else {
        // Backward upward step from t. Iterates incoming edges to w (stored in
        // revOff/revEi as out-edge indices), relaxing the source node s′ where
        // rank[s′] > rank[w].
        const d = hB.peekKey();
        const w = hB.pop();
        if (d > dB(w)) continue;
        settled++;
        const of = dF(w);
        if (of < Infinity && d + of < mu) { mu = d + of; meet = w; }
        const rankW = rank[w]!;
        for (let k = revOff[w]!; k < revOff[w + 1]!; k++) {
          const ei = revEi[k]!;
          const s2 = edgeFrom[ei]!; // source of this out-edge s2→w
          if (rank[s2]! <= rankW) continue; // upward only from w's perspective
          const nd = d + edgeW[ei]!;
          if (nd < dB(s2)) {
            distB[s2] = nd; stB[s2] = ver; parB[s2] = w; eBIdx[s2] = ei;
            hB.push(s2, nd);
          }
        }
      }
    }

    if (meet === -1) return null;

    // Reconstruct forward half: s → meet.
    const fEis: number[] = [], fSrcs: number[] = [];
    for (let v = meet; parF[v]! !== -1; v = parF[v]!) {
      fEis.push(eFIdx[v]!);
      fSrcs.push(parF[v]!);
    }
    fEis.reverse();
    fSrcs.reverse();

    // Reconstruct backward half: meet → t.
    // parB[v] = w means edge v→w was used to settle v in backward search.
    // eBIdx[v] = the out-edge index of v→w (which unpackInto uses to expand shortcuts).
    const bEis: number[] = [];
    for (let v = meet; parB[v]! !== -1; v = parB[v]!) {
      bEis.push(eBIdx[v]!);
    }

    const path: number[] = [fSrcs.length > 0 ? fSrcs[0]! : meet];
    for (let i = 0; i < fEis.length; i++) unpackInto(path, fEis[i]!, ch);
    for (let i = 0; i < bEis.length; i++) unpackInto(path, bEis[i]!, ch);

    return { dist: mu, path, settled, queryMs: performance.now() - t0 };
  }
}
