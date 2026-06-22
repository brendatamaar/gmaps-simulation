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

export type PlaceKind =
  | "airport"
  | "transit"
  | "hospital"
  | "university"
  | "shopping"
  | "park"
  | "landmark"
  | "worship"
  | "hotel"
  | "food"
  | "area";
export type OsmPlace = {
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
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
const HISTORIC_KEEP = new Set([
  "monument",
  "memorial",
  "castle",
  "fort",
  "archaeological_site",
]);
const TOURISM_KEEP = new Set([
  "attraction",
  "museum",
  "gallery",
  "viewpoint",
  "aquarium",
]);
const EDU = new Set(["university", "college"]);
const FOOD = new Set(["restaurant", "cafe", "fast_food", "food_court"]);

function placeKind(
  tags: Record<string, string>,
  fromWay: boolean,
): PlaceKind | null {
  if (tags["aeroway"] === "aerodrome") return "airport";
  if (tags["railway"] === "station" || tags["amenity"] === "bus_station")
    return "transit";
  if (tags["amenity"] === "hospital") return "hospital";
  if (EDU.has(tags["amenity"]!)) return "university";
  if (
    tags["shop"] === "mall" ||
    tags["shop"] === "department_store" ||
    tags["amenity"] === "marketplace"
  )
    return "shopping";
  if (
    tags["tourism"] === "zoo" ||
    tags["tourism"] === "theme_park" ||
    tags["leisure"] === "stadium" ||
    tags["leisure"] === "park"
  )
    return "park";
  if (
    TOURISM_KEEP.has(tags["tourism"]!) ||
    HISTORIC_KEEP.has(tags["historic"]!) ||
    tags["man_made"] === "tower"
  )
    return "landmark";
  if (fromWay && tags["amenity"] === "place_of_worship") return "worship";
  if (tags["tourism"] === "hotel") return "hotel";
  if (FOOD.has(tags["amenity"]!)) return "food";
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
}> {
  const nodes = new Map<number, NodeCoord>();
  const ways: OsmWay[] = [];
  const places: OsmPlace[] = [];

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
            if (kind) places.push({ name: tags.name, lat, lon, kind });
          }
        } else if (item.type === "way") {
          const tags = item.tags;
          if (!tags) continue;
          if (tags.highway && HIGHWAY_KEEP.has(tags.highway)) {
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
              if (c > 0)
                places.push({
                  name: tags.name,
                  lat: sLat / c,
                  lon: sLon / c,
                  kind,
                });
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
  };
}
