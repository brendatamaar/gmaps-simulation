import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { loadGraph, nearestNode, type Graph } from "./graph.ts";
import { initRouter, type Router } from "./router.ts";
import { computeRoutes, computeRoutesBidir, type RouteOption } from "./routing.ts";
import { buildRevCSR, type RevCSR } from "./bidir-router.ts";
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

// Light, label-rich CARTO Positron vector basemap: keyless, Google-ish tone.
const BASEMAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
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

let mode: TravelMode = "drive";
let hour = 8;
let trafficOn = true;

// ── Traffic overlay ───────────────────────────────────────────
// Scans all edges once and stores the indices of arterials (class 0–2:
// motorway, trunk, primary). ~100K edges in Jakarta — fast to iterate later.
function initOverlayEdges() {
  const { n, offsets, classes } = graph;
  const froms: number[] = [], eis: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let ei = offsets[i]!; ei < offsets[i + 1]!; ei++) {
      if (classes[ei]! <= 2) { froms.push(i); eis.push(ei); }
    }
  }
  overlayFroms = new Int32Array(froms);
  overlayEis   = new Int32Array(eis);
}

// Build a GeoJSON FeatureCollection of arterial edges colored by congestion.
// Called on initial load and on every slider-release (change event).
// Uses edgeCongestionMult() which falls back to the static model until the
// Web Worker delivers cbdFactor/edgeDot.
function buildTrafficOverlay(h: number): object {
  if (!overlayFroms || !overlayEis) {
    return { type: "FeatureCollection", features: [] };
  }
  const { lats, lons, targets, classes } = graph;
  const count = overlayEis.length;
  const features = new Array(count);
  for (let k = 0; k < count; k++) {
    const i = overlayFroms[k]!, ei = overlayEis[k]!, j = targets[ei]!;
    const mult = edgeCongestionMult(model, ei, classes[ei]!, h);
    features[k] = {
      type: "Feature",
      properties: { color: congestionColor(mult) },
      geometry: {
        type: "LineString",
        coordinates: [[lons[i]!, lats[i]!], [lons[j]!, lats[j]!]],
      },
    };
  }
  return { type: "FeatureCollection", features };
}

