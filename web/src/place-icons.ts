// Category marker badges, generated at runtime and registered with the map.
//
// MapLibre's glyph server can't render emoji, so we build each badge on a 2D
// canvas instead: a colored circle (category color) + a white pictogram. The
// pictogram is an emoji recolored to a flat white silhouette via a `source-atop`
// fill, which sidesteps hand-drawing vector icons or hunting for monochrome
// Unicode for trains/beds/etc. Each badge is added as `place-<kind>`, referenced
// by the symbol layer's `icon-image`.

import type maplibregl from 'maplibre-gl';
import { KIND_COLOR, type PlaceKind } from './places.ts';

const KIND_GLYPH: Partial<Record<PlaceKind, string>> = {
  airport:    '✈',
  train:      '🚆',
  lrt:        '🚊',
  bus:        '🚌',
  hospital:   '✚',
  clinic:     '✚',  // same icon, different badge color (orange-red vs red)
  university: '🎓',
  school:     '🏫',
  shopping:   '🛍',
  office:     '🏢',
  park:       '🌳',
  landmark:   '★',
  attraction: '🎭',
  services:   '🏦',
  hotel:      '🛏',
  food:       '🍴',
  bar:        '🍺',
  worship:    '🛐',
};

const PIX = 2;           // render at 2× for crisp icons (passed as pixelRatio)
const D = 46;            // canvas size in device px → ~23 layout px
const C = D / 2;
const R = 17;            // badge radius
const FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif';

// A white silhouette of `glyph` on its own transparent canvas.
function whiteGlyph(glyph: string, fontPx: number): HTMLCanvasElement {
  const g = document.createElement('canvas');
  g.width = g.height = D;
  const gx = g.getContext('2d')!;
  gx.font = `${fontPx}px ${FONT}`;
  gx.textAlign = 'center';
  gx.textBaseline = 'middle';
  gx.fillText(glyph, C, C + 1);
  // Recolor whatever was drawn to flat white.
  gx.globalCompositeOperation = 'source-atop';
  gx.fillStyle = '#ffffff';
  gx.fillRect(0, 0, D, D);
  return g;
}

function badge(color: string, glyph: string): ImageData {
  const cv = document.createElement('canvas');
  cv.width = cv.height = D;
  const ctx = cv.getContext('2d')!;

  // Soft drop shadow under the filled circle.
  ctx.save();
  ctx.shadowColor = 'rgba(60,64,67,0.45)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(C, C, R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  // White ring.
  ctx.beginPath();
  ctx.arc(C, C, R, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // White pictogram. Star/cross are monochrome and read better a touch larger.
  const big = glyph === '★' || glyph === '✚';
  ctx.drawImage(whiteGlyph(glyph, big ? 24 : 20), 0, 0);

  return ctx.getImageData(0, 0, D, D);
}

// Build and register every category badge. Call inside map 'load', before the
// symbol layer that references the images.
export function addPlaceIcons(map: maplibregl.Map): void {
  for (const kind of Object.keys(KIND_GLYPH) as PlaceKind[]) {
    const id = `place-${kind}`;
    if (map.hasImage(id)) continue;
    map.addImage(id, badge(KIND_COLOR[kind], KIND_GLYPH[kind]!), { pixelRatio: PIX });
  }
}
