// Turn-by-turn maneuver generation from a routed node path.
//
// An OSM way is split into many short edges (one per shape point), so a curving
// road is a run of edges sharing a street name with small per-edge angle. We
// collapse those into one "step" and only emit a new maneuver where the street
// name changes or the heading turns sharply, the same logic Google's directions
// list uses.

import { cheapestEdge, haversine, type Graph } from './graph.ts';

export type Maneuver =
  | 'depart' | 'continue'
  | 'slight-left' | 'left' | 'sharp-left'
  | 'slight-right' | 'right' | 'sharp-right'
  | 'uturn' | 'arrive';

export type Step = {
  type: Maneuver;
  text: string;
  street: string;
  distanceM: number;
};

const DEG = Math.PI / 180;

// Initial compass bearing a→b, degrees clockwise from north (0=N, 90=E).
function bearing(graph: Graph, a: number, b: number): number {
  const la1 = graph.lats[a]! * DEG, la2 = graph.lats[b]! * DEG;
  const dLon = (graph.lons[b]! - graph.lons[a]!) * DEG;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

// Signed turn angle, -180..180. Positive = clockwise (right), negative = left.
function turnAngle(from: number, to: number): number {
  let d = (to - from + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function compass(b: number): string { return COMPASS[Math.round(b / 45) % 8]!; }

function classify(turn: number): Maneuver {
  const a = Math.abs(turn);
  if (a < 20) return 'continue';
  if (a >= 165) return 'uturn';
  const sharp = a >= 120, slight = a < 45;
  if (turn > 0) return sharp ? 'sharp-right' : slight ? 'slight-right' : 'right';
  return sharp ? 'sharp-left' : slight ? 'slight-left' : 'left';
}

const TURN_LABEL: Record<Maneuver, string> = {
  'depart': 'Head', 'continue': 'Continue',
  'slight-left': 'Slight left', 'left': 'Turn left', 'sharp-left': 'Sharp left',
  'slight-right': 'Slight right', 'right': 'Turn right', 'sharp-right': 'Sharp right',
  'uturn': 'Make a U-turn', 'arrive': 'Arrive',
};

function streetName(graph: Graph, ei: number): string {
  const id = graph.nameIds[ei]!;
  return id === 0 ? '' : graph.names[id]!;
}

function instruction(type: Maneuver, street: string, b0: number): string {
  switch (type) {
    case 'depart': return `Head ${compass(b0)}${street ? ` on ${street}` : ''}`;
    case 'continue': return street ? `Continue on ${street}` : 'Continue straight';
    case 'arrive': return 'Arrive at your destination';
    case 'uturn': return `Make a U-turn${street ? ` onto ${street}` : ''}`;
    default: return `${TURN_LABEL[type]}${street ? ` onto ${street}` : ''}`;
  }
}

// Fold micro-steps (short unnamed jogs, common around complex junctions) into
// the previous step so the list reads like Google's, not every shape point.
const MIN_STEP_M = 30;
function mergeShort(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const st of steps) {
    const prev = out[out.length - 1];
    if (prev && st.type !== 'depart' && st.type !== 'arrive' && !st.street && st.distanceM < MIN_STEP_M) {
      prev.distanceM += st.distanceM; // drop the micro-maneuver, keep its distance
      continue;
    }
    out.push({ ...st });
  }
  return out;
}

// Build the step list for a path. Steps accumulate distance until the next
// maneuver; the final step is always "Arrive".
export function buildDirections(graph: Graph, path: Int32Array): Step[] {
  if (path.length < 2) return [];

  // Per-segment name + bearing.
  const m = path.length - 1;
  const segName: string[] = new Array(m);
  const segBearing = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = path[k]!, b = path[k + 1]!;
    const ei = cheapestEdge(graph, a, b);
    segName[k] = ei >= 0 ? streetName(graph, ei) : '';
    segBearing[k] = bearing(graph, a, b);
  }

  const steps: Step[] = [];
  let curStreet = segName[0]!;
  let curType: Maneuver = 'depart';
  let curDist = segDist(graph, path, 0);
  const b0 = segBearing[0]!;
  let prevBearing = b0;

  for (let k = 1; k < m; k++) {
    const turn = turnAngle(prevBearing, segBearing[k]!);
    const nameChanged = segName[k]! !== curStreet && !(segName[k] === '' && curStreet === '');
    const sharp = Math.abs(turn) >= 35;

    if (sharp || nameChanged) {
      steps.push({ type: curType, text: instruction(curType, curStreet, b0), street: curStreet, distanceM: curDist });
      curType = classify(turn);
      curStreet = segName[k]!;
      curDist = segDist(graph, path, k);
    } else {
      curDist += segDist(graph, path, k);
    }
    prevBearing = segBearing[k]!;
  }

  steps.push({ type: curType, text: instruction(curType, curStreet, b0), street: curStreet, distanceM: curDist });
  steps.push({ type: 'arrive', text: instruction('arrive', curStreet, 0), street: curStreet, distanceM: 0 });
  return mergeShort(steps);
}

function segDist(graph: Graph, path: Int32Array, k: number): number {
  const a = path[k]!, b = path[k + 1]!;
  return haversine(graph.lats[a]!, graph.lons[a]!, graph.lats[b]!, graph.lons[b]!);
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// The named road carrying the most distance, Google's "via Jl. ..." label.
export function primaryRoad(steps: Step[]): string {
  const byStreet = new Map<string, number>();
  for (const st of steps) {
    if (!st.street) continue;
    byStreet.set(st.street, (byStreet.get(st.street) ?? 0) + st.distanceM);
  }
  let best = '', bestD = -1;
  for (const [street, d] of byStreet) if (d > bestD) { bestD = d; best = street; }
  return best;
}

// A short maneuver glyph for the directions list.
export function maneuverGlyph(type: Maneuver): string {
  switch (type) {
    case 'depart': return '●';
    case 'continue': return '↑';
    case 'slight-left': return '↖';
    case 'left': return '↰';
    case 'sharp-left': return '↩';
    case 'slight-right': return '↗';
    case 'right': return '↱';
    case 'sharp-right': return '↪';
    case 'uturn': return '⟲';
    case 'arrive': return '◉';
  }
}
