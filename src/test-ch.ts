// CH verified on a tiny hand-checkable graph.
// CH bugs are brutal on a city graph; prove the algorithm on 7 nodes first.
//
//        3 ── 7 ── 1 ── 1 ── 3
//   (0)──────(1)──────(2)──────(3)
//    │         ╲        │        │
//    5          1       2        1
//    │           ╲      │        │
//   (2)·······(via)····(3)──(4)──(5)──(6)
//
// We build the graph by hand, then check bidirectional Dijkstra and the full
// CH pipeline against a plain Dijkstra oracle for *every* node pair.

import { CHGraph, fromCSR, biDijkstra, chQuery, preprocess } from "./lib/ch.ts";
import { MinHeap } from "./lib/heap.ts";
import type { CSR } from "./lib/csr.ts";

// Undirected weighted edges (each becomes two directed CSR edges).
const N = 7;
const EDGES: Array<[number, number, number]> = [
  [0, 1, 3],
  [0, 2, 5],
  [1, 2, 1],
  [1, 3, 7],
  [2, 3, 2],
  [2, 5, 6],
  [3, 4, 1],
  [4, 5, 2],
  [4, 6, 4],
  [5, 6, 1],
];

// Build a CSR by hand from the undirected edge list.
function buildTinyCSR(): CSR {
  const adj: Array<Array<{ to: number; w: number }>> = Array.from(
    { length: N },
    () => [],
  );
  for (const [a, b, w] of EDGES) {
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }

  const offsets = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) offsets[i + 1] = offsets[i]! + adj[i]!.length;
  const e = offsets[N]!;
  const targets = new Int32Array(e);
  const distances = new Float64Array(e);
  for (let i = 0; i < N; i++) {
    const base = offsets[i]!;
    adj[i]!.forEach((edge, j) => {
      targets[base + j] = edge.to;
      distances[base + j] = edge.w;
    });
  }
  return {
    n: N,
    offsets,
    targets,
    distances,
    classes: new Uint8Array(e),
    nameIds: new Uint32Array(e),
    names: [""],
    nodeIds: [...Array(N).keys()],
    idToIndex: new Map([...Array(N).keys()].map((i) => [i, i])),
    lats: new Float64Array(N),
    lons: new Float64Array(N),
  };
}

// Plain Dijkstra oracle.
function dijkstra(csr: CSR, s: number, t: number): number {
  const dist = new Float64Array(csr.n).fill(Infinity);
  dist[s] = 0;
  const h = new MinHeap();
  h.push(s, 0);
  while (h.size > 0) {
    const { node: u, f } = h.pop()!;
    if (f > dist[u]!) continue;
    if (u === t) return dist[t]!;
    for (let e = csr.offsets[u]!; e < csr.offsets[u + 1]!; e++) {
      const v = csr.targets[e]!,
        nd = dist[u]! + csr.distances[e]!;
      if (nd < dist[v]!) {
        dist[v] = nd;
        h.push(v, nd);
      }
    }
  }
  return dist[t]!;
}

const originalEdge = new Set<string>();
for (const [a, b, w] of EDGES) {
  originalEdge.add(`${a}-${b}-${w}`);
  originalEdge.add(`${b}-${a}-${w}`);
}

function edgeWeight(a: number, b: number): number | null {
  for (const [x, y, w] of EDGES) {
    if ((x === a && y === b) || (x === b && y === a)) return w;
  }
  return null;
}

// Validate a returned path: endpoints correct, every hop an original edge, and
// the summed weight equals the claimed distance.
function checkPath(
  path: number[],
  s: number,
  t: number,
  dist: number,
): string | null {
  if (path[0] !== s) return `path starts at ${path[0]}, expected ${s}`;
  if (path[path.length - 1] !== t)
    return `path ends at ${path[path.length - 1]}, expected ${t}`;
  let sum = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const w = edgeWeight(path[i]!, path[i + 1]!);
    if (w === null)
      return `hop ${path[i]}→${path[i + 1]} is not an original edge`;
    sum += w;
  }
  if (Math.abs(sum - dist) > 1e-6) return `path weight ${sum} ≠ dist ${dist}`;
  return null;
}

