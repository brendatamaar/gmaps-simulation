// Loads the AssemblyScript A* module and drives it from the browser. The graph
// lives in WASM linear memory; JS writes it once after initGraph, then each
// query is "two indices in, one path out".

import type { Graph } from './graph.ts';

type WasmExports = {
  memory: WebAssembly.Memory;
  initGraph(n: number, e: number): void;
  getOffsetsPtr(): number;
  getTargetsPtr(): number;
  getDistPtr(): number;
  getLatsPtr(): number;
  getLonsPtr(): number;
  getPathPtr(): number;
  getPathLen(): number;
  getDistMeters(): number;
  getNodesVisited(): number;
  astar(startIdx: number, endIdx: number): number;
};

export type RouteResult = {
  path: Int32Array;      // node indices, start → end (copied out of WASM memory)
  cost: number;          // Σ edge weight (metres-equivalent; ÷MAX_SPEED ⇒ ETA seconds)
  nodesVisited: number;
  queryMs: number;
};

export type Router = {
  // Live view over the WASM weight buffer the A* reads. Write metres-equivalent
  // weights here (see traffic.fillWeights) before calling route().
  weights: Float64Array;
  route(startIdx: number, endIdx: number): RouteResult | null;
};

export async function initRouter(graph: Graph): Promise<Router> {
  // AssemblyScript's NativeMath compiles to imports from the `Math` namespace,
  // plus env.abort. Cast: the DOM `Imports` type doesn't model the `Math` object.
  const importObject = {
    env: {
      abort(_msg: number, _file: number, line: number, col: number): never {
        throw new Error(`AS abort at ${line}:${col}`);
      },
    },
    Math,
  } as unknown as WebAssembly.Imports;

  const res = await fetch('release.wasm');
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), importObject);
  const w = instance.exports as unknown as WasmExports;

  // Allocate all WASM buffers, then upload the CSR arrays. initGraph is the only
  // call that grows memory, so the buffer is stable for every subsequent query.
  w.initGraph(graph.n, graph.e);
  const buf = w.memory.buffer;
  new Int32Array(buf, w.getOffsetsPtr(), graph.n + 1).set(graph.offsets);
  new Int32Array(buf, w.getTargetsPtr(), graph.e).set(graph.targets);
  new Float64Array(buf, w.getLatsPtr(), graph.n).set(graph.lats);
  new Float64Array(buf, w.getLonsPtr(), graph.n).set(graph.lons);

  // initGraph is the only call that grows memory, so this view stays valid for
  // the lifetime of the page. The caller fills it with live weights per query.
  const weights = new Float64Array(buf, w.getDistPtr(), graph.e);
  weights.set(graph.distances); // sensible default until the traffic model loads

  return {
    weights,
    route(startIdx, endIdx) {
      const t0 = performance.now();
      const rc = w.astar(startIdx, endIdx);
      const queryMs = performance.now() - t0;
      if (rc !== 0) return null;
      const len = w.getPathLen();
      // .slice() copies out of WASM memory into a JS-owned array.
      const path = new Int32Array(w.memory.buffer, w.getPathPtr(), len).slice();
      return { path, cost: w.getDistMeters(), nodesVisited: w.getNodesVisited(), queryMs };
    },
  };
}
