# routing-simulation

A Routing engine built from scratch and running entirely in the browser. No routing API, no server backend for the engine. Real OpenStreetMap data is compiled into a compact binary graph, and three shortest-path engines (WASM A*, bidirectional ALT, Contraction Hierarchies) compute routes, ETAs, and alternates client-side, on top of a deterministic time-of-day traffic model.

## Features

- **Click-to-route or place search** on a MapLibre GL basemap with origin/destination autocomplete over OSM places.
- **Three travel modes** — drive / walk / bike with mode-specific speeds.
- **Live traffic simulation**: a BPR volume-delay model computed in-browser in a Web Worker.
- **Departure-time slider** (00:00–23:30 in half-hour steps) — routes re-compute live while dragging, so you can watch the route flip corridors around rush hour.
- **Up to 3 alternate routes** via the edge-penalty method, each re-scored with honest (un-penalized) weights, with ETA, distance, and arrival clock.
- **Turn-by-turn directions** with maneuver glyphs and road names.
- **Search visualization**: the explored frontier is replayable as an animation, with an animated route draw and per-engine stats (nodes settled, query time).

## Routing engines

| Engine                      | Where it runs                                                                                             | Used for                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **A\***                     | AssemblyScript compiled to WASM; graph lives in linear memory, queries are "two indices in, one path out" | Walk/bike, and as the alternate-route generator   |
| **Bidirectional ALT with dynamic edge weights** | TypeScript; bidirectional A\* guided by landmark (ALT) lower bounds preprocessed offline | Drive with live traffic |
| **Contraction Hierarchies** | TypeScript query over an offline-contracted graph                                                         | Drive with traffic off (static free-flow weights) |

## Repository layout

```
assembly/     AssemblyScript A* core → compiled to build/release.wasm
src/          Node.js offline pipeline: PBF parsing, graph build, exports, benchmarks, verification
src/lib/      shared code: PBF parser, CSR graph, A*, CH contraction, heaps, road classes, traffic constants
web/          Vite + MapLibre GL front end (three routers, traffic model, directions, places)
web/public/   generated binary artifacts produced by the export scripts
data/         OSM .pbf extract
```

## Getting the OSM data

Download the **Java** extract map data from Geofabrik:

- **Latest:** <https://download.geofabrik.de/asia/indonesia/java.html> → `java-latest.osm.pbf` (~850 MB)
- Direct link: <https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf>

Place the file in `data/` and point `PBF_PATH` in `src/build-graph.ts` at it (the repo currently expects `data/java-260607.osm.pbf`, Geofabrik's dated 2026-06-07 build, any recent Java extract works).

The pipeline only keeps what falls inside the Jakarta bounding box (`JAKARTA_BBOX` in `src/build-graph.ts`, lat −6.40…−6.05, lng 106.65…107.00), which yields a graph of ~915 k nodes and ~1.78 M directed edges. To simulate a different city, download the matching Geofabrik extract and change the bounding box.

OSM data is © OpenStreetMap contributors, available under the [ODbL](https://www.openstreetmap.org/copyright).

## Getting started

Requires Node.js ≥ 20.6 and pnpm (auto-provisioned via `devEngines`).

```bash
pnpm install

# 1. Compile the AssemblyScript A* core to WASM
pnpm build:wasm

# 2. Parse the PBF and export the browser artifacts
#    → web/public/{graph.bin, restrictions.bin, names.json, places.json, meta.json}
#    (also copies release.wasm into web/public)
pnpm export:graph

# 3. Preprocess Contraction Hierarchies → web/public/ch.bin
pnpm export:ch

# 4. Preprocess ALT landmarks → web/public/alt.bin
pnpm export:alt

# 5. Run the web app
pnpm dev:web
```

Steps 3–4 are optional (slower first-time preprocessing); without them the app routes with WASM A\* only.

## Other scripts

| Script                                                                    | What it does                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm route`                                                              | Route between two hardcoded coordinates in Node, useful for quick engine sanity check       |
| `pnpm validate:as`                                                        | Compare the WASM A* against the reference TypeScript A*                                     |
| `pnpm test:ch`                                                            | Check CH query results against plain Dijkstra/A\*                                           |
| `pnpm ch:city`                                                            | Benchmark A\* vs CH query times across the city                                             |
| `pnpm gen:traffic`                                                        | Offline traffic generation (the browser now computes traffic itself; kept for verification) |
| `pnpm verify:traffic-data` / `verify:traffic-routing` / `inspect:traffic` | Sanity checks and inspection of the BPR traffic model                                       |
| `pnpm verify:restrictions`                                                | Verify turn-restriction handling across engines                                             |
| `pnpm build:web` / `preview:web`                                          | Production build of the web app → `dist-web/`                                               |
