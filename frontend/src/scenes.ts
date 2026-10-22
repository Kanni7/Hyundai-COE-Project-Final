// Per-photo calibration. All coordinates are in the source image's natural pixels,
// so overlays line up exactly once the stage is scaled to the viewport.

import type { SceneId } from './types';
import { WHEEL } from './drawn/geometry';

export type XY = [number, number];
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }

export interface SceneConfig {
  id: SceneId;
  /** 'photo' = overlays on a photograph; 'drawn' = the cabin is rendered in SVG, the photo only shows through the glass. */
  kind: 'photo' | 'drawn';
  label: string;
  src: string;
  width: number;
  height: number;
  /** Horizontal anchor (0..1): when the viewport crops the sides, this point keeps its place on screen. */
  focusX: number;
  /** Columns [x0, x1] the default view fills the window width with (crops empty cabin at the sides). */
  frame?: [number, number];
  /** Lowest image row that should stay above the voice dock; a short window gives up sky instead. */
  keepAboveDock?: number;
  /** Region [x0, y0, x1, y1] the camera leans into when the driver focuses on the screen. */
  focus: [number, number, number, number];
  screen: { quad: [XY, XY, XY, XY]; ui: { w: number; h: number }; radius: number };
  cluster?: { speed: XY; info: XY; tint: Ellipse; arrows: [XY, XY] };
  climate:
    | { kind: 'lcd'; left: XY; right: XY; size: number }
    | { kind: 'chip'; at: XY; w: number; h: number };
  ambient: { clip: XY[]; threshold: number };
  vents: [number, number, number, number][];
  windshield: { clip: XY[]; holes: Ellipse[]; pivots: { x: number; y: number; len: number }[]; headlight?: Ellipse };
  hazard: XY;
  seat?: Ellipse;
  horn: { cx: number; cy: number; r: number };
}

const NIGHT: SceneConfig = {
  id: 'night',
  kind: 'photo',
  label: 'Night photo',
  src: '/images/verna-night.webp',
  width: 1933,
  height: 814,
  focusX: 0.74,
  // From the left dash vent to the driver's door: the passenger door and window carry nothing to use.
  frame: [620, 1933],
  focus: [985, 262, 1395, 480],
  screen: { quad: [[1022, 290], [1334, 293], [1331, 410], [1025, 406]], ui: { w: 1080, h: 404 }, radius: 18 },
  cluster: {
    speed: [1504, 362],
    info: [1682, 367],
    tint: { cx: 1590, cy: 365, rx: 168, ry: 62 },
    arrows: [[1478, 330], [1712, 330]],
  },
  climate: { kind: 'lcd', left: [1080, 527], right: [1212, 535], size: 13 },
  ambient: {
    clip: [[0, 310], [600, 300], [752, 252], [1884, 278], [1933, 278], [1933, 814], [0, 814]],
    threshold: 0.15,
  },
  vents: [
    [1000, 455, 1120, 456],
    [1170, 461, 1300, 463],
    [720, 410, 955, 413],
    [1830, 425, 1920, 428],
  ],
  windshield: {
    clip: [[600, 0], [1884, 0], [1884, 278], [1500, 268], [1000, 262], [752, 252]],
    holes: [
      { cx: 1572, cy: 465, rx: 243, ry: 226 },
      { cx: 1075, cy: 25, rx: 128, ry: 38 },
    ],
    pivots: [
      { x: 990, y: 295, len: 560 },
      { x: 1460, y: 300, len: 600 },
    ],
    headlight: { cx: 1320, cy: 262, rx: 560, ry: 55 },
  },
  hazard: [1147, 463],
  seat: { cx: 590, cy: 792, rx: 290, ry: 70 },
  horn: { cx: 1557, cy: 478, r: 66 },
};

export const SCENES: Record<SceneId, SceneConfig> = {
  // Traced from the night photo, so every calibrated coordinate carries over.
  live: {
    ...NIGHT,
    id: 'live',
    kind: 'drawn',
    label: 'Live cockpit',
    // Anchor on the steering wheel, so it keeps the same place in every window shape.
    focusX: WHEEL.cx / 1933,
    // Gear lever and console keys
    keepAboveDock: 700,
    // The drawn screen is a little narrower than the photographed one, with a slimmer bezel, and
    // sits level on the centre-stack axis (x 1146) above the vents and climate panel.
    screen: { quad: [[996, 292], [1296, 292], [1296, 404], [996, 404]], ui: { w: 1080, h: 404 }, radius: 16 },
    focus: [941, 262, 1351, 480],
    vents: [[1000, 456, 1120, 456], [1172, 456, 1292, 456], NIGHT.vents[2], NIGHT.vents[3]],
    windshield: { ...NIGHT.windshield, holes: [{ cx: WHEEL.cx, cy: WHEEL.cy, rx: WHEEL.rx, ry: WHEEL.ry }, NIGHT.windshield.holes[1]] },
  },
  night: NIGHT,
  day: {
    id: 'day',
    kind: 'photo',
    label: 'Day photo',
    src: '/images/verna-interior-dashboard.avif',
    width: 1600,
    height: 580,
    focusX: 0.62,
    focus: [690, 120, 1040, 345],
    screen: { quad: [[722, 166], [1000, 148], [1000, 287], [722, 302]], ui: { w: 900, h: 440 }, radius: 14 },
    climate: { kind: 'chip', at: [838, 384], w: 72, h: 16 },
    ambient: {
      clip: [[0, 200], [1040, 135], [1360, 150], [1600, 200], [1600, 580], [0, 580]],
      threshold: 0.45,
    },
    vents: [
      [100, 372, 300, 372],
      [715, 338, 792, 334],
      [862, 322, 998, 312],
    ],
    windshield: {
      clip: [[85, 0], [1275, 0], [1300, 40], [1240, 128], [1000, 130], [700, 150], [400, 165], [85, 192]],
      holes: [{ cx: 1205, cy: 300, rx: 158, ry: 206 }],
      pivots: [
        { x: 560, y: 200, len: 520 },
        { x: 1000, y: 185, len: 560 },
      ],
    },
    hazard: [822, 328],
    horn: { cx: 1195, cy: 290, r: 50 },
  },
};
