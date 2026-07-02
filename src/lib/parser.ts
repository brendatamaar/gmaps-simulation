import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const OsmPbfParser = require("osm-pbf-parser");

export type NodeCoord = { lat: number; lon: number };
export type OsmWay = {
  id: number;
  refs: number[];
  tags: Record<string, string>;
};
export type Bbox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};
// turn_restriction relation with a node via (way-via is skipped)
export type OsmRestriction = {
  type: 'no' | 'only'; // no_* = forbidden; only_* = all other turns forbidden
  fromWayId: number;
  viaNodeId: number;
  toWayId: number;
};

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
export type OsmPlace = {
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  area?: number; // polygon area in m², way-based places only
  addr?: string; // e.g. "Jl. Gatot Subroto, Kuningan"
};

const HIGHWAY_KEEP = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "residential",
  "unclassified",
  "service",
]);

// Named-place taxonomy. OSM has no built-in prominence ranking, so we whitelist
// inherently notable categories and lean on three heuristics to skip noise:
//   • places must carry a `name`,
//   • place_of_worship only counts when mapped as a *way* (a building footprint,
//     i.e. a real mosque/church, not a roadside musholla node),
//   • numerous categories (worship, food) get a low render-rank so they only
//     appear at high zoom (see assignMinZoom on the web side).
// First match wins, so order = priority for the rare feature with overlapping
// tags (e.g. a station that's also tagged tourism).
const AREA_PLACES = new Set([
  "city",
  "town",
  "suburb",
  "neighbourhood",
  "village",
  "quarter",
  "borough",
]);
// Major landmarks: iconic destinations worth showing at low zoom.
const LANDMARK_HISTORIC = new Set(["monument", "castle", "fort", "archaeological_site"]);
const LANDMARK_TOURISM  = new Set(["museum", "aquarium"]);
// Minor attractions: worth visiting but surface only at higher zoom.
// memorial is minor (too numerous); attraction/viewpoint/gallery are niche.
const ATTRACTION_HISTORIC = new Set(["memorial"]);
const ATTRACTION_TOURISM  = new Set(["attraction", "gallery", "viewpoint"]);
// university/college: nodes + ways. school/kindergarten: ways-only to suppress
// the flood of node duplicates common in Indonesian OSM data.
const EDU_MAJOR = new Set(["university", "college"]);
const EDU_MINOR = new Set(["school", "kindergarten"]);
const FOOD = new Set(["restaurant", "cafe", "fast_food", "food_court", "ice_cream"]);
const BAR  = new Set(["bar", "pub", "nightclub"]);
const FOOD_SHOP = new Set(["bakery", "seafood", "pastry"]);
const SERVICES = new Set(["bank", "pharmacy", "fuel", "post_office"]);
// security = guard posts (not destinations), intentionally excluded.
const OFFICE_TYPES = new Set(["government", "company", "ngo", "educational_institution"]);

// Best-effort address string from OSM addr:* tags.
// street  → "Jl. Gatot Subroto"
// suburb  → kelurahan (most granular neighbourhood unit in Jakarta)
// subdistrict → kecamatan (fallback when suburb absent)
function buildAddr(tags: Record<string, string>): string | undefined {
  const parts: string[] = [];
  if (tags["addr:street"]) parts.push(tags["addr:street"]);
  if (tags["addr:suburb"]) parts.push(tags["addr:suburb"]);
  else if (tags["addr:subdistrict"]) parts.push(tags["addr:subdistrict"]);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

// Shoelace formula → approximate polygon area in m².
function polygonAreaM2(refs: number[], nodes: Map<number, NodeCoord>): number {
  const coords: Array<[number, number]> = [];
  for (const ref of refs) {
    const nd = nodes.get(ref);
    if (nd) coords.push([nd.lat, nd.lon]);
  }
  if (coords.length < 3) return 0;
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += coords[i]![1]! * coords[j]![0]!;
    area -= coords[j]![1]! * coords[i]![0]!;
  }
  area = Math.abs(area) / 2;
  const avgLat = coords.reduce((s, c) => s + c[0]!, 0) / n;
  const mPerDeg = 111_320;
  return area * mPerDeg * mPerDeg * Math.cos((avgLat * Math.PI) / 180);
}

function placeKind(
  tags: Record<string, string>,
  fromWay: boolean,
): PlaceKind | null {
  if (tags["aeroway"] === "aerodrome") return "airport";
  if (tags["amenity"] === "bus_station") return "bus";
  if (tags["railway"] === "station" || tags["railway"] === "halt") {
    const st = tags["station"];
    if (st === "light_rail" || st === "subway" || st === "monorail") return "lrt";
    return "train";
  }
  // Major vs minor healthcare — different render ranks.
  if (tags["amenity"] === "hospital" || tags["healthcare"] === "hospital")
    return "hospital";
  if (tags["amenity"] === "clinic" || tags["healthcare"] === "clinic")
    return "clinic";
  // Major vs minor education — different render ranks.
  if (EDU_MAJOR.has(tags["amenity"]!)) return "university";
  if (fromWay && EDU_MINOR.has(tags["amenity"]!)) return "school";
  if (
    tags["shop"] === "mall" ||
    tags["shop"] === "department_store" ||
    tags["shop"] === "supermarket" ||
    tags["amenity"] === "marketplace"
  )
    return "shopping";
  if (
    tags["tourism"] === "zoo" ||
    tags["tourism"] === "theme_park" ||
    tags["leisure"] === "stadium" ||
    tags["leisure"] === "park" ||
    tags["leisure"] === "garden" ||
    tags["leisure"] === "sports_centre" ||
    tags["leisure"] === "water_park" ||
    tags["leisure"] === "nature_reserve"
  )
    return "park";
  if (LANDMARK_TOURISM.has(tags["tourism"]!) || LANDMARK_HISTORIC.has(tags["historic"]!))
    return "landmark";
  if (
    ATTRACTION_TOURISM.has(tags["tourism"]!) ||
    ATTRACTION_HISTORIC.has(tags["historic"]!) ||
    (fromWay && tags["man_made"] === "tower")
  )
    return "attraction";
  if (
    fromWay &&
    (OFFICE_TYPES.has(tags["office"]!) ||
      tags["building"] === "office" ||
      tags["building"] === "commercial")
  )
    return "office";
  if (SERVICES.has(tags["amenity"]!) || tags["healthcare"] === "pharmacy")
    return "services";
  if (
    tags["tourism"] === "hotel" ||
    tags["tourism"] === "guest_house" ||
    tags["tourism"] === "hostel"
  )
    return "hotel";
  if (BAR.has(tags["amenity"]!)) return "bar";
  if (FOOD.has(tags["amenity"]!) || FOOD_SHOP.has(tags["shop"]!)) return "food";
  if (fromWay && tags["amenity"] === "place_of_worship") return "worship";
  if (AREA_PLACES.has(tags["place"]!)) return "area";
  return null;
}

