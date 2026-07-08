// Real Jakarta places extracted from the OSM PBF (see src/lib/parser.ts +
// export-graph.ts). Fetched as places.json and rendered as labelled, clickable
// POIs. Clicking one snaps to the nearest routable node, like tapping a POI in
// Google Maps.

export type PlaceKind =
  | "airport"
  | "train"
  | "lrt"
  | "bus"
  | "hospital"
  | "clinic"
  | "university"
  | "school"
  | "shopping"
  | "office"
  | "park"
  | "landmark"
  | "attraction"
  | "services"
  | "hotel"
  | "food"
  | "bar"
  | "worship"
  | "area";

export type Place = {
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  area?: number; // polygon area in m², from way-based OSM features
  addr?: string; // e.g. "Jl. Gatot Subroto, Kuningan"
};

// Dot colour per category. 'area' has no dot.
// hospital/clinic share the red family; university/school share amber.
export const KIND_COLOR: Record<PlaceKind, string> = {
  airport: "#3f51b5", // indigo
  train: "#00695c", // dark teal
  lrt: "#009688", // medium teal
  bus: "#26a69a", // light teal
  hospital: "#d93025", // red
  clinic: "#f4511e", // orange-red (less urgent than hospital)
  university: "#f9ab00", // amber
  school: "#ffcc02", // light amber (less prominent than university)
  shopping: "#1a73e8", // blue
  office: "#1565c0", // dark blue
  park: "#188038", // green
  landmark: "#a142f4", // purple (major: museum, monument, castle)
  attraction: "#9575cd", // muted purple (minor: viewpoint, gallery, tower)
  services: "#00897b", // dark teal
  hotel: "#c2185b", // pink
  food: "#e8710a", // orange
  bar: "#6d4c41", // dark brown (nightlife)
  worship: "#795548", // brown
  area: "#5f6368", // grey (label only)
};

export async function loadPlaces(): Promise<Place[]> {
  const res = await fetch("/places.json");
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
const MIN_PX = 64; // min on-screen spacing between visible dots
const TILE = 512;

// Lower rank = more important = revealed earlier when zoomed out.
// Area bonus in assignMinZoom further refines within the same rank.
const KIND_RANK: Record<PlaceKind, number> = {
  train: 0,
  hospital: 1,
  shopping: 1,
  office: 1,
  lrt: 2,
  university: 2,
  attraction: 2,
  area: 2,
  airport: 3,
  services: 3,
  park: 3,
  hotel: 3,
  food: 3,
  landmark: 3,
  clinic: 4,
  bus: 4,
  school: 4,
  bar: 4,
  worship: 4,
};

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

// Area-based prominence bonus: larger footprint → surface earlier.
// A node-only place (no area) is slightly demoted within its rank tier.
function areaBonus(area: number | undefined): number {
  if (!area || area < 100) return 0.5; // node-only or tiny polygon
  if (area > 10_000) return -0.8; // large complex (hospital, campus, mall)
  if (area > 2_000) return -0.4; // medium building
  if (area > 300) return 0; // small building
  return 0.3; // very small polygon
}

export function assignMinZoom(places: Place[]): number[] {
  const n = places.length;
  // Pixel coords at zoom 0 (whole world = TILE px). Distance scales ×2 per zoom.
  const px = places.map(
    (p) => [mercX(p.lon) * TILE, mercY(p.lat) * TILE] as const,
  );
  // Effective rank blends category importance with physical footprint size.
  const effRank = places.map((p) => KIND_RANK[p.kind] + areaBonus(p.area));
  const order = [...Array(n).keys()].sort((a, b) => effRank[a]! - effRank[b]!);

  const minz = new Array<number>(n).fill(ZMAX);
  const ax: number[] = [],
    ay: number[] = []; // accepted points' z0 pixels
  for (const i of order) {
    const [x, y] = px[i]!;
    let nearSq = Infinity;
    for (let k = 0; k < ax.length; k++) {
      const dx = x - ax[k]!,
        dy = y - ay[k]!;
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
    ax.push(x);
    ay.push(y);
  }
  return minz;
}

// GeoJSON FeatureCollection of the points, ready for a MapLibre geojson source.
// Each feature carries its index (so a click resolves back to the Place) and a
// `minzoom` used by the layer filters to thin density at low zoom.
export function placesFC(places: Place[]) {
  const minz = assignMinZoom(places);
  return {
    type: "FeatureCollection" as const,
    features: places.map((p, i) => ({
      type: "Feature" as const,
      properties: {
        idx: i,
        name: p.name,
        kind: p.kind,
        minzoom: minz[i]!,
      },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
}