function updateTrafficOverlay() {
  if (!mapReady || !overlayFroms) return;
  (map.getSource("traffic-overlay") as maplibregl.GeoJSONSource | undefined)
    ?.setData(buildTrafficOverlay(hour) as never);
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

function selectedFC() {
  const r = routes[selected];
  if (!r) return { type: "FeatureCollection" as const, features: [] };
  const colorByTraffic = mode === "drive" && trafficOn;
  const segMult = segmentMultipliers(graph, model, r.path, hour, trafficOn, mode);
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

function renderCards() {
  const host = $("routes");
  host.innerHTML = "";
  const best = routes[0]?.etaSec ?? 0;
  routes.forEach((r, i) => {
    const steps = buildDirections(graph, r.path);
    const via = primaryRoad(steps);
    const card = document.createElement("div");
    const classes = ["route-card"];
    if (i === 0) classes.push("fastest");
    if (i === selected) classes.push("sel");
    card.className = classes.join(" ");
    card.innerHTML =
      `<div class="eta" style="color:${i === 0 ? "#188038" : "#5f6368"}">${formatEta(r.etaSec)}</div>` +
      `<div class="meta"><b>${(r.distanceM / 1000).toFixed(1)} km</b>` +
      `${via ? ` · via ${escHtml(via)}` : ""}<br>arrive ${arrivalClock(hour, r.etaSec)}` +
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
      `<div class="t">${escHtml(st.text)}</div>` +
      `<div class="d">${st.distanceM ? formatDistance(st.distanceM) : ""}</div>`;
    host.appendChild(row);
  }
}

function renderRoutesOnMap() {
  if (!mapReady) return;
  setData("alts", altsFC());
  setData("sel", selectedFC());
  // Dim the overlay while a route is shown so the route line stands out.
  // Restores automatically when the route is cleared.
  map.setPaintProperty(
    "traffic-overlay",
    "line-opacity",
    routes.length > 0 ? 0.12 : 0.72,
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
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    { padding: { top: 60, bottom: 60, left: 400, right: 60 }, duration: 800 },
  );
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
  let text: string;
  if (mode !== "drive") {
    text = `${mode === "walk" ? "Walking" : "Cycling"} ignores traffic — a flat speed on every road.`;
  } else if (trafficOn) {
    text = "Bidir A* + ALT with live time-of-day traffic weights.";
    if (lastBidir) text += ` Bidir+ALT: ${lastBidir.settled.toLocaleString()} settled, ${lastBidir.queryMs.toFixed(1)} ms.`;
    else if (lastAstar) text += ` A*: ${lastAstar.settled.toLocaleString()} settled, ${lastAstar.queryMs.toFixed(1)} ms.`;
    text += altData ? "" : " ALT loading…";
    text += " CH disabled (stale under live traffic).";
  } else {
    // drive + trafficOff
    if (!chData) {
      text = "CH loading… A* running free-flow in the meantime.";
    } else if (lastCH) {
      text = `CH: ${lastCH.settled.toLocaleString()} settled, ${lastCH.queryMs.toFixed(2)} ms`;
      if (lastAstar) text += ` · A* ref: ${lastAstar.settled.toLocaleString()} settled, ${lastAstar.queryMs.toFixed(1)} ms`;
    } else {
      text = "Free-flow CH precomputed graph. Search or click the map.";
    }
  }
  $("modenote").textContent = text;
}

// Full search incl. alternatives. Used on commit events (new endpoint, mode,
// traffic toggle, slider release).
function recomputeFull() {
  if (startIdx === null || endIdx === null) {
    routes = [];
    renderAll();
    return;
  }

  if (startIdx === endIdx) {
    routes = [];
    setHint("Origin and destination are the same — choose different points.");
    renderAll();
    return;
  }

  const useCH = mode === "drive" && !trafficOn && chRouter !== null;

  if (useCH) {
    const cr = chRouter!.query(startIdx, endIdx);
    if (cr) {
      const path = new Int32Array(cr.path);
      routes = [{
        path,
        etaSec: etaSeconds(cr.dist),
        distanceM: pathDistanceMeters(graph, path),
        nodesVisited: cr.settled,
        queryMs: cr.queryMs,
      }];
      lastCH = { settled: cr.settled, queryMs: cr.queryMs };
      // Run A* once (free-flow) for benchmark comparison.
      fillWeights(router.weights, graph, model, hour, false, "drive");
      const ar = router.route(startIdx, endIdx);
      lastAstar = ar ? { settled: ar.nodesVisited, queryMs: ar.queryMs } : null;
    } else {
      routes = [];
      lastCH = null;
      lastAstar = null;
    }
  } else if (mode === "drive" && trafficOn && rev !== null) {
    lastCH = null;
    routes = computeRoutesBidir(graph, rev, router.weights, altData, router.restrictions, model, startIdx, endIdx, hour, trafficOn, mode);
    const r = routes[0];
    lastBidir = r ? { settled: r.nodesVisited, queryMs: r.queryMs } : null;
    lastAstar = null;
  } else {
    lastCH = null;
    lastBidir = null;
    routes = computeRoutes(graph, router, model, startIdx, endIdx, hour, trafficOn, mode);
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
  renderAll();
  if (routes.length > 0) fitToRoute();
}

// Single fastest route only, cheap enough to run live while dragging the slider.
function recomputePrimary() {
  if (startIdx === null || endIdx === null) return;

  const useCH = mode === "drive" && !trafficOn && chRouter !== null;

  if (useCH) {
    const cr = chRouter!.query(startIdx, endIdx);
    if (cr) {
      const path = new Int32Array(cr.path);
      routes = [{
        path,
        etaSec: etaSeconds(cr.dist),
        distanceM: pathDistanceMeters(graph, path),
        nodesVisited: cr.settled,
        queryMs: cr.queryMs,
      }];
      lastCH = { settled: cr.settled, queryMs: cr.queryMs };
    } else {
      routes = [];
    }
  } else if (mode === "drive" && trafficOn && rev !== null) {
    // Run all 3 penalty iterations (same as recomputeFull) so the fastest route
    // found during drag always matches what release shows. Using 2 iterations was
    // insufficient: the optimal route can require iter 3 to surface when bidirRoute
    // raw-weight ordering and pathWeight re-score ordering disagree.
    const primary = computeRoutesBidir(
      graph, rev, router.weights, altData, router.restrictions, model,
      startIdx, endIdx, hour, trafficOn, mode,
    );
    routes = primary.length > 0 ? [primary[0]!] : [];
    const r0 = routes[0];
    if (r0) lastBidir = { settled: r0.nodesVisited, queryMs: r0.queryMs };
  } else {
    fillWeights(router.weights, graph, model, hour, trafficOn, mode);
    const r = router.route(startIdx, endIdx, modeHScale(mode));
    routes = r
      ? [{
          path: r.path,
          etaSec: etaSeconds(r.cost),
          distanceM: pathDistanceMeters(graph, r.path),
          nodesVisited: r.nodesVisited,
          queryMs: r.queryMs,
        }]
      : [];
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
    renderAll();
  } else {
    endIdx = idx;
    endLabel = label;
    setMarker("dest", idx);
    recomputeFull();
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
    recomputeFull();
  } else {
    setHint(
      startIdx === null
        ? "Search or click the map to set the origin."
        : "Search or click the map to set the destination.",
    );
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
  startIdx = endIdx = null;
  startLabel = endLabel = null;
  routes = [];
  selected = 0;
  setMarker("origin", null);
  setMarker("dest", null);
  setHint("Search or click the map to set the origin.");
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
      setEndpoint(nearestNode(graph, p.lat, p.lon, mode === 'drive' ? 3 : 7), p.name);
      return;
    }
  }
  setEndpoint(nearestNode(graph, e.lngLat.lat, e.lngLat.lng, mode === 'drive' ? 3 : 7));
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
    setEndpointDirect(inputId, nearestNode(graph, p.lat, p.lon, mode === 'drive' ? 3 : 7), p.name);
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
    recomputeFull();
    updateTrafficOverlay();
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
  });


  const placesInput = $("showplaces") as HTMLInputElement;
  placesInput.addEventListener("change", () => {
    const vis = placesInput.checked ? "visible" : "none";
    if (!mapReady) return;
    for (const ly of ["place-poi", "area-labels"]) {
      map.setLayoutProperty(ly, "visibility", vis);
    }
  });

  wireSearch("origin", "origin-sugg");
  wireSearch("dest", "dest-sugg");
}

async function boot() {
  setHint("Loading graph…");
  graph = await loadGraph();
  router = await initRouter(graph);
  model = precompute(graph);
  rev = buildRevCSR(graph);
  initOverlayEdges();

  loadAlt().then(a => {
    if (!a) return;
    altData = a;
    console.log(`[boot] ALT ready: ${a.L} landmarks`);
    updateModeNote();
    if (startIdx !== null && endIdx !== null) recomputeFull();
  });

  // Load CH precomputed graph in the background — once ready, drive+trafficOff
  // queries switch from A* to CH automatically.
  loadCH().then(ch => {
    if (!ch) return;
    chData   = ch;
    chRouter = new CHRouter(ch);
    console.log(`[boot] CH ready: ${ch.n.toLocaleString()} nodes`);
    updateModeNote();
    if (startIdx !== null && endIdx !== null && mode === "drive" && !trafficOn) {
      recomputeFull();
    }
  });

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
  worker.onmessage = (evt: MessageEvent<{ cbdFactor: Float64Array; edgeDot: Float64Array }>) => {
    const t0 = performance.now();
    model.cbdFactor = evt.data.cbdFactor;
    model.edgeDot   = evt.data.edgeDot;
    worker.terminate();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`[boot] BPR model ready (worker→main transfer+assign: ${ms} ms)`);
    updateTrafficOverlay();
    if (startIdx !== null && endIdx !== null) recomputeFull();
    setHint(
      `${graph.n.toLocaleString()} nodes · traffic model ready (BPR in-browser). Search or click the map.`,
    );
  };

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

    // Traffic overlay: arterial roads (class 0-2) colored by congestion at the
    // selected departure hour. Sits below route lines; updated on slider release.
    map.addSource("traffic-overlay", {
      type: "geojson",
      data: buildTrafficOverlay(hour) as never,
    });
    map.addLayer({
      id: "traffic-overlay",
      type: "line",
      source: "traffic-overlay",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 3.5],
        "line-opacity": 0.72,
      },
    });

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
      `${graph.n.toLocaleString()} nodes loaded · computing traffic model… Search or click the map to set the origin.`,
    );
  });

  wireControls();
}

boot().catch((err) => {
  console.error(err);
  setHint(`Error: ${err.message}`);
});
