import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { loadGraph, nearestNode, haversine, type Graph } from "./graph.ts";
import {
  initRouter,
  loadRestrictions,
  emptyRestrictions,
  pathViolatesRestriction,
  type Router,
  type Restrictions,
} from "./router.ts";
import { applyRestrictionSplit } from "./restriction-split.ts";
import {
  computeRoutes,
  computeRoutesBidir,
  type RouteOption,
} from "./routing.ts";
import { buildRevCSR, type RevCSR } from "./bidir-router.ts";
import type { SearchTrace } from "./search-trace.ts";
import { loadAlt, type AltData } from "./alt.ts";
import {
  buildDirections,
  primaryRoad,
  maneuverGlyph,
  formatDistance,
} from "./directions.ts";
import {
  precompute,
  fillWeights,
  etaSeconds,
  formatEta,
  formatClock,
  arrivalClock,
  segmentMultipliers,
  congestionColor,
  edgeCongestionMult,
  pathDistanceMeters,
  modeHScale,
  type TrafficModel,
  type TravelMode,
} from "./traffic.ts";
import {
  loadPlaces,
  placesFC,
  ZMIN,
  KIND_COLOR,
  type Place,
  type PlaceKind,
} from "./places.ts";
import { addPlaceIcons } from "./place-icons.ts";
import { loadCH, CHRouter, type CHData } from "./ch.ts";

// Label-rich CARTO vector basemaps (keyless): Positron for the light theme, Dark Matter for the dark one.
const BASEMAP_LIGHT =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const BASEMAP_DARK =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// The labs pages share one theme ("data-theme" on <html>, set by the labs header; otherwise the OS).
const prefersLight = matchMedia("(prefers-color-scheme: light)");
function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return (t ?? (prefersLight.matches ? "light" : "dark")) === "dark";
}
// Colours for the map layers we draw ourselves, so they read on either basemap.
function palette(dark: boolean) {
  return dark
    ? { label: "#d4d4d4", area: "#a1a1a1", halo: "#131313", casing: "#131313", alt: "#6b7075" }
    : { label: "#3c4043", area: "#5f6368", halo: "#ffffff", casing: "#ffffff", alt: "#9aa0a6" };
}

// Side panel width + gap the route must stay clear of (the panel only overlays the map on wide screens).
const wide = matchMedia("(min-width: 761px)");
// Raster fallback (different host) used if the vector style above is
// unreachable — e.g. basemaps.cartocdn.com times out on some networks.
const BASEMAP_STYLE_FALLBACK = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
} as const;
const BLUE = "#1a73e8";

const $ = (id: string) => document.getElementById(id)!;

let graph: Graph;
let router: Router;
let model: TrafficModel;
let map: maplibregl.Map;
let chData: CHData | null = null;
let chRouter: CHRouter | null = null;
let altData: AltData | null = null;
let rev: RevCSR | null = null;
// Original turn-restriction triples — used only to validate CH paths (CH is
// restriction-unaware). The routing graph itself has restrictions baked in
// topologically by applyRestrictionSplit, so the A*/bidir routers get an
// empty restriction table.
let restrictionsData: Restrictions = emptyRestrictions();
// When the destination is a restricted via node, route to its arrival node
// instead (see restriction-split.ts). Null when no restrictions are loaded.
let arrivalOf: Map<number, number> | null = null;
let altRemap: Int32Array | null = null;
// Last query stats for the mode note display.
let lastCH: { settled: number; queryMs: number } | null = null;
let lastAstar: { settled: number; queryMs: number } | null = null;
let lastBidir: { settled: number; queryMs: number } | null = null;

// Pre-filtered arterial edge data for the traffic overlay (class 0-2: motorway/trunk/primary).
// Populated once after the graph loads.
let overlayFroms: Int32Array | null = null;
let overlayEis: Int32Array | null = null;
let originMarker: maplibregl.Marker | null = null;
let destMarker: maplibregl.Marker | null = null;
let mapReady = false;

let places: Place[] = [];

let startIdx: number | null = null;
let endIdx: number | null = null;
let startLabel: string | null = null;
let endLabel: string | null = null;
let routes: RouteOption[] = [];
let selected = 0;
let lastTrace: SearchTrace | null = null;
let lastMeetNode: number | null = null;
let animFrameId: number | null = null;
// True while the search/path animation plays; on phones the results sheet waits until it ends.
let animating = false;

let mode: TravelMode = "drive";
let hour = 8;
let trafficOn = true;
let keepFrontier = true;

// ── Traffic overlay ───────────────────────────────────────────
// Scans all edges once and stores the indices of arterials (class 0–2:
// motorway, trunk, primary). ~100K edges in Jakarta — fast to iterate later.
function initOverlayEdges() {
  const { n, offsets, classes } = graph;
  const froms: number[] = [],
    eis: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let ei = offsets[i]!; ei < offsets[i + 1]!; ei++) {
      if (classes[ei]! <= 2) {
        froms.push(i);
        eis.push(ei);
      }
    }
  }
  overlayFroms = new Int32Array(froms);
  overlayEis = new Int32Array(eis);
}

// GeoJSON FeatureCollection of arterial edges, built once (geometry never
// changes) and re-colored in place on every rebuild instead of reallocating
// tens of thousands of Feature objects + coordinate arrays each time.
let trafficOverlayFC: {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { color: string };
    geometry: object;
  }[];
} | null = null;

// Recolors the cached FeatureCollection for hour `h` and returns it. Called on
// initial load and on every slider-release (change event). Uses
// edgeCongestionMult() which falls back to the static model until the Web
// Worker delivers cbdFactor/edgeDot.
function buildTrafficOverlay(h: number): object {
  if (!overlayFroms || !overlayEis) {
    return { type: "FeatureCollection", features: [] };
  }
  const { lats, lons, targets, classes } = graph;
  const count = overlayEis.length;
  if (!trafficOverlayFC) {
    const features = new Array(count);
    for (let k = 0; k < count; k++) {
      const i = overlayFroms[k]!,
        ei = overlayEis[k]!,
        j = targets[ei]!;
      features[k] = {
        type: "Feature" as const,
        properties: { color: "" },
        geometry: {
          type: "LineString",
          coordinates: [
            [lons[i]!, lats[i]!],
            [lons[j]!, lats[j]!],
          ],
        },
      };
    }
    trafficOverlayFC = { type: "FeatureCollection", features };
  }
  const { features } = trafficOverlayFC;
  for (let k = 0; k < count; k++) {
    const ei = overlayEis[k]!;
    const mult = edgeCongestionMult(model, ei, classes[ei]!, h);
    features[k]!.properties.color = congestionColor(mult);
  }
  return trafficOverlayFC;
}

// Hour changes while the overlay is hidden just mark it dirty instead of
// rebuilding — the rebuild happens once, when the overlay is shown again.
let trafficOverlayDirty = false;

function updateTrafficOverlay() {
  if (!mapReady || !overlayFroms) return;
  if (!($("showtraffic") as HTMLInputElement).checked) {
    trafficOverlayDirty = true;
    return;
  }
  trafficOverlayDirty = false;
  (
    map.getSource("traffic-overlay") as maplibregl.GeoJSONSource | undefined
  )?.setData(buildTrafficOverlay(hour) as never);
}

// GeoJSON builders
function fullLine(path: Int32Array, props: Record<string, unknown>) {
  const coords = [];
  for (let k = 0; k < path.length; k++)
    coords.push([graph.lons[path[k]!]!, graph.lats[path[k]!]!]);
  return {
    type: "Feature" as const,
    properties: props,
    geometry: { type: "LineString" as const, coordinates: coords },
  };
}

