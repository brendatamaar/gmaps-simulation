import path from 'path';
import { fileURLToPath } from 'url';
import { parsePbf } from './lib/parser.ts';
import { haversine } from './lib/geo.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PBF_PATH = path.join(__dirname, '../data/java-260607.osm.pbf');
const JAKARTA_BBOX = { minLat: -6.40, maxLat: -6.05, minLng: 106.65, maxLng: 107.00 };

export type Edge = { to: number; dist: number };
export type AdjList = Map<number, Edge[]>;

export type GraphResult = { adj: AdjList; nodes: Map<number, import('./lib/parser.ts').NodeCoord> };

export async function buildGraph(): Promise<GraphResult> {
  console.log('Parsing PBF...');
  const { nodes, ways } = await parsePbf(PBF_PATH, JAKARTA_BBOX);
  console.log(`  ${nodes.size.toLocaleString()} nodes, ${ways.length.toLocaleString()} ways`);

  console.log('Building adjacency list...');
  const adj: AdjList = new Map();

  function addEdge(from: number, to: number, dist: number) {
    let list = adj.get(from);
    if (!list) { list = []; adj.set(from, list); }
    list.push({ to, dist });
  }

  let edgeCount = 0;
  let skipped = 0;

  for (const way of ways) {
    const oneway = way.tags['oneway'];
    const forward = oneway === 'yes' || oneway === '1' || oneway === 'true';
    const reverse = oneway === '-1';

    for (let i = 0; i < way.refs.length - 1; i++) {
      const aId = way.refs[i]!;
      const bId = way.refs[i + 1]!;
      const a = nodes.get(aId);
      const b = nodes.get(bId);

      if (!a || !b) { skipped++; continue; }

      const dist = haversine(a.lat, a.lon, b.lat, b.lon);

      if (reverse) {
        addEdge(bId, aId, dist); edgeCount++;
      } else if (forward) {
        addEdge(aId, bId, dist); edgeCount++;
      } else {
        addEdge(aId, bId, dist); edgeCount++;
        addEdge(bId, aId, dist); edgeCount++;
      }
    }
  }

  console.log('\nGraph stats:');
  console.log(`  Nodes in graph:    ${adj.size.toLocaleString()}`);
  console.log(`  Total edges:       ${edgeCount.toLocaleString()}`);
  console.log(`  Avg edges/node:    ${(edgeCount / adj.size).toFixed(2)}`);
  console.log(`  Skipped segments:  ${skipped.toLocaleString()} (node outside bbox)`);

  return { adj, nodes };
}
