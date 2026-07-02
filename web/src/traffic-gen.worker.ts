// Web Worker: precomputes per-edge CBD factor and toward-CBD dot product.
// These are hour-independent geometry calculations that the BPR model needs
// for every edge. Running them once here frees the main thread and avoids
// recomputing them on every slider release.
//
// Input (postMessage from main thread after graph loads):
//   { lats, lons, offsets, targets, n, e }
//
// Output (postMessage back, Transferable):
//   { cbdFactor: Float64Array, edgeDot: Float64Array }
//
//   cbdFactor[ei] = 1 + cbdDemandBoost × exp(−(dist_to_CBD / cbdScaleM)²)
//   edgeDot[ei]   = cosine similarity of edge direction vs toward-CBD vector
//                   (+1 = points at CBD, −1 = away, 0 = perpendicular)

import { ASSUMPTIONS as A } from '../../src/lib/traffic-constants.ts';

type WorkerInput = {
  lats: Float64Array;
  lons: Float64Array;
  offsets: Int32Array;
  targets: Int32Array;
  n: number;
  e: number;
};

const EARTH_R = 6_371_000;

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.asin(Math.sqrt(a));
}

self.onmessage = (evt: MessageEvent<WorkerInput>) => {
  const { lats, lons, offsets, targets, n, e } = evt.data;
  const t0 = performance.now();

  const cbdFactor = new Float64Array(e);
  const edgeDot   = new Float64Array(e);

  for (let i = 0; i < n; i++) {
    const srcLat = lats[i]!;
    const srcLon = lons[i]!;
    const end    = offsets[i + 1]!;

    for (let ei = offsets[i]!; ei < end; ei++) {
      const j = targets[ei]!;
      const midLat = j >= 0 ? (srcLat + lats[j]!) / 2 : srcLat;
      const midLon = j >= 0 ? (srcLon + lons[j]!) / 2 : srcLon;

      const cbdDist = haversine(midLat, midLon, A.cbdLat, A.cbdLon);
      cbdFactor[ei] = 1 + A.cbdDemandBoost * Math.exp(-((cbdDist / A.cbdScaleM) ** 2));

      let dot = 0;
      if (j >= 0) {
        const cosLat = Math.cos((midLat * Math.PI) / 180);
        const ex = (lons[j]! - srcLon) * cosLat;
        const ey = lats[j]! - srcLat;
        const cx = (A.cbdLon - midLon) * cosLat;
        const cy = A.cbdLat - midLat;
        const eMag = Math.sqrt(ex * ex + ey * ey);
        const cMag = Math.sqrt(cx * cx + cy * cy);
        if (eMag > 0 && cMag > 0) dot = (ex * cx + ey * cy) / (eMag * cMag);
      }
      edgeDot[ei] = dot;
    }
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`[traffic-gen.worker] computed cbdFactor+edgeDot for ${e.toLocaleString()} edges in ${elapsed} ms`);

  self.postMessage({ cbdFactor, edgeDot }, { transfer: [cbdFactor.buffer, edgeDot.buffer] });
};
