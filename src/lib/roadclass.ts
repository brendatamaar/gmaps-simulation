// Road-class taxonomy for the export pipeline. Each kept OSM `highway=*` value
// maps to one of 8 class ids. That id is serialised per edge (one byte) so the
// browser can recover free-flow speed and the time-of-day congestion curve
// (see web/src/traffic.ts) without re-parsing OSM.

export const enum RoadClass {
  Motorway = 0,
  Trunk = 1,
  Primary = 2,
  Secondary = 3,
  Tertiary = 4,
  Residential = 5,
  Unclassified = 6,
  Service = 7,
}

const HIGHWAY_TO_CLASS: Record<string, RoadClass> = {
  motorway: RoadClass.Motorway, motorway_link: RoadClass.Motorway,
  trunk: RoadClass.Trunk, trunk_link: RoadClass.Trunk,
  primary: RoadClass.Primary, primary_link: RoadClass.Primary,
  secondary: RoadClass.Secondary, secondary_link: RoadClass.Secondary,
  tertiary: RoadClass.Tertiary, tertiary_link: RoadClass.Tertiary,
  residential: RoadClass.Residential,
  unclassified: RoadClass.Unclassified,
  service: RoadClass.Service,
};

// Unknown/empty falls back to Residential, a safe mid-range default; only kept
// classes reach here anyway (parser already filtered to HIGHWAY_KEEP).
export function roadClass(highway: string | undefined): RoadClass {
  if (highway === undefined) return RoadClass.Residential;
  return HIGHWAY_TO_CLASS[highway] ?? RoadClass.Residential;
}