function altsFC() {
  const features = routes
    .map((r, i) => (i === selected ? null : fullLine(r.path, { routeIdx: i })))
    .filter(Boolean);
  return { type: "FeatureCollection" as const, features: features as object[] };
}

// revealCount bounds how much of the path is drawn — used to animate the
// route drawing progressively from start to end (see animatePathDraw).
// segMult is expensive (BPR calc per edge) and constant for a given route,
// so animatePathDraw precomputes it once and passes it in instead of
// letting every one of ~60fps frames recompute it from scratch.
function selectedFC(revealCount = Infinity, segMult?: Float64Array) {
  const r = routes[selected];
  if (!r) return { type: "FeatureCollection" as const, features: [] };
  const colorByTraffic = mode === "drive" && trafficOn;
  const mult =
    segMult ??
    segmentMultipliers(graph, model, r.path, hour, trafficOn, mode, r.edges);
  const features = [];
  const end = Math.min(r.path.length, Math.max(2, revealCount));
  for (let k = 1; k < end; k++) {
    const a = r.path[k - 1]!,
      b = r.path[k]!;
    features.push({
      type: "Feature" as const,
      properties: {
        idx: k - 1,
        color: colorByTraffic ? congestionColor(mult[k - 1] ?? 1) : BLUE,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [graph.lons[a]!, graph.lats[a]!],
          [graph.lons[b]!, graph.lats[b]!],
        ],
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function setData(id: string, data: object) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data as never);
}

// Place layers are thinned by the live zoom: a feature shows once the zoom
// reaches its precomputed `minzoom`. Labels trail their dot by one level so the
// map fills in gradually.
const poiFilter = (z: number): maplibregl.FilterSpecification => [
  "all",
  ["!=", ["get", "kind"], "area"],
  ["<=", ["get", "minzoom"], z],
];
const areaFilter = (z: number): maplibregl.FilterSpecification => [
  "all",
  ["==", ["get", "kind"], "area"],
  ["<=", ["get", "minzoom"], z],
];

let lastZoomApplied = -1;
function applyZoomThinning(force = false) {
  if (!mapReady) return;
  // A basemap fallback swap (see boot()) briefly removes every custom layer;
  // guard so a zoom event landing in that gap doesn't throw.
  if (!map.getLayer("place-poi") || !map.getLayer("area-labels")) return;
  const z = Math.floor(map.getZoom());
  if (!force && z === lastZoomApplied) return;
  lastZoomApplied = z;
  map.setFilter("place-poi", poiFilter(z));
  map.setFilter("area-labels", areaFilter(z));
}

// DOM rendering
function renderFields() {
  const fmt = (i: number | null, label: string | null) =>
    i === null
      ? null
      : (label ?? `${graph.lats[i]!.toFixed(4)}, ${graph.lons[i]!.toFixed(4)}`);
  const o = $("origin") as HTMLInputElement;
  const d = $("dest") as HTMLInputElement;
  const ov = fmt(startIdx, startLabel),
    dv = fmt(endIdx, endLabel);
  if (document.activeElement !== o) o.value = ov ?? "";
  if (document.activeElement !== d) d.value = dv ?? "";
}

// Results panel: needs routes; on phones also waits for the animation to finish.
function syncResults() {
  const none = routes.length === 0;
  $("results").classList.toggle("hidden", none || (animating && !wide.matches));
  $("app").classList.toggle("has-results", !none);
}

function renderCards() {
  syncResults();
  const host = $("routes");
  host.innerHTML = "";
  routes.forEach((r, i) => {
    const steps = buildDirections(graph, r.path, r.edges);
    const via = primaryRoad(steps);
    const card = document.createElement("div");
    const classes = ["route-card"];
    if (i === selected) classes.push("sel");
    card.className = classes.join(" ");
    card.innerHTML =
      `<div class="eta-row">` +
      `<span class="eta" style="color:${i === 0 ? "var(--ok)" : "var(--color-quiet)"}">${formatEta(r.etaSec)}</span>` +
      `${i === 0 && routes.length > 1 ? `<span class="badge">Fastest</span>` : ""}` +
      `</div>` +
      `<div class="meta"><b>${(r.distanceM / 1000).toFixed(1)} km</b>` +
      `${via ? ` · via ${escHtml(via)}` : ""}<br>arrive ${arrivalClock(hour, r.etaSec)}</div>`;
    card.addEventListener("click", () => selectRoute(i));
    host.appendChild(card);
  });
}

function renderSteps() {
  const host = $("steps");
  const section = $("steps-section");
  host.innerHTML = "";
  const r = routes[selected];
  section.hidden = !r;
  if (!r) return;
  const steps = buildDirections(graph, r.path, r.edges);
  $("steps-title").textContent =
    `Directions · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  for (const st of steps) {
    const row = document.createElement("div");
    row.className = "step";
    row.innerHTML =
      `<div class="g">${maneuverGlyph(st.type)}</div>` +
      `<div class="t">${escHtml(st.text)}</div>` +
      `<div class="d">${st.distanceM ? formatDistance(st.distanceM) : ""}</div>`;
    host.appendChild(row);
  }
}

function renderRoutesOnMap() {
  if (!mapReady) return;
  setData("alts", altsFC());
  setData("sel", selectedFC());
  // A previous animation may have left a reveal filter on these layers; a
  // static (non-animated) render always shows the full path.
  map.setFilter("sel-casing", null);
  map.setFilter("sel-line", null);
  setData("sel-progress", { type: "FeatureCollection", features: [] });
  map.setLayoutProperty("path-head", "visibility", "none");
  // Dim the overlay while a route is shown so the route line stands out.
  // Restores automatically when the route is cleared.
  map.setPaintProperty(
    "traffic-overlay",
    "line-opacity",
    routes.length > 0 ? 0.12 : 0.72,
  );
}

// Extra pixel padding beyond the toolbar/results chrome, so the pin markers
// (which extend ~35px above and ~14px either side of their lngLat anchor —
// see maplibregl.Marker's default offset) don't poke out under the toolbar
// or get clipped at the map edge.
const MARKER_PAD = { top: 40, bottom: 15, left: 15, right: 15 };

// How far the search frontier is allowed to push the fitted view beyond the
// route's own bounding box, as a fraction of the route's lat/lon span. Keeps
// a handful of far-flung settled nodes (which the ALT heuristic occasionally
// explores) from zooming the map way out — the route itself stays the
// dominant factor in framing, with just enough slack for nearby frontier.
const FRONTIER_EXPAND_FRAC = 0.4;

// Pixels of the map the floating results sheet covers on phones (its real height once shown, a guess before).
function sheetPad(): number {
  if (wide.matches || routes.length === 0) return 0;
  const app = $("app");
  if (app.classList.contains("sheet-off")) return 0;
  const el = $("results");
  const h = el.classList.contains("hidden") ? 0 : el.offsetHeight;
  return h || Math.min($("map").clientHeight * 0.4, 240);
}

function fitPadding(bottomExtra = 0) {
  return {
    top: 24 + MARKER_PAD.top,
    bottom: 24 + MARKER_PAD.bottom + bottomExtra,
    // phones: the toggle buttons sit on the left edge of the map
    left: (wide.matches ? 372 : 56) + MARKER_PAD.left,
    right: 24 + MARKER_PAD.right,
  };
}

// Both endpoints chosen, no route yet: frame the pair.
function fitToPoints() {
  if (!mapReady || startIdx === null || endIdx === null) return;
  const a = [graph.lons[startIdx]!, graph.lats[startIdx]!] as [number, number];
  const b = [graph.lons[endIdx]!, graph.lats[endIdx]!] as [number, number];
  map.fitBounds(
    [
      [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    ],
    { padding: fitPadding(), duration: 600, maxZoom: 16 },
  );
}

function fitToRoute() {
  if (!mapReady || routes.length === 0) return;
  const r = routes[selected];
  if (!r || r.path.length === 0) return;
  let minLat = Infinity,
    maxLat = -Infinity;
  let minLon = Infinity,
    maxLon = -Infinity;
  for (const idx of r.path) {
    const lat = graph.lats[idx]!,
      lon = graph.lons[idx]!;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const routeMinLat = minLat,
    routeMaxLat = maxLat;
  const routeMinLon = minLon,
    routeMaxLon = maxLon;
  // The bidir A*/ALT search can settle nodes somewhat outside the route
  // corridor; fold those into the fitted bounds too so the frontier
  // animation doesn't run off the edge of the view — but capped (below) so
  // it can't blow the zoom out far past what the route itself needs.
  if (lastTrace) {
    const { order } = lastTrace;
    for (let i = 0; i < order.length; i++) {
      const node = order[i]!;
      const lat = graph.lats[node]!,
        lon = graph.lons[node]!;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  const latPad = (routeMaxLat - routeMinLat) * FRONTIER_EXPAND_FRAC;
  const lonPad = (routeMaxLon - routeMinLon) * FRONTIER_EXPAND_FRAC;
  minLat = Math.max(minLat, routeMinLat - latPad);
  maxLat = Math.min(maxLat, routeMaxLat + latPad);
  minLon = Math.max(minLon, routeMinLon - lonPad);
  maxLon = Math.min(maxLon, routeMaxLon + lonPad);
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    { padding: fitPadding(sheetPad()), duration: 800 },
  );
}

// ── Search animation ──────────────────────────────────────────
// Replays the recorded settlement order (search-trace.ts) as growing dots,
// then draws the winning path from start to end. Only walk/bike (WASM A*)
// and drive+traffic (bidir A*+ALT) searches carry a trace — CH has no
// frontier to animate and falls straight through to the instant render.

const ANIM_SPEED_STEPS = [0.5, 1, 2, 4];
// Subsample pathological searches so a frame never has to draw more than
// this. Kept modest (rather than just relying on frame throttling below)
// because every reveal update re-buckets the whole GeoJSON source, so the
// point count is a direct multiplier on that cost too.
const MAX_FRONTIER_POINTS = 6_000;
// Minimum spacing between search-frontier reveal updates. map.setFilter()
// re-buckets every feature in the source, so firing it on every
// requestAnimationFrame (up to ~60/sec) with thousands of points is what
// actually causes the animation to lag — throttling to ~24/sec cuts that
// cost by more than half with no visible loss of smoothness.
const FRONTIER_UPDATE_INTERVAL_MS = 1000 / 24;

function getAnimSpeedMultiplier(): number {
  const el = document.getElementById("anim-speed") as HTMLInputElement | null;
  const v = el ? parseInt(el.value, 10) : 2;
  return ANIM_SPEED_STEPS[v - 1] ?? 1;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// Decelerating curve (fast start, gentle settle) used for both animation
// phases instead of raw linear progress — reads as fluid motion rather than
// a mechanical, constant-speed sweep.
function easeOutCubic(t: number): number {
  const f = t - 1;
  return f * f * f + 1;
}

function updateAnimControls() {
  const el = document.getElementById("anim-controls");
  if (!el) return;
  el.style.display = lastTrace && routes.length > 0 ? "" : "none";
}

function stopAnimation() {
  animating = false;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (mapReady) {
    map.setLayoutProperty("search-frontier", "visibility", "none");
    map.setLayoutProperty("meet-point", "visibility", "none");
    map.setLayoutProperty("path-head", "visibility", "none");
    map.setFilter("sel-casing", null);
    map.setFilter("sel-line", null);
    setData("sel-progress", { type: "FeatureCollection", features: [] });
  }
}

function animateFrontier(
  trace: SearchTrace,
  durationMs: number,
  onDone: () => void,
) {
  let order = trace.order;
  let side = trace.side;
  if (order.length > MAX_FRONTIER_POINTS) {
    const sampleStep = Math.ceil(order.length / MAX_FRONTIER_POINTS);
    const sOrder: number[] = [];
    const sSide: number[] = [];
    for (let i = 0; i < order.length; i += sampleStep) {
      sOrder.push(order[i]!);
      sSide.push(side[i]!);
    }
    order = Int32Array.from(sOrder);
    side = Uint8Array.from(sSide);
  }

  const n = order.length;
  if (n === 0) {
    onDone();
    return;
  }
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    const node = order[i]!;
    features[i] = {
      type: "Feature" as const,
      properties: { idx: i, side: side[i]! },
      geometry: {
        type: "Point" as const,
        coordinates: [graph.lons[node]!, graph.lats[node]!],
      },
    };
  }
  setData("search-frontier", { type: "FeatureCollection", features });
  map.setLayoutProperty("search-frontier", "visibility", "visible");
  map.setFilter("search-frontier", ["<=", ["get", "idx"], -1]);

  const t0 = performance.now();
  let lastRevealed = -1;
  let lastUpdate = 0;
  function tick() {
    const now = performance.now();
    const raw = Math.min(1, (now - t0) / durationMs);
    const done = raw >= 1;
    const eased = easeOutCubic(raw);
    const revealed = Math.round(eased * (n - 1));
    if (
      revealed !== lastRevealed &&
      (done || now - lastUpdate >= FRONTIER_UPDATE_INTERVAL_MS)
    ) {
      map.setFilter("search-frontier", ["<=", ["get", "idx"], revealed]);
      lastRevealed = revealed;
      lastUpdate = now;
    }
    if (!done) {
      animFrameId = requestAnimationFrame(tick);
    } else {
      animFrameId = null;
      onDone();
    }
  }
  animFrameId = requestAnimationFrame(tick);
}

function animatePathDraw(durationMs: number, onDone: () => void) {
  const r = routes[selected];
  if (!r || r.path.length < 2) {
    onDone();
    return;
  }
  const segMult = segmentMultipliers(
    graph,
    model,
    r.path,
    hour,
    trafficOn,
    mode,
    r.edges,
  );
  const fc = selectedFC(Infinity, segMult);
  const segCount = fc.features.length; // = r.path.length - 1
  if (segCount === 0) {
    onDone();
    return;
  }

  // Reveal by distance travelled, not by hop count — otherwise a few long
  // edges (highway stretches) snap into view instantly while a cluster of
  // short intersection hops crawls, making the draw look uneven.
  const segLen = new Float64Array(segCount);
  const cumLen = new Float64Array(segCount);
  let acc = 0;
  for (let k = 1; k < r.path.length; k++) {
    const a = r.path[k - 1]!,
      b = r.path[k]!;
    const d = haversine(
      graph.lats[a]!,
      graph.lons[a]!,
      graph.lats[b]!,
      graph.lons[b]!,
    );
    segLen[k - 1] = d;
    acc += d;
    cumLen[k - 1] = acc;
  }
  const totalLen = acc || 1;

  const colorByTraffic = mode === "drive" && trafficOn;
  const colorFor = (segIdx: number) =>
    colorByTraffic ? congestionColor(segMult[segIdx] ?? 1) : BLUE;

  setData("sel", fc);
  map.setFilter("sel-casing", ["<=", ["get", "idx"], -1]);
  map.setFilter("sel-line", ["<=", ["get", "idx"], -1]);
  map.setLayoutProperty("path-head", "visibility", "visible");

  // Index of the last fully-revealed segment for a given travelled distance
  // (binary search over the monotonic cumulative-length array).
  function completedSegFor(target: number): number {
    let lo = 0,
      hi = segCount - 1,
      ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cumLen[mid]! <= target) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function finish() {
    map.setFilter("sel-casing", null);
    map.setFilter("sel-line", null);
    setData("sel-progress", { type: "FeatureCollection", features: [] });
    map.setLayoutProperty("path-head", "visibility", "none");
  }

  const t0 = performance.now();
  function tick() {
    const raw = Math.min(1, (performance.now() - t0) / durationMs);
    const eased = easeOutCubic(raw);
    const target = eased * totalLen;
    const completed = completedSegFor(target);
    const filter: maplibregl.FilterSpecification = [
      "<=",
      ["get", "idx"],
      completed,
    ];
    map.setFilter("sel-casing", filter);
    map.setFilter("sel-line", filter);

    const partialIdx = completed + 1;
    if (raw < 1 && partialIdx < segCount) {
      const segStart = completed >= 0 ? cumLen[completed]! : 0;
      const frac = clamp((target - segStart) / (segLen[partialIdx] || 1), 0, 1);
      const aNode = r.path[partialIdx]!,
        bNode = r.path[partialIdx + 1]!;
      const lon =
        graph.lons[aNode]! + (graph.lons[bNode]! - graph.lons[aNode]!) * frac;
      const lat =
        graph.lats[aNode]! + (graph.lats[bNode]! - graph.lats[aNode]!) * frac;
      const color = colorFor(partialIdx);
      setData("sel-progress", {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { color },
            geometry: {
              type: "LineString",
              coordinates: [
                [graph.lons[aNode]!, graph.lats[aNode]!],
                [lon, lat],
              ],
            },
          },
          {
            type: "Feature",
            properties: { color },
            geometry: { type: "Point", coordinates: [lon, lat] },
          },
        ],
      });
    } else {
      setData("sel-progress", { type: "FeatureCollection", features: [] });
    }

    if (raw < 1) {
      animFrameId = requestAnimationFrame(tick);
    } else {
      animFrameId = null;
      finish();
      onDone();
    }
  }
  animFrameId = requestAnimationFrame(tick);
}

function playRouteAnimation() {
  stopAnimation();
  const r = routes[selected];
  if (!mapReady || !lastTrace || !r) {
    renderRoutesOnMap();
    fitToRoute();
    return;
  }
  setData("alts", { type: "FeatureCollection", features: [] });
  setData("sel", { type: "FeatureCollection", features: [] });
  animating = true;
  syncResults();
  fitToRoute();

  const speed = getAnimSpeedMultiplier();
  const frontierMs = clamp(lastTrace.order.length * 0.6, 500, 3000) / speed;
  const pathMs = clamp(r.path.length * 8, 400, 1500) / speed;
  animateFrontier(lastTrace, frontierMs, () => {
    if (mapReady && !keepFrontier)
      map.setLayoutProperty("search-frontier", "visibility", "none");
    if (mapReady && lastMeetNode !== null) {
      setData("meet-point", {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: [
                graph.lons[lastMeetNode]!,
                graph.lats[lastMeetNode]!,
              ],
            },
          },
        ],
      });
      map.setLayoutProperty("meet-point", "visibility", "visible");
    }
    animatePathDraw(pathMs, () => {
      if (mapReady) map.setLayoutProperty("meet-point", "visibility", "none");
      renderRoutesOnMap();
      // Phones: now bring up the sheet and re-frame the route above it.
      animating = false;
      syncResults();
      if (!wide.matches) fitToRoute();
    });
  });
}

function renderAll() {
  renderFields();
  renderCards();
  renderSteps();
  renderRoutesOnMap();
}

function selectRoute(i: number) {
  if (i === selected || i < 0 || i >= routes.length) return;
  selected = i;
  renderCards();
  renderSteps();
  renderRoutesOnMap();
}

// Routing
function setHint(t: string) {
  $("hint").textContent = t;
}

// Lazily fetch the Contraction Hierarchies graph (~45 MB packed): most visits never turn traffic off.
let exportedNodes = 0;
let chRequested = false;
function ensureCH() {
  if (chRequested || exportedNodes === 0) return;
  chRequested = true;
  loadCH(exportedNodes).then((ch) => {
    if (!ch) return;
    chData = ch;
    chRouter = new CHRouter(ch);
    console.log(`[boot] CH ready: ${ch.n.toLocaleString()} nodes`);
    updateModeNote();
    if (startIdx !== null && endIdx !== null && mode === "drive" && !trafficOn) {
      recomputeFull();
    }
  });
}

function updateModeNote() {
  let text: string;
  if (mode !== "drive") {
    text = `${mode === "walk" ? "Walking" : "Cycling"} ignores traffic — a flat speed on every road.`;
  } else if (trafficOn) {
    text = "Bidir A* + ALT with live time-of-day traffic weights.";
    if (lastBidir)
      text += ` Bidir+ALT: ${lastBidir.settled.toLocaleString()} settled, ${lastBidir.queryMs.toFixed(1)} ms.`;
    else if (lastAstar)
      text += ` A*: ${lastAstar.settled.toLocaleString()} settled, ${lastAstar.queryMs.toFixed(1)} ms.`;
    text += altData ? "" : " ALT loading…";
  } else {
    // drive + trafficOff
    ensureCH();
    if (!chData) {
      text = "CH loading… A* running free-flow in the meantime.";
    } else if (lastCH) {
      text = `CH: ${lastCH.settled.toLocaleString()} settled, ${lastCH.queryMs.toFixed(2)} ms`;
      if (lastAstar)
        text += ` · A* ref: ${lastAstar.settled.toLocaleString()} settled, ${lastAstar.queryMs.toFixed(1)} ms`;
    } else {
      text = "Free-flow CH precomputed graph. Search or click the map.";
    }
  }
  $("modenote").textContent = text;
}

// Single WASM A* query wrapped as a RouteOption. Assumes weights are already
// filled for the desired scenario. Trims the synthetic arrival hop when the
// destination is a restriction-split via node.
function astarRouteOption(
  s: number,
  t: number,
  arrivalEnd: number | null,
): RouteOption | null {
  const r = router.route(s, arrivalEnd ?? t, modeHScale(mode));
  if (!r) return null;
  let { path, edges } = r;
  if (
    arrivalEnd !== null &&
    path.length >= 2 &&
    path[path.length - 1] === arrivalEnd
  ) {
    path = path.subarray(0, path.length - 1);
    edges = edges.subarray(0, edges.length - 1);
  }
  if (path.length < 2) return null;
  return {
    path,
    edges,
    etaSec: etaSeconds(r.cost),
    distanceM: pathDistanceMeters(graph, path, edges),
    nodesVisited: r.nodesVisited,
    queryMs: r.queryMs,
  };
}

// Full search incl. alternatives. Used on commit events (new endpoint, mode,
// traffic toggle, slider release). `animate: false` renders the result
// statically instead of replaying the search-frontier/path-draw animation —
// used on hour-slider release, where the route was already live-updated
// during the drag and a full replay would be jarring.
function recomputeFull(opts: { animate?: boolean } = {}) {
  const animate = opts.animate ?? true;
  if (startIdx === null || endIdx === null) {
    routes = [];
    lastTrace = null;
    lastMeetNode = null;
    renderAll();
    return;
  }

  if (startIdx === endIdx) {
    routes = [];
    lastTrace = null;
    lastMeetNode = null;
    setHint("Origin and destination are the same — choose different points.");
    renderAll();
    return;
  }

  const useCH = mode === "drive" && !trafficOn && chRouter !== null;
  const arrivalEnd = arrivalOf?.get(endIdx) ?? null;

  if (useCH) {
    const cr = chRouter!.query(startIdx, endIdx);
    // Run A* once (free-flow) — used both as the benchmark comparison and as
    // the restriction-aware fallback below (CH contraction has no turn-
    // restriction awareness; see ch.ts).
    fillWeights(router.weights, graph, model, hour, false, "drive");
    const ar = astarRouteOption(startIdx, endIdx, arrivalEnd);
    lastAstar = ar ? { settled: ar.nodesVisited, queryMs: ar.queryMs } : null;

    const chPath = cr ? new Int32Array(cr.path) : null;
    const chBlocked =
      chPath !== null && pathViolatesRestriction(restrictionsData, chPath);
    if (chPath && !chBlocked) {
      routes = [
        {
          path: chPath,
          edges: null, // CH edge ids live in its own edge space
          etaSec: etaSeconds(cr!.dist),
          distanceM: pathDistanceMeters(graph, chPath),
          nodesVisited: cr!.settled,
          queryMs: cr!.queryMs,
        },
      ];
      lastCH = { settled: cr!.settled, queryMs: cr!.queryMs };
    } else if (ar) {
      // CH crossed a forbidden turn (or found no path) — the A* result above
      // already respects restrictions, so show that instead.
      routes = [ar];
      lastCH = null;
    } else {
      routes = [];
      lastCH = null;
    }
    lastTrace = null; // CH has no frontier to animate
    lastMeetNode = null;
  } else if (mode === "drive" && trafficOn && rev !== null) {
    lastCH = null;
    const result = computeRoutesBidir(
      graph,
      rev,
      router.weights,
      altData,
      router.restrictions,
      model,
      startIdx,
      endIdx,
      hour,
      trafficOn,
      mode,
      undefined,
      true,
      arrivalEnd,
    );
    routes = result.options;
    lastTrace = result.trace;
    lastMeetNode = result.meetNode;
    const r = routes[0];
    lastBidir = r ? { settled: r.nodesVisited, queryMs: r.queryMs } : null;
    lastAstar = null;
  } else {
    lastCH = null;
    lastBidir = null;
    const result = computeRoutes(
      graph,
      router,
      model,
      startIdx,
      endIdx,
      hour,
      trafficOn,
      mode,
      mode !== "drive",
      arrivalEnd,
    );
    routes = result.options;
    lastTrace = result.trace;
    lastMeetNode = result.meetNode;
    const r = routes[0];
    lastAstar = r ? { settled: r.nodesVisited, queryMs: r.queryMs } : null;
  }

  selected = 0;
  setHint(
    routes.length
      ? `${routes.length} route${routes.length > 1 ? "s" : ""} found.`
      : "No route found — try other points.",
  );
  updateModeNote();
  renderFields();
  renderCards();
  renderSteps();
  updateAnimControls();
  if (routes.length > 0 && animate) {
    playRouteAnimation();
  } else {
    stopAnimation();
    renderRoutesOnMap();
    if (routes.length > 0) fitToRoute();
  }
}

// Single fastest route only, cheap enough to run live while dragging the slider.
function recomputePrimary() {
  if (startIdx === null || endIdx === null) return;
  stopAnimation();

  const useCH = mode === "drive" && !trafficOn && chRouter !== null;
  const arrivalEnd = arrivalOf?.get(endIdx) ?? null;

  if (useCH) {
    const cr = chRouter!.query(startIdx, endIdx);
    const chPath = cr ? new Int32Array(cr.path) : null;
    const chBlocked =
      chPath !== null && pathViolatesRestriction(restrictionsData, chPath);
    if (chPath && !chBlocked) {
      routes = [
        {
          path: chPath,
          edges: null,
          etaSec: etaSeconds(cr!.dist),
          distanceM: pathDistanceMeters(graph, chPath),
          nodesVisited: cr!.settled,
          queryMs: cr!.queryMs,
        },
      ];
      lastCH = { settled: cr!.settled, queryMs: cr!.queryMs };
    } else {
      // CH is restriction-unaware (see ch.ts) — fall back to A*, which respects
      // turn restrictions, when the CH path crosses a forbidden turn.
      fillWeights(router.weights, graph, model, hour, false, "drive");
      const ar = astarRouteOption(startIdx, endIdx, arrivalEnd);
      routes = ar ? [ar] : [];
      lastCH = null;
    }
  } else if (mode === "drive" && trafficOn && rev !== null) {
    // Run all 3 penalty iterations (same as recomputeFull) so the fastest route
    // found during drag always matches what release shows. Using 2 iterations was
    // insufficient: the optimal route can require iter 3 to surface when bidirRoute
    // raw-weight ordering and pathWeight re-score ordering disagree.
    const { options: primary } = computeRoutesBidir(
      graph,
      rev,
      router.weights,
      altData,
      router.restrictions,
      model,
      startIdx,
      endIdx,
      hour,
      trafficOn,
      mode,
      undefined,
      false,
      arrivalEnd,
    );
    routes = primary.length > 0 ? [primary[0]!] : [];
    const r0 = routes[0];
    if (r0) lastBidir = { settled: r0.nodesVisited, queryMs: r0.queryMs };
  } else {
    fillWeights(router.weights, graph, model, hour, trafficOn, mode);
    const r = astarRouteOption(startIdx, endIdx, arrivalEnd);
    routes = r ? [r] : [];
    if (r) lastAstar = { settled: r.nodesVisited, queryMs: r.queryMs };
  }

  selected = 0;
  renderAll();
}

let rafPending = false;
function scheduleDragRecompute() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    recomputePrimary();
  });
}

function updateCalcButton() {
  const btn = $("calc-route") as HTMLButtonElement;
  btn.disabled = startIdx === null || endIdx === null;
}

function setEndpoint(idx: number, label: string | null = null) {
  if (startIdx === null || (startIdx !== null && endIdx !== null)) {
    startIdx = idx;
    startLabel = label;
    endIdx = null;
    endLabel = null;
    routes = [];
    setMarker("origin", idx);
    setMarker("dest", null);
    setHint("Search or click the map to set the destination.");
    updateCalcButton();
    renderAll();
  } else {
    endIdx = idx;
    endLabel = label;
    setMarker("dest", idx);
    setHint("Ready — click 'Calculate Route' to find routes.");
    updateCalcButton();
    renderAll();
    fitToPoints();
  }
}

// Used by search: set a specific field without the state-machine reset.
function setEndpointDirect(
  which: "origin" | "dest",
  idx: number,
  label: string,
) {
  if (which === "origin") {
    startIdx = idx;
    startLabel = label;
    setMarker("origin", startIdx);
  } else {
    endIdx = idx;
    endLabel = label;
    setMarker("dest", endIdx);
  }
  if (startIdx !== null && endIdx !== null) {
    setHint("Ready — click 'Calculate Route' to find routes.");
    updateCalcButton();
    renderAll();
    fitToPoints();
  } else {
    setHint(
      startIdx === null
        ? "Search or click the map to set the origin."
        : "Search or click the map to set the destination.",
    );
    updateCalcButton();
    renderAll();
  }
}

function setMarker(which: "origin" | "dest", idx: number | null) {
  const ref = which === "origin" ? originMarker : destMarker;
  if (idx === null) {
    ref?.remove();
    if (which === "origin") originMarker = null;
    else destMarker = null;
    return;
  }
  const lngLat: [number, number] = [graph.lons[idx]!, graph.lats[idx]!];
  if (ref) {
    ref.setLngLat(lngLat);
    return;
  }
  const m = new maplibregl.Marker({
    color: which === "origin" ? "#34a853" : "#ea4335",
  })
    .setLngLat(lngLat)
    .addTo(map);
  if (which === "origin") originMarker = m;
  else destMarker = m;
}

function clearAll() {
  stopAnimation();
  startIdx = endIdx = null;
  startLabel = endLabel = null;
  routes = [];
  lastTrace = null;
  lastMeetNode = null;
  selected = 0;
  setMarker("origin", null);
  setMarker("dest", null);
  setHint("Search or click the map to set the origin.");
  updateCalcButton();
  updateAnimControls();
  renderAll();
}

function onMapClick(e: maplibregl.MapMouseEvent) {
  if (mapReady) {
    // Clicking an alternative line selects it instead of dropping a point.
    // Layers vanish briefly during a basemap fallback swap (see boot()), so
    // guard each query on the layer actually existing.
    const altHit = map.getLayer("alts")
      ? map.queryRenderedFeatures(e.point, { layers: ["alts"] })
      : [];
    const routeIdx = altHit[0]?.properties?.routeIdx;
    if (typeof routeIdx === "number") {
      selectRoute(routeIdx);
      return;
    }

    // Clicking a place sets that endpoint, snapped from the place's own coords.
    const placeHit = map.getLayer("place-poi")
      ? map.queryRenderedFeatures(e.point, { layers: ["place-poi"] })
      : [];
    const pIdx = placeHit[0]?.properties?.idx;
    if (typeof pIdx === "number" && places[pIdx]) {
      const p = places[pIdx];
      setEndpoint(
        nearestNode(graph, p.lat, p.lon, mode === "drive" ? 3 : 7),
        p.name,
      );
      return;
    }
  }
  setEndpoint(
    nearestNode(graph, e.lngLat.lat, e.lngLat.lng, mode === "drive" ? 3 : 7),
  );
}

// Search
const KIND_LABEL: Record<string, string> = {
  airport: "Airport",
  train: "Train station",
  lrt: "LRT station",
  bus: "Bus terminal",
  hospital: "Hospital",
  clinic: "Clinic",
  university: "University",
  school: "School",
  shopping: "Shopping",
  office: "Office",
  park: "Park",
  landmark: "Landmark",
  attraction: "Attraction",
  services: "Services",
  hotel: "Hotel",
  food: "Restaurant",
  bar: "Bar",
  worship: "Place of worship",
  area: "Area",
};

function nearestAreaName(lat: number, lon: number): string | null {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestD = Infinity;
  let bestName: string | null = null;
  for (const p of places) {
    if (p.kind !== "area") continue;
    const dlat = (p.lat - lat) * 111_000;
    const dlon = (p.lon - lon) * 111_000 * cosLat;
    const d = dlat * dlat + dlon * dlon;
    if (d < bestD) {
      bestD = d;
      bestName = p.name;
    }
  }
  return bestD < 4_000 * 4_000 ? bestName : null;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightMatch(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return escHtml(text);
  return (
    escHtml(text.slice(0, i)) +
    "<strong>" +
    escHtml(text.slice(i, i + q.length)) +
    "</strong>" +
    escHtml(text.slice(i + q.length))
  );
}

function wireSearch(inputId: "origin" | "dest", suggId: string) {
  const input = $(inputId) as HTMLInputElement;
  const sugg = $(suggId) as HTMLElement;
  let activeIdx = -1;
  let currentResults: Place[] = [];

  function positionSugg() {
    const rect = input.getBoundingClientRect();
    sugg.style.top = `${rect.bottom + 4}px`;
    sugg.style.left = `${rect.left}px`;
    sugg.style.width = `${rect.width}px`;
  }

  function close() {
    sugg.hidden = true;
    activeIdx = -1;
    currentResults = [];
  }

  function setActive(i: number) {
    sugg
      .querySelectorAll<HTMLElement>(".sugg-item")
      .forEach((el, j) => el.classList.toggle("active", j === i));
    activeIdx = i;
  }

  function selectSugg(i: number) {
    const p = currentResults[i];
    if (!p) return;
    input.value = p.name;
    close();
    setEndpointDirect(
      inputId,
      nearestNode(graph, p.lat, p.lon, mode === "drive" ? 3 : 7),
      p.name,
    );
  }

  function open(results: Place[], q: string) {
    currentResults = results;
    activeIdx = -1;
    sugg.innerHTML = "";
    results.forEach((p, i) => {
      const item = document.createElement("div");
      const location = p.addr ?? nearestAreaName(p.lat, p.lon);
      item.className = "sugg-item";
      item.innerHTML =
        `<span class="sugg-dot" style="background:${KIND_COLOR[p.kind as PlaceKind]}"></span>` +
        `<div class="sugg-text">` +
        `<div class="sugg-name">${highlightMatch(p.name, q)}</div>` +
        (location ? `<div class="sugg-addr">${escHtml(location)}</div>` : "") +
        `</div>` +
        `<span class="sugg-kind">${escHtml(KIND_LABEL[p.kind] ?? p.kind)}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectSugg(i);
      });
      sugg.appendChild(item);
    });
    if (results.length > 0) {
      positionSugg();
      sugg.hidden = false;
    } else {
      sugg.hidden = true;
    }
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) {
      close();
      return;
    }
    const ql = q.toLowerCase();
    const results = places
      .filter((p) => p.kind !== "area" && p.name.toLowerCase().includes(ql))
      .sort((a, b) => {
        const aS = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
        const bS = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return a.name.length - b.name.length;
      })
      .slice(0, 6);
    open(results, q);
  });

  input.addEventListener("keydown", (e) => {
    if (!currentResults.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, currentResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      selectSugg(activeIdx);
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });

  input.addEventListener("focus", () => {
    if (input.value) input.select();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      close();
      renderFields();
    }, 150);
  });
}

