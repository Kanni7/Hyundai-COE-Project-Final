/**
 * The simulated city's buildings, as 2-D footprints in world coordinates (x east, y north).
 * One seeded layout feeds both the 3D view (scene3d.ts) and the radar line-of-sight model
 * (sensors.ts), so what the viewer sees blocking the road is exactly what blocks the radar.
 */

import { ROAD_HALF_WIDTH } from './scenarios.ts';
import { mulberry32 } from './sensors.ts';

export interface Building {
  /** Footprint centre and extents along x / y (m). */
  cx: number;
  cy: number;
  w: number;
  d: number;
  h: number;
  /** Index into the renderer's facade palette. */
  facade: number;
  /** Faces the x-axis road (true) or the y-axis road. */
  alongX: boolean;
  sx: number;
  sy: number;
  /** Distance of the block along its road from the junction (m). */
  s: number;
}

/** Kerb edge and sidewalk width, shared with the road drawing in scene3d.ts. */
export const KERB = ROAD_HALF_WIDTH + 0.5;
export const SIDEWALK = 4;

function buildCity(): Building[] {
  const rand = mulberry32(7);
  const out: Building[] = [];
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    for (const alongX of [true, false]) {
      let s = KERB + SIDEWALK + 6;
      while (s < 360) {
        const w = 10 + rand() * 18;
        const d = 10 + rand() * 14;
        const h = 6 + rand() * (s < 120 ? 26 : 14);
        const set = KERB + SIDEWALK + 4 + rand() * 6;
        out.push({
          cx: alongX ? sx * (s + w / 2) : sx * (set + d / 2),
          cy: alongX ? sy * (set + d / 2) : sy * (s + w / 2),
          w: alongX ? w : d,
          d: alongX ? d : w,
          h,
          facade: Math.floor(rand() * 6),
          alongX, sx, sy, s,
        });
        s += w + 3 + rand() * 6;
      }
    }
  }
  return out;
}

export const BUILDINGS: readonly Building[] = buildCity();

/** True when segment a->b crosses no building footprint (slab test). Buildings are all taller than a radar mount. */
export function lineOfSight(ax: number, ay: number, bx: number, by: number, buildings: readonly Building[] = BUILDINGS): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  for (const b of buildings) {
    let t0 = 0;
    let t1 = 1;
    let hit = true;
    for (const [p, dp, lo, hi] of [[ax, dx, b.cx - b.w / 2, b.cx + b.w / 2], [ay, dy, b.cy - b.d / 2, b.cy + b.d / 2]]) {
      if (Math.abs(dp) < 1e-12) {
        if (p < lo || p > hi) { hit = false; break; }
        continue;
      }
      let ta = (lo - p) / dp;
      let tb = (hi - p) / dp;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit) return false;
  }
  return true;
}
