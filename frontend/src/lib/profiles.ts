// Driver profiles: who drives, their body size, and what they like. Seat and steering position follow from
// body height (fitFor), the way a memory seat is set once per driver: a shorter driver sits higher (to see
// over the dashboard) and further forward (to reach the pedals), with the wheel lower and closer.

import { useSyncExternalStore } from 'react';
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

/** The default/guest profile — always present, used when no driver is recognized. */
export const DEFAULT_PROFILE: Profile = {
  id: 'default',
  name: 'Default',
  heightCm: 170,
  weightKg: 70,
  build: 'Standard',
  reclineDeg: 16,
  accent: '#71717a',
  prefs: { temp: 22, ambient: 'blue', driveMode: 'normal' },
};

const ACCENT_PALETTE = ['#3d8bff', '#34e07a', '#ffb84d', '#ff4fa8', '#c084fc', '#22e4ff', '#f87171', '#facc15'];
const STORAGE_KEY = 'bhashadrive-profiles';

function _load(): Record<string, Profile> {
  const store: Record<string, Profile> = { default: { ...DEFAULT_PROFILE } };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Profile>;
      for (const [id, p] of Object.entries(parsed)) {
        if (id !== 'default' && p && p.name) {
          store[id] = { ...p, id };
        }
      }
    }
  } catch {
    /* empty */
  }
  return store;
}

function _save(store: Record<string, Profile>) {
  try {
    const toSave: Record<string, Profile> = {};
    for (const [id, p] of Object.entries(store)) {
      if (id !== 'default') toSave[id] = p;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    /* localStorage full or blocked */
  }
}

/** Live profile registry: always has 'default', plus user-created profiles. */
let _profiles: Record<string, Profile> = _load();
let _profileIds: ProfileId[] = Object.keys(_profiles);

/** Listeners that are notified when profiles change (for React re-renders). */
const _listeners: Set<() => void> = new Set();
export function onProfilesChange(fn: () => void) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
function _notify() { _listeners.forEach((fn) => fn()); }

export function getProfiles(): Record<string, Profile> { return _profiles; }
export function getProfileIds(): ProfileId[] { return _profileIds; }
export function getProfile(id: ProfileId): Profile { return _profiles[id] ?? _profiles.default; }

/** React hook to re-render when profiles change */
export function useProfiles(): Record<string, Profile> {
  return useSyncExternalStore(onProfilesChange, getProfiles, getProfiles);
}

export function useProfileIds(): ProfileId[] {
  return useSyncExternalStore(onProfilesChange, getProfileIds, getProfileIds);
}

/** For backwards compat: PROFILES and PROFILE_IDS are getters into the live store. */
export const PROFILES: Record<ProfileId, Profile> = new Proxy({} as Record<ProfileId, Profile>, {
  get: (_t, prop: string) => _profiles[prop] ?? _profiles.default,
  has: (_t, prop: string) => prop in _profiles,
  ownKeys: () => Object.keys(_profiles),
  getOwnPropertyDescriptor: (_t, prop: string) => {
    if (prop in _profiles) return { configurable: true, enumerable: true, value: _profiles[prop] };
    return undefined;
  },
});

export const PROFILE_IDS: ProfileId[] = new Proxy([] as ProfileId[], {
  get: (_t, prop) => {
    if (prop === 'length') return _profileIds.length;
    if (prop === Symbol.iterator) return function* () { yield* _profileIds; };
    if (prop === 'map') return (fn: (id: ProfileId, i: number) => unknown) => _profileIds.map(fn);
    if (prop === 'some') return (fn: (id: ProfileId) => boolean) => _profileIds.some(fn);
    if (prop === 'find') return (fn: (id: ProfileId) => boolean) => _profileIds.find(fn);
    if (prop === 'filter') return (fn: (id: ProfileId) => boolean) => _profileIds.filter(fn);
    if (prop === 'forEach') return (fn: (id: ProfileId) => void) => _profileIds.forEach(fn);
    if (prop === 'includes') return (id: ProfileId) => id in _profiles;
    if (prop === 'indexOf') return (id: ProfileId) => _profileIds.indexOf(id);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return _profileIds[Number(prop)];
    return (Array.prototype as any)[prop];
  },
});

/** Create a new driver profile. Returns the profile. */
export function addProfile(
  name: string,
  heightCm: number,
  weightKg: number,
  prefs?: Partial<Profile['prefs']>
): Profile {
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || `driver${Date.now()}`;
  if (id === 'default' || _profiles[id]) {
    throw new Error(`Profile "${name}" already exists.`);
  }
  const usedAccents = new Set(Object.values(_profiles).map((p) => p.accent));
  const accent = ACCENT_PALETTE.find((c) => !usedAccents.has(c)) ?? ACCENT_PALETTE[_profileIds.length % ACCENT_PALETTE.length];
  const build = heightCm < 160 ? 'Petite' : heightCm < 178 ? 'Average' : 'Tall';
  const profile: Profile = {
    id,
    name,
    heightCm,
    weightKg,
    build,
    reclineDeg: heightCm < 165 ? 14 : heightCm < 180 ? 16 : 20,
    accent,
    prefs: {
      temp: prefs?.temp ?? 22,
      ambient: prefs?.ambient ?? 'blue',
      driveMode: prefs?.driveMode ?? 'normal',
    },
  };
  _profiles = { ..._profiles, [id]: profile };
  _profileIds = Object.keys(_profiles);
  _save(_profiles);
  _notify();
  return profile;
}

export function removeProfile(id: ProfileId): boolean {
  if (id === 'default' || !(id in _profiles)) return false;
  const { [id]: _, ...rest } = _profiles;
  _profiles = rest;
  _profileIds = Object.keys(_profiles);
  _save(_profiles);
  _notify();
  return true;
}

/** Memory-seat travel of a mid-size sedan. */
export const SEAT_LIFT_MM = 70;
export const SEAT_SLIDE_MM = 260;
export const WHEEL_REACH_MM = 60;

/** Side-view cabin geometry in cm: x rearward from the accelerator, y up from the floor. */
export const CABIN = {
  pedal: { x: 0, y: 14 },
  hip: { x: 76, y: 26 },
  column: { x: 16, y: 48, length: 44 },
};

/** Body segments as fractions of standing height (adult anthropometric averages). */
export const body = (heightCm: number) => ({
  leg: 0.555 * heightCm,
  thigh: 0.255 * heightCm,
  torso: 0.29 * heightCm,
  head: 0.13 * heightCm,
  upperArm: 0.19 * heightCm,
  forearm: 0.17 * heightCm,
});

export interface Fit {
  liftMm: number;
  slideMm: number;
  reclineDeg: number;
  wheelTiltDeg: number;
  wheelReachMm: number;
  heightCm: number;
}

export function fitFor(p: Profile): Fit {
  const t = Math.min(1, Math.max(0, (p.heightCm - 150) / 42));
  const liftMm = Math.round(SEAT_LIFT_MM * (1 - t));
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