import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { loadGraph, nearestNode, type Graph } from "./graph.ts";
import { initRouter, type Router } from "./router.ts";
import { computeRoutes, type RouteOption } from "./routing.ts";
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
  pathDistanceMeters,
  type TrafficModel,
  type TravelMode,
} from "./traffic.ts";
import { loadPlaces, placesFC, ZMIN, type Place } from "./places.ts";
import { addPlaceIcons } from "./place-icons.ts";

// Light, label-rich CARTO Positron vector basemap: keyless, Google-ish tone.
const BASEMAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const BLUE = "#1a73e8";

const $ = (id: string) => document.getElementById(id)!;

let graph: Graph;
let router: Router;
let model: TrafficModel;
let map: maplibregl.Map;
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

let mode: TravelMode = "drive";
let hour = 8;
let trafficOn = true;

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

function selectedFC() {
  const r = routes[selected];
  if (!r) return { type: "FeatureCollection" as const, features: [] };
  const colorByTraffic = mode === "drive" && trafficOn;
  const segMult = segmentMultipliers(graph, r.path, hour, trafficOn, mode);
  const features = [];
  for (let k = 1; k < r.path.length; k++) {
    const a = r.path[k - 1]!,
      b = r.path[k]!;
    features.push({
      type: "Feature" as const,
      properties: {
        color: colorByTraffic ? congestionColor(segMult[k - 1] ?? 1) : BLUE,
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
// map fills in gradually, like Google.
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
  const o = $("origin"),
    d = $("dest");
  const ov = fmt(startIdx, startLabel),
    dv = fmt(endIdx, endLabel);
  o.textContent = ov ?? "Click the map to set origin";
  o.classList.toggle("empty", ov === null);
  d.textContent = dv ?? "Then click to set destination";
  d.classList.toggle("empty", dv === null);
}

function renderCards() {
  const host = $("routes");
  host.innerHTML = "";
  const best = routes[0]?.etaSec ?? 0;
  routes.forEach((r, i) => {
    const steps = buildDirections(graph, r.path);
    const via = primaryRoad(steps);
    const card = document.createElement("div");
    card.className = "route-card" + (i === selected ? " sel" : "");
    card.innerHTML =
      `<div class="eta" style="color:${i === 0 ? "#188038" : "#5f6368"}">${formatEta(r.etaSec)}</div>` +
      `<div class="meta"><b>${(r.distanceM / 1000).toFixed(1)} km</b>` +
      `${via ? ` · via ${via}` : ""}<br>arrive ${arrivalClock(hour, r.etaSec)}` +
      `${i === 0 && routes.length > 1 ? " · fastest" : ""}</div>`;
    card.addEventListener("click", () => selectRoute(i));
    host.appendChild(card);
  });
}

function renderSteps() {
  const host = $("steps");
  host.innerHTML = "";
  const r = routes[selected];
  if (!r) return;
  for (const st of buildDirections(graph, r.path)) {
    const row = document.createElement("div");
    row.className = "step";
    row.innerHTML =
      `<div class="g">${maneuverGlyph(st.type)}</div>` +
      `<div class="t">${st.text}</div>` +
      `<div class="d">${st.distanceM ? formatDistance(st.distanceM) : ""}</div>`;
    host.appendChild(row);
  }
}

function renderRoutesOnMap() {
  if (!mapReady) return;
  setData("alts", altsFC());
  setData("sel", selectedFC());
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

function updateModeNote() {
  $("modenote").textContent =
    mode !== "drive"
      ? `${mode === "walk" ? "Walking" : "Cycling"} ignores traffic — a flat speed on every road.`
      : trafficOn
        ? "A* over live time-of-day weights (the dynamic path). CH would be the static fast-path: precomputed, microsecond queries, but blind to traffic."
        : "Free-flow weights — the static answer a CH preprocess would bake in.";
}

// Full search incl. alternatives. Used on commit events (new endpoint, mode,
// traffic toggle, slider release).
function recomputeFull() {
  if (startIdx === null || endIdx === null) {
    routes = [];
    renderAll();
    return;
  }
  routes = computeRoutes(
    graph,
    router,
    model,
    startIdx,
    endIdx,
    hour,
    trafficOn,
    mode,
  );
  selected = 0;
  setHint(
    routes.length
      ? `${routes.length} route${routes.length > 1 ? "s" : ""} found.`
      : "No route found — try other points.",
  );
  renderAll();
}

// Single fastest route only, cheap enough to run live while dragging the slider.
// fillWeights leaves the true live weights in the buffer, so r.cost is the true
// cost and ETA is honest without a separate pathWeight pass.
function recomputePrimary() {
  if (startIdx === null || endIdx === null) return;
  fillWeights(router.weights, graph, model, hour, trafficOn, mode);
  const r = router.route(startIdx, endIdx);
  routes = r
    ? [
        {
          path: r.path,
          etaSec: etaSeconds(r.cost),
          distanceM: pathDistanceMeters(graph, r.path),
          nodesVisited: r.nodesVisited,
          queryMs: r.queryMs,
        },
      ]
    : [];
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

function setEndpoint(idx: number, label: string | null = null) {
  if (startIdx === null || (startIdx !== null && endIdx !== null)) {
    startIdx = idx;
    startLabel = label;
    endIdx = null;
    endLabel = null;
    routes = [];
    setMarker("origin", idx);
    setMarker("dest", null);
    setHint("Click the map to set the destination.");
    renderAll();
  } else {
    endIdx = idx;
    endLabel = label;
    setMarker("dest", idx);
    recomputeFull();
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
  startIdx = endIdx = null;
  startLabel = endLabel = null;
  routes = [];
  selected = 0;
  setMarker("origin", null);
  setMarker("dest", null);
  setHint("Click the map to set the origin.");
  renderAll();
}

function onMapClick(e: maplibregl.MapMouseEvent) {
  if (mapReady) {
    // Clicking an alternative line selects it instead of dropping a point.
    const altHit = map.queryRenderedFeatures(e.point, { layers: ["alts"] });
    const routeIdx = altHit[0]?.properties?.routeIdx;
    if (typeof routeIdx === "number") {
      selectRoute(routeIdx);
      return;
    }

    // Clicking a place sets that endpoint, snapped from the place's own coords.
    const placeHit = map.queryRenderedFeatures(e.point, {
      layers: ["place-poi"],
    });
    const pIdx = placeHit[0]?.properties?.idx;
    if (typeof pIdx === "number" && places[pIdx]) {
      const p = places[pIdx];
      setEndpoint(nearestNode(graph, p.lat, p.lon), p.name);
      return;
    }
  }
  setEndpoint(nearestNode(graph, e.lngLat.lat, e.lngLat.lng));
}

// Controls
function wireControls() {
  $("clear").addEventListener("click", clearAll);

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
  hourInput.addEventListener("change", recomputeFull); // settle on release w/ alternatives

  const trafficInput = $("traffic") as HTMLInputElement;
  trafficInput.addEventListener("change", () => {
    trafficOn = trafficInput.checked;
    updateModeNote();
    recomputeFull();
  });

  const placesInput = $("showplaces") as HTMLInputElement;
  placesInput.addEventListener("change", () => {
    const vis = placesInput.checked ? "visible" : "none";
    if (!mapReady) return;
    for (const ly of ["place-poi", "area-labels"]) {
      map.setLayoutProperty(ly, "visibility", vis);
    }
  });
}

async function boot() {
  setHint("Loading graph…");
  graph = await loadGraph();
  router = await initRouter(graph);
  model = precompute(graph);
  places = await loadPlaces();
  updateModeNote();

  const b = graph.bounds;
  map = new maplibregl.Map({
    container: "map",
    style: BASEMAP_STYLE,
    bounds: [
      [b.minLng, b.minLat],
      [b.maxLng, b.maxLat],
    ],
    fitBoundsOptions: {
      padding: { top: 40, bottom: 40, left: 400, right: 40 },
    },
    attributionControl: { compact: true },
  });
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "bottom-right",
  );

  map.on("load", () => {
    // Category badge icons (place-<kind>) must be registered before the symbol
    // layer that references them.
    addPlaceIcons(map);
    map.addSource("places", { type: "geojson", data: placesFC(places) });

    map.addSource("alts", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addSource("sel", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "alts",
      type: "line",
      source: "alts",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#9aa0a6",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 7],
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "sel-casing",
      type: "line",
      source: "sel",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 16, 12],
      },
    });
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

    // Category badge + label (above the route). icon-allow-overlap is false so
    // badges declutter on collision; symbol-sort-key gives the bounded/iconic
    // kinds priority over the dense worship/food markers when they collide.
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
          ["airport", "transit", "hospital"],
          1,
          ["shopping", "university", "landmark"],
          2,
          ["park", "hotel"],
          3,
          "worship",
          4,
          "food",
          5,
          3,
        ],
      },
      paint: {
        "text-color": "#3c4043",
        "text-halo-color": "#fff",
        "text-halo-width": 1.4,
      },
    });
    // Area/neighbourhood labels: text only, uppercase, no dot.
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
        "text-color": "#5f6368",
        "text-halo-color": "#fff",
        "text-halo-width": 1.4,
      },
    });

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

    mapReady = true;
    applyZoomThinning(true);
    renderRoutesOnMap();
    setHint(
      `${graph.n.toLocaleString()} nodes loaded. Click the map to set the origin.`,
    );
  });

  wireControls();
}

boot().catch((err) => {
  console.error(err);
  setHint(`Error: ${err.message}`);
});