// Controls
function wireControls() {
  $("clear").addEventListener("click", clearAll);

  const settingsToggle = $("settings-toggle") as HTMLButtonElement;
  const settingsPanel = $("settings-panel");
  settingsToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsToggle.classList.toggle("active", !settingsPanel.hidden);
  });
  document.addEventListener("click", (e) => {
    if (
      !settingsPanel.hidden &&
      !settingsPanel.contains(e.target as Node) &&
      e.target !== settingsToggle
    ) {
      settingsPanel.hidden = true;
      settingsToggle.classList.remove("active");
    }
  });

  $("swap").addEventListener("click", () => {
    [startIdx, endIdx] = [endIdx, startIdx];
    [startLabel, endLabel] = [endLabel, startLabel];
    setMarker("origin", startIdx);
    setMarker("dest", endIdx);
    if (startIdx !== null && endIdx !== null) {
      recomputeFull();
    } else {
      setHint(
        startIdx === null
          ? "Click the map to set the origin."
          : "Click the map to set the destination.",
      );
      updateCalcButton();
      renderAll();
    }
  });

  document
    .querySelectorAll<HTMLButtonElement>("#modes button")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.dataset.mode as TravelMode;
        document
          .querySelectorAll("#modes button")
          .forEach((b) => b.classList.toggle("active", b === btn));
        ($("traffic") as HTMLInputElement).disabled = mode !== "drive";
        updateModeNote();
        recomputeFull();
      });
    });

  const hourInput = $("hour") as HTMLInputElement;
  hourInput.addEventListener("input", () => {
    hour = parseFloat(hourInput.value);
    $("hourval").textContent = formatClock(hour);
    scheduleDragRecompute();
  });
  hourInput.addEventListener("change", () => {
    updateTrafficOverlay();
    recomputeFull({ animate: false });
  });

  $("calc-route").addEventListener("click", () => {
    recomputeFull();
  });

  $("anim-replay").addEventListener("click", () => {
    if (lastTrace) playRouteAnimation();
  });

  const animSpeedInput = $("anim-speed") as HTMLInputElement;
  animSpeedInput.addEventListener("input", () => {
    $("animspeedval").textContent = `${getAnimSpeedMultiplier()}×`;
  });

  const stepsToggle = $("steps-toggle") as HTMLButtonElement;
  const stepsHost = $("steps");
  stepsToggle.addEventListener("click", () => {
    const expanded = stepsToggle.getAttribute("aria-expanded") === "true";
    stepsToggle.setAttribute("aria-expanded", String(!expanded));
    stepsHost.classList.toggle("collapsed", expanded);
  });

  const trafficInput = $("traffic") as HTMLInputElement;
  trafficInput.addEventListener("change", () => {
    trafficOn = trafficInput.checked;
    updateModeNote();
    recomputeFull();
  });

  const trafficOverlayInput = $("showtraffic") as HTMLInputElement;
  trafficOverlayInput.addEventListener("change", () => {
    if (!mapReady) return;
    map.setLayoutProperty(
      "traffic-overlay",
      "visibility",
      trafficOverlayInput.checked ? "visible" : "none",
    );
    if (trafficOverlayInput.checked && trafficOverlayDirty) {
      updateTrafficOverlay();
    }
  });

  const placesInput = $("showplaces") as HTMLInputElement;
  placesInput.addEventListener("change", () => {
    const vis = placesInput.checked ? "visible" : "none";
    if (!mapReady) return;
    for (const ly of ["place-poi", "area-labels"]) {
      map.setLayoutProperty(ly, "visibility", vis);
    }
  });

  const keepFrontierInput = $("keepfrontier") as HTMLInputElement;
  keepFrontierInput.addEventListener("change", () => {
    keepFrontier = keepFrontierInput.checked;
    // Turning it off mid-view should clear any dots left over from the
    // last animation rather than waiting for the next route calculation.
    if (!keepFrontier && mapReady) {
      map.setLayoutProperty("search-frontier", "visibility", "none");
    }
  });

  wireSearch("origin", "origin-sugg");
  wireSearch("dest", "dest-sugg");
}

