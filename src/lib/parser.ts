import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const OsmPbfParser = require('osm-pbf-parser');

export type NodeCoord = { lat: number; lon: number };
export type OsmWay = { id: number; refs: number[]; tags: Record<string, string> };
export type Bbox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

const HIGHWAY_KEEP = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'unclassified', 'service',
]);

export async function parsePbf(
  pbfPath: string,
  bbox: Bbox,
): Promise<{ nodes: Map<number, NodeCoord>; ways: OsmWay[] }> {
  const nodes = new Map<number, NodeCoord>();
  const ways: OsmWay[] = [];

  await new Promise<void>((resolve, reject) => {
    const parser = OsmPbfParser();

    parser.on('data', (items: any[]) => {
      for (const item of items) {
        if (item.type === 'node') {
          const { id, lat, lon } = item;
          if (
            lat >= bbox.minLat && lat <= bbox.maxLat &&
            lon >= bbox.minLng && lon <= bbox.maxLng
          ) {
            nodes.set(id, { lat, lon });
          }
        } else if (item.type === 'way') {
          const highway = item.tags?.highway;
          if (highway && HIGHWAY_KEEP.has(highway)) {
            ways.push({ id: item.id, refs: item.refs, tags: item.tags });
          }
        }
      }
    });

    parser.on('end', resolve);
    parser.on('error', reject);
    fs.createReadStream(pbfPath).pipe(parser);
  });

  return { nodes, ways: ways.filter(w => w.refs.some(id => nodes.has(id))) };
}