export async function parsePbf(
  pbfPath: string,
  bbox: Bbox,
): Promise<{
  nodes: Map<number, NodeCoord>;
  ways: OsmWay[];
  places: OsmPlace[];
  restrictions: OsmRestriction[];
}> {
  const nodes = new Map<number, NodeCoord>();
  const ways: OsmWay[] = [];
  const places: OsmPlace[] = [];
  const restrictions: OsmRestriction[] = [];

  const inBox = (lat: number, lon: number) =>
    lat >= bbox.minLat &&
    lat <= bbox.maxLat &&
    lon >= bbox.minLng &&
    lon <= bbox.maxLng;

  await new Promise<void>((resolve, reject) => {
    const parser = OsmPbfParser();

    parser.on("data", (items: any[]) => {
      for (const item of items) {
        if (item.type === "node") {
          const { id, lat, lon, tags } = item;
          if (!inBox(lat, lon)) continue;
          nodes.set(id, { lat, lon });
          if (tags?.name) {
            const kind = placeKind(tags, false);
            if (kind) {
              const addr = buildAddr(tags);
              places.push({ name: tags.name, lat, lon, kind, ...(addr ? { addr } : {}) });
            }
          }
        } else if (item.type === "relation") {
          const tags = item.tags;
          if (!tags || tags['type'] !== 'restriction') continue;
          const restriction =
            tags['restriction'] ||
            tags['restriction:motorcar'] ||
            tags['restriction:motor_vehicle'];
          if (!restriction) continue;
          const isNo = restriction.startsWith('no_');
          const isOnly = restriction.startsWith('only_');
          if (!isNo && !isOnly) continue;
          let fromWayId = -1, viaNodeId = -1, toWayId = -1;
          for (const member of (item.members ?? [])) {
            const memId = member.ref ?? member.id;
            if (member.role === 'from' && member.type === 'way') fromWayId = memId;
            else if (member.role === 'via' && member.type === 'node') viaNodeId = memId;
            else if (member.role === 'to' && member.type === 'way') toWayId = memId;
          }
          // Only handle node-via restrictions; skip way-via (complex multi-edge turns)
          if (fromWayId < 0 || viaNodeId < 0 || toWayId < 0) continue;
          if (!nodes.has(viaNodeId)) continue; // via must be inside bbox
          restrictions.push({ type: isOnly ? 'only' : 'no', fromWayId, viaNodeId, toWayId });
        } else if (item.type === "way") {
          const tags = item.tags;
          if (!tags) continue;
          if (tags.highway && HIGHWAY_KEEP.has(tags.highway)) {
            // Skip ways with explicit motor-vehicle prohibition
            const access = tags['access'];
            const motorVehicle = tags['motor_vehicle'] || tags['motorcar'];
            if (access === 'no' || motorVehicle === 'no') continue;
            ways.push({ id: item.id, refs: item.refs, tags });
          } else if (tags.name) {
            // Ways (PBF orders nodes before ways, so refs are resolvable here).
            // Use the centroid of the in-bbox refs as the place location.
            const kind = placeKind(tags, true);
            if (kind) {
              let sLat = 0,
                sLon = 0,
                c = 0;
              for (const ref of item.refs) {
                const nd = nodes.get(ref);
                if (nd) {
                  sLat += nd.lat;
                  sLon += nd.lon;
                  c++;
                }
              }
              if (c > 0) {
                const area = polygonAreaM2(item.refs, nodes);
                const addr = buildAddr(tags);
                places.push({
                  name: tags.name,
                  lat: sLat / c,
                  lon: sLon / c,
                  kind,
                  ...(area > 0 ? { area } : {}),
                  ...(addr ? { addr } : {}),
                });
              }
            }
          }
        }
      }
    });

    parser.on("end", resolve);
    parser.on("error", reject);
    fs.createReadStream(pbfPath).pipe(parser);
  });

  // Dedupe by kind+name+~110m cell: merges a place that appears as both a label
  // node and a way (same spot), without collapsing same-name chain outlets
  const seen = new Set<string>();
  const deduped = places.filter((p) => {
    const k = `${p.kind}|${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    nodes,
    ways: ways.filter((w) => w.refs.some((id) => nodes.has(id))),
    places: deduped,
    restrictions,
  };
}
