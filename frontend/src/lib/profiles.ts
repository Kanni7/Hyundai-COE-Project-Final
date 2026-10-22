// Driver profiles: who drives, their body size, and what they like. Seat and steering position follow from
// body height (fitFor), the way a memory seat is set once per driver: a shorter driver sits higher (to see
// over the dashboard) and further forward (to reach the pedals), with the wheel lower and closer.

import type { AmbientColor, DriveMode, ProfileId } from '../types';

export interface Profile {
  id: ProfileId;
  name: string;
  heightCm: number;
  weightKg: number;
  build: string;
  /** Backrest angle from vertical, a personal preference. */
  reclineDeg: number;
  accent: string;
  prefs: { temp: number; ambient: AmbientColor; driveMode: DriveMode };
}

export const PROFILES: Record<ProfileId, Profile> = {
  priya: { id: 'priya', name: 'Priya', heightCm: 152, weightKg: 48, build: 'Petite', reclineDeg: 14, accent: '#ff4fa8',
    prefs: { temp: 24, ambient: 'pink', driveMode: 'eco' } },
  meera: { id: 'meera', name: 'Meera', heightCm: 164, weightKg: 62, build: 'Average, sits upright', reclineDeg: 12, accent: '#ffb84d',
    prefs: { temp: 23, ambient: 'gold', driveMode: 'normal' } },
  rohan: { id: 'rohan', name: 'Rohan', heightCm: 176, weightKg: 74, build: 'Average', reclineDeg: 18, accent: '#34e07a',
    prefs: { temp: 22, ambient: 'green', driveMode: 'normal' } },
  aarav: { id: 'aarav', name: 'Aarav', heightCm: 190, weightKg: 88, build: 'Tall, long legs', reclineDeg: 20, accent: '#3d8bff',
    prefs: { temp: 20, ambient: 'blue', driveMode: 'sport' } },
};
export const PROFILE_IDS = Object.keys(PROFILES) as ProfileId[];

/** Memory-seat travel of a mid-size sedan. */
export const SEAT_LIFT_MM = 70;
export const SEAT_SLIDE_MM = 260;
export const WHEEL_REACH_MM = 60;

/** Side-view cabin geometry in cm: x rearward from the accelerator, y up from the floor. */
export const CABIN = {
  pedal: { x: 0, y: 14 },
  /** Hip (H-point) with the seat fully forward and down. */
  hip: { x: 76, y: 26 },
  /** Steering column pivot and length with the column fully in. */
  column: { x: 16, y: 48, length: 44 },
};

/** Body segments as fractions of standing height (adult anthropometric averages). */
export const body = (heightCm: number) => ({
  leg: 0.555 * heightCm, // hip to sole
  thigh: 0.255 * heightCm,
  torso: 0.29 * heightCm, // hip to shoulder
  head: 0.13 * heightCm, // shoulder to eye
  upperArm: 0.19 * heightCm,
  forearm: 0.17 * heightCm, // elbow to grip
});

export interface Fit {
  /** Seat raised above its lowest point. */
  liftMm: number;
  /** Seat moved back from its forward-most point. */
  slideMm: number;
  reclineDeg: number;
  /** Steering column angle above horizontal (tilt). */
  wheelTiltDeg: number;
  /** Steering pulled out towards the driver (telescope). */
  wheelReachMm: number;
  heightCm: number;
}

export function fitFor(p: Profile): Fit {
  const t = Math.min(1, Math.max(0, (p.heightCm - 150) / 42)); // 150 cm -> 0, 192 cm -> 1
  const liftMm = Math.round(SEAT_LIFT_MM * (1 - t));
  // Slide back until the foot reaches the pedal with the leg at 94 % of its length (a slight knee bend).
  const reach = 0.94 * body(p.heightCm).leg;
  const dy = CABIN.hip.y + liftMm / 10 - CABIN.pedal.y;
  const hipX = Math.sqrt(Math.max(0, reach * reach - dy * dy));
  return {
    liftMm,
    slideMm: Math.round(Math.min(SEAT_SLIDE_MM, Math.max(0, (hipX - CABIN.hip.x) * 10))),
    reclineDeg: p.reclineDeg,
    wheelTiltDeg: Math.round((20 + 10 * t) * 10) / 10,
    wheelReachMm: Math.round(WHEEL_REACH_MM * t),
    heightCm: p.heightCm,
  };
}