const csr = buildTinyCSR();
const EPS = 1e-6;

// Hand-checked spot values (read them off the diagram):
//   0→6: 0-1-2-3-4-5-6 = 3+1+2+1+2+1 = 10  (vs 0-2-3-4-5-6 = 5+2+1+2+1 = 11)
//   0→4: 0-1-2-3-4     = 3+1+2+1     = 7
//   2→6: 2-3-4-5-6     = 2+1+2+1     = 6
const SPOT: Array<[number, number, number]> = [
  [0, 6, 10],
  [0, 4, 7],
  [2, 6, 6],
];
console.log("Hand-checked spot values:");
for (const [s, t, exp] of SPOT) {
  const got = dijkstra(csr, s, t);
  const ok = Math.abs(got - exp) < EPS;
  console.log(
    `  ${s}→${t}: oracle=${got}  expected=${exp}  ${ok ? "OK" : "MISMATCH"}`,
  );
  if (!ok) process.exit(1);
}

// Bidirectional Dijkstra matches the oracle for all pairs.
console.log("\nbidirectional Dijkstra vs oracle (all pairs):");
let fails = 0;
for (let s = 0; s < N; s++)
  for (let t = 0; t < N; t++) {
    const exp = dijkstra(csr, s, t);
    const g = fromCSR(csr);
    const r = biDijkstra(g, s, t);
    const got = r ? r.dist : Infinity;
    if (Math.abs(got - exp) > EPS) {
      console.log(`  FAIL ${s}→${t}: bi=${got} oracle=${exp}`);
      fails++;
      continue;
    }
    if (r && exp < Infinity) {
      const err = checkPath(r.path, s, t, exp);
      if (err) {
        console.log(`  FAIL ${s}→${t}: ${err}`);
        fails++;
      }
    }
  }
console.log(fails === 0 ? "  all pairs OK" : `  ${fails} failures`);

// Preprocess once, inspect shortcuts.
console.log("\nPreprocessing:");
const ch = fromCSR(csr);
const stats = preprocess(ch);
const origDirected = EDGES.length * 2;
const totalDirected = ch.out.reduce((a, l) => a + l.length, 0);
console.log(
  `  ranks assigned: ${[...ch.rank].every((r) => r >= 0) ? "all nodes" : "INCOMPLETE"}`,
);
console.log(`  original directed edges: ${origDirected}`);
console.log(`  shortcuts added:         ${stats.shortcuts}`);
console.log(`  augmented directed edges: ${totalDirected}`);
console.log(`  preprocessing time:       ${stats.ms.toFixed(2)} ms`);

// CH query matches the oracle for all pairs, paths unpack to originals.
console.log("\nCH query vs oracle (all pairs):");
fails = 0;
for (let s = 0; s < N; s++)
  for (let t = 0; t < N; t++) {
    const exp = dijkstra(csr, s, t);
    const r = chQuery(ch, s, t);
    const got = r ? r.dist : Infinity;
    if (Math.abs(got - exp) > EPS) {
      console.log(`  FAIL ${s}→${t}: ch=${got} oracle=${exp}`);
      fails++;
      continue;
    }
    if (r && exp < Infinity) {
      const err = checkPath(r.path, s, t, exp);
      if (err) {
        console.log(`  FAIL ${s}→${t}: ${err}`);
        fails++;
      }
    }
  }
console.log(
  fails === 0
    ? "  all pairs OK — paths unpack to original edges"
    : `  ${fails} failures`,
);

console.log(
  fails === 0 ? "\nTiny-graph checks PASSED" : "\nTiny-graph checks FAILED",
);
process.exit(fails === 0 ? 0 : 1);
