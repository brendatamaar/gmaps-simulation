// Real Jakarta places extracted from the OSM PBF (see src/lib/parser.ts +
// export-graph.ts). Fetched as places.json and rendered as labelled, clickable
// POIs. Clicking one snaps to the nearest routable node, like tapping a POI in
// Google Maps.

export type PlaceKind =
  | 'airport' | 'transit' | 'hospital' | 'university'
  | 'shopping' | 'park' | 'landmark' | 'worship'
  | 'hotel' | 'food' | 'area';

export type Place = {
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
};

// Dot colour per category, Google-ish category cues. 'area' has no dot.
export const KIND_COLOR: Record<PlaceKind, string> = {
  airport: '#3f51b5',    // indigo
  transit: '#009688',    // teal
  hospital: '#d93025',   // red
  university: '#f9ab00',  // amber
  shopping: '#1a73e8',   // blue
  park: '#188038',       // green
  landmark: '#a142f4',   // purple
  worship: '#795548',    // brown
  hotel: '#c2185b',      // pink
  food: '#e8710a',       // orange
  area: '#5f6368',       // grey (label only)
};

export async function loadPlaces(): Promise<Place[]> {
  const res = await fetch('/places.json');
  if (!res.ok) throw new Error(`places.json: ${res.status}`);
  return res.json() as Promise<Place[]>;
}

// Zoom thinning (Google-style density).
// Circle layers don't collision-declutter the way symbol layers do, so without
// help every dot in view paints at once. We precompute, per place, the lowest
// zoom at which it first appears: process places by importance (kind) and accept
// each at the zoom where it clears all already-accepted places by MIN_PX pixels.
// Result: a sparse, well-spread sprinkle when zoomed out; everything by ZMAX.
export const ZMIN = 10;
export const ZMAX = 16;
const MIN_PX = 64;      // min on-screen spacing between visible dots
const TILE = 512;

// Lower rank = more important = revealed earlier when zoomed out. Bounded,
// iconic kinds (airports, stations, hospitals) surface first; the numerous ones
// (worship, food) sit at the bottom and only appear once zoomed right in.
const KIND_RANK: Record<PlaceKind, number> = {
  airport: 0, transit: 0, hospital: 0,
  landmark: 1, shopping: 1, university: 1, area: 1,
  park: 2, hotel: 2,
  worship: 3,
  food: 4,
};

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export function assignMinZoom(places: Place[]): number[] {
  const n = places.length;
  // Pixel coords at zoom 0 (whole world = TILE px). Distance scales ×2 per zoom.
  const px = places.map((p) => [mercX(p.lon) * TILE, mercY(p.lat) * TILE] as const);
  const order = [...Array(n).keys()].sort((a, b) => KIND_RANK[places[a]!.kind] - KIND_RANK[places[b]!.kind]);

  const minz = new Array<number>(n).fill(ZMAX);
  const ax: number[] = [], ay: number[] = []; // accepted points' z0 pixels
  for (const i of order) {
    const [x, y] = px[i]!;
    let nearSq = Infinity;
    for (let k = 0; k < ax.length; k++) {
      const dx = x - ax[k]!, dy = y - ay[k]!;
      const d = dx * dx + dy * dy;
      if (d < nearSq) nearSq = d;
    }
    let z = ZMIN;
    if (nearSq !== Infinity) {
      // need near0 · 2^z ≥ MIN_PX  ⇒  z ≥ log2(MIN_PX / near0)
      const near0 = Math.sqrt(nearSq);
      z = Math.max(ZMIN, Math.min(ZMAX, Math.ceil(Math.log2(MIN_PX / near0))));
    }
    minz[i] = z;
    ax.push(x); ay.push(y);
  }
  return minz;
}

// GeoJSON FeatureCollection of the points, ready for a MapLibre geojson source.
// Each feature carries its index (so a click resolves back to the Place) and a
// `minzoom` used by the layer filters to thin density at low zoom.
export function placesFC(places: Place[]) {
  const minz = assignMinZoom(places);
  return {
    type: 'FeatureCollection' as const,
    features: places.map((p, i) => ({
      type: 'Feature' as const,
      properties: { idx: i, name: p.name, kind: p.kind, color: KIND_COLOR[p.kind], minzoom: minz[i]! },
      geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
    })),
  };
}