// Phones: say once per visit that this is built for a desktop, and keep the heavy map overlay off by default.
const SMALL_SCREEN = "(max-width: 760px), (pointer: coarse) and (max-width: 1024px)";
function initMobileNote() {
  if (!matchMedia(SMALL_SCREEN).matches) return;
  // The traffic overlay is a lot of lines to draw; the checkbox in settings brings it back.
  ($("showtraffic") as HTMLInputElement).checked = false;

  const KEY = "route-sim-mobile-note";
  try {
    if (sessionStorage.getItem(KEY)) return;
  } catch {
    // storage blocked: just show it
  }
  const note = $("mobile-note");
  const close = () => {
    note.hidden = true;
    document.removeEventListener("keydown", onKey);
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      // ignore
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  $("mobile-note-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  note.hidden = false;
}

// Phones: the card is small, so let the map take the whole screen (toolbar stays on top, results become a sheet).
function initExpand() {
  const app = $("app");
  const btn = $("expand");
  const set = (on: boolean) => {
    app.classList.toggle("full", on);
    // Lock page scroll while full so swiping the sheet or map never moves the page behind it.
    document.documentElement.style.overflow = on ? "hidden" : "";
    document.body.style.overflow = on ? "hidden" : "";
    btn.textContent = on ? "⤡" : "⤢";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Exit full screen" : "Expand map to full screen");
    if (on) window.scrollTo(0, 0);
  };
  btn.addEventListener("click", () => set(!app.classList.contains("full")));

  // Top panel (toolbar + status) and bottom sheet (results) can each be hidden to see more map.
  const wire = (id: string, cls: string, label: string) => {
    const b = $(id);
    b.addEventListener("click", () => {
      const off = app.classList.toggle(cls);
      b.setAttribute("aria-pressed", String(off));
      b.setAttribute("aria-label", `${off ? "Show" : "Hide"} ${label}`);
      if (cls === "sheet-off" && !off) syncResults();
    });
  };
  wire("top-toggle", "top-off", "search panel");
  wire("sheet-toggle", "sheet-off", "route details");

  // The map's box changes whenever a panel hides or the card goes full screen.
  new ResizeObserver(() => map?.resize()).observe($("map"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && app.classList.contains("full")) set(false);
  });
  // Rotating or resizing past the phone breakpoint leaves full mode.
  matchMedia("(max-width: 760px)").addEventListener("change", (e) => {
    if (!e.matches && app.classList.contains("full")) set(false);
  });
}

async function boot() {
  initMobileNote();
  initExpand();
  // Kick off the places fetch immediately so it overlaps with the CPU-heavy
  // graph/restriction/router/model setup below instead of waiting behind it.
  const placesPromise = loadPlaces();

  setHint("Loading graph…");
  graph = await loadGraph((done, total) =>
    setHint(
      `Loading graph… ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (first visit only, then cached)`,
    ),
  );
  // Node count of the as-exported graph — alt.bin/ch.bin are indexed by it
  // (the restriction split below appends nodes, so graph.n moves past it).
  const exportedN = graph.n;
  restrictionsData = await loadRestrictions();
  // Bake turn restrictions into the topology: node-based A*/bidir searches are
  // then exactly correct without any restriction checks in their hot loops.
  const split = applyRestrictionSplit(graph, restrictionsData);
  if (split) {
    graph = split.graph;
    arrivalOf = split.arrivalOf;
    altRemap = split.altRemap;
    console.log(
      `[boot] restriction split: ${restrictionsData.viaCount} vias baked in (${graph.n.toLocaleString()} nodes, ${graph.e.toLocaleString()} edges)`,
    );
  }
  router = await initRouter(
    graph,
    split ? emptyRestrictions() : restrictionsData,
  );
  model = precompute(graph);
  rev = buildRevCSR(graph);
  initOverlayEdges();

  loadAlt(exportedN).then((a) => {
    if (!a) return;
    a.remap = altRemap;
    altData = a;
    console.log(`[boot] ALT ready: ${a.L} landmarks`);
    updateModeNote();
    if (startIdx !== null && endIdx !== null) recomputeFull();
  });

  // The CH graph (the biggest file) is only fetched once drive + traffic off is actually used
  // (see ensureCH): once ready, those queries switch from A* to CH automatically.
  exportedNodes = exportedN;
  updateModeNote();

  // Start the Web Worker that computes per-edge cbdFactor and edgeDot.
  // The worker runs in parallel with the rest of init; model updates when it
  // posts back, then routes and overlay are re-rendered.
  const worker = new Worker(
    new URL("./traffic-gen.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.postMessage({
    lats: graph.lats,
    lons: graph.lons,
    offsets: graph.offsets,
    targets: graph.targets,
    n: graph.n,
    e: graph.e,
  });
  worker.onmessage = (
    evt: MessageEvent<{ cbdFactor: Float64Array; edgeDot: Float64Array }>,
  ) => {
    const t0 = performance.now();
    model.cbdFactor = evt.data.cbdFactor;
    model.edgeDot = evt.data.edgeDot;
    worker.terminate();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(
      `[boot] BPR model ready (worker→main transfer+assign: ${ms} ms)`,
    );
    updateTrafficOverlay();
    if (startIdx !== null && endIdx !== null) recomputeFull();
    setHint(
      `${graph.n.toLocaleString()} nodes · traffic model ready (BPR in-browser). Search or click the map.`,
    );
  };

  places = await placesPromise;
  updateModeNote();

  const b = graph.bounds;
  map = new maplibregl.Map({
    container: "map",
    style: isDark() ? BASEMAP_DARK : BASEMAP_LIGHT,
    bounds: [
      [b.minLng, b.minLat],
      [b.maxLng, b.maxLat],
    ],
    fitBoundsOptions: {
      padding: { top: 24, bottom: 24, left: 24, right: 24 },
    },
    attributionControl: { compact: true },
  });
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "bottom-right",
  );

  let usedFallbackStyle = false;
  map.on("error", (e) => {
    // Style-load failures (e.g. cartocdn unreachable) surface here with no
    // sourceId; swap to the raster fallback once instead of leaving a blank map.
    if (usedFallbackStyle || (e as { sourceId?: string }).sourceId) return;
    const msg = String(e.error?.message ?? "");
    if (!/style\.json|Failed to fetch|ERR_TIMED_OUT/i.test(msg)) return;
    usedFallbackStyle = true;
    // map.setStyle() below tears down every custom source/layer/image; mark
    // not-ready until setupMapLayers() (style.load) rebuilds them so nothing
    // queries a layer mid-swap.
    mapReady = false;
    console.warn(
      "[map] primary basemap failed, falling back to raster OSM:",
      msg,
    );
    map.setStyle(BASEMAP_STYLE_FALLBACK as never);
  });

  let mapHandlersWired = false;

  // (Re)creates every custom source/layer/image. Idempotent so it can run
  // both on the initial style load and again after a basemap fallback swap
  // (map.setStyle wipes all sources/layers/images — see the "error" handler
  // above — so they must be rebuilt from scratch, not just once at boot).
  function setupMapLayers() {
    const firstSetup = !mapHandlersWired;
    const pal = palette(usedFallbackStyle ? false : isDark());

    // Category badge icons (place-<kind>) must be registered before the symbol
    // layer that references them. Already idempotent (checks map.hasImage).
    addPlaceIcons(map);
    if (!map.getSource("places")) {
      map.addSource("places", { type: "geojson", data: placesFC(places) });
    }

    // Traffic overlay: arterial roads (class 0-2) colored by congestion at the
    // selected departure hour. Sits below route lines; updated on slider release.
    // line-offset shifts each direction of a two-way road to its own right
    // side (Google-style dual carriageway) instead of both directions
    // painting on the exact same line and z-fighting arbitrarily.
    if (!map.getSource("traffic-overlay")) {
      map.addSource("traffic-overlay", {
        type: "geojson",
        data: buildTrafficOverlay(hour) as never,
      });
    }
    if (!map.getLayer("traffic-overlay")) {
      map.addLayer({
        id: "traffic-overlay",
        type: "line",
        source: "traffic-overlay",
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 3.5],
          "line-offset": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2.5],
          "line-opacity": 0.72,
        },
      });
    }

    if (!map.getSource("search-frontier")) {
      map.addSource("search-frontier", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer("search-frontier")) {
      map.addLayer({
        id: "search-frontier",
        type: "circle",
        source: "search-frontier",
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "case",
            ["==", ["get", "side"], 1],
            "#f9ab00",
            "#4285f4",
          ],
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1.5,
            16,
            3,
          ],
          "circle-opacity": 0.75,
        },
      });
    }

    if (!map.getSource("meet-point")) {
      map.addSource("meet-point", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer("meet-point")) {
      map.addLayer({
        id: "meet-point",
        type: "circle",
        source: "meet-point",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 7,
          "circle-color": "#673ab7",
          "circle-stroke-color": pal.casing,
          "circle-stroke-width": 2,
        },
      });
    }

    if (!map.getSource("alts")) {
      map.addSource("alts", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource("sel")) {
      map.addSource("sel", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    // Tracks the partial edge currently being drawn during animatePathDraw,
    // so the route grows continuously instead of snapping edge-by-edge.
    if (!map.getSource("sel-progress")) {
      map.addSource("sel-progress", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!map.getLayer("alts")) {
      map.addLayer({
        id: "alts",
        type: "line",
        source: "alts",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": pal.alt,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7],
          "line-opacity": 0.85,
        },
      });
    }
    if (!map.getLayer("sel-casing")) {
      map.addLayer({
        id: "sel-casing",
        type: "line",
        source: "sel",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": pal.casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 12],
        },
      });
    }
    if (!map.getLayer("sel-line")) {
      map.addLayer({
        id: "sel-line",
        type: "line",
        source: "sel",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 8],
        },
      });
    }
    if (!map.getLayer("sel-progress")) {
      map.addLayer({
        id: "sel-progress",
        type: "line",
        source: "sel-progress",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 8],
        },
      });
    }
    if (!map.getLayer("path-head")) {
      map.addLayer({
        id: "path-head",
        type: "circle",
        source: "sel-progress",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 7],
          "circle-color": pal.casing,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 3,
        },
      });
    }

    // Category badge + label (above the route). icon-allow-overlap is false so
    // badges declutter on collision; symbol-sort-key gives the bounded/iconic
    // kinds priority over the dense worship/food markers when they collide.
    if (!map.getLayer("place-poi")) {
      map.addLayer({
        id: "place-poi",
        type: "symbol",
        source: "places",
        minzoom: ZMIN,
        filter: poiFilter(ZMIN),
        layout: {
          "icon-image": ["concat", "place-", ["get", "kind"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.7, 16, 1],
          "icon-allow-overlap": false,
          "text-field": ["get", "name"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.7],
          "text-max-width": 9,
          "text-optional": true,
          "symbol-sort-key": [
            "match",
            ["get", "kind"],
            ["airport", "train", "lrt"],
            1,
            ["bus", "hospital"],
            2,
            [
              "university",
              "shopping",
              "office",
              "park",
              "landmark",
              "attraction",
            ],
            3,
            ["services", "hotel", "food"],
            4,
            ["clinic", "school", "bar", "worship"],
            5,
            3,
          ],
        },
        paint: {
          "text-color": pal.label,
          "text-halo-color": pal.halo,
          "text-halo-width": 1.4,
        },
      });
    }
    // Area/neighbourhood labels: text only, uppercase, no dot.
    if (!map.getLayer("area-labels")) {
      map.addLayer({
        id: "area-labels",
        type: "symbol",
        source: "places",
        minzoom: ZMIN,
        filter: areaFilter(ZMIN),
        layout: {
          "text-field": ["get", "name"],
          "text-transform": "uppercase",
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 13],
          "text-letter-spacing": 0.08,
          "text-max-width": 8,
        },
        paint: {
          "text-color": pal.area,
          "text-halo-color": pal.halo,
          "text-halo-width": 1.4,
        },
      });
    }

    // Map-level event listeners are independent of the style and survive a
    // setStyle() call, so they're wired once, not on every setup pass.
    if (!mapHandlersWired) {
      mapHandlersWired = true;
      map.on("click", onMapClick);
      map.on("zoom", () => applyZoomThinning());
      for (const ly of ["alts", "place-poi"]) {
        map.on("mouseenter", ly, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", ly, () => {
          map.getCanvas().style.cursor = "default";
        });
      }
    }

    // Restore layer visibility to match the current checkbox state — a fresh
    // style's layers default to visible regardless of what the user had set.
    map.setLayoutProperty(
      "traffic-overlay",
      "visibility",
      ($("showtraffic") as HTMLInputElement).checked ? "visible" : "none",
    );
    const placesVis = ($("showplaces") as HTMLInputElement).checked
      ? "visible"
      : "none";
    for (const ly of ["place-poi", "area-labels"]) {
      map.setLayoutProperty(ly, "visibility", placesVis);
    }

    mapReady = true;
    applyZoomThinning(true);
    renderRoutesOnMap();

    if (firstSetup) {
      setHint(
        `${graph.n.toLocaleString()} nodes loaded · computing traffic model… Search or click the map to set the origin.`,
      );
    }
  }

  map.on("style.load", setupMapLayers);

  // Follow the labs theme toggle: swap the basemap (a full rebuild, so style.load re-adds our layers).
  let shownDark = isDark();
  const syncTheme = () => {
    const d = isDark();
    if (d === shownDark || usedFallbackStyle) return;
    shownDark = d;
    mapReady = false;
    map.setStyle(d ? BASEMAP_DARK : BASEMAP_LIGHT, { diff: false });
  };
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  prefersLight.addEventListener("change", syncTheme);

  wireControls();
}

boot().catch((err) => {
  console.error(err);
  setHint(`Error: ${err.message}`);
});
