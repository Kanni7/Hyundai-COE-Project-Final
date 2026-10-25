/**
 * Pure Safe Exit Guardian decision logic.
 *
 * This module does not know about React, webcams, or audio. It consumes the
 * image-space tracks produced by objectTracking.ts and applies explicit,
 * configurable demonstration heuristics before the UI decides whether to
 * show a warning or play a one-shot chime.
 */

import type { NormalizedBox, TrackedObject } from './objectTracking';

export type SafetyState = 'INACTIVE' | 'MONITORING' | 'WARNING' | 'CAMERA_ERROR';
export type SafetyCameraState = 'inactive' | 'ready' | 'error';

export interface DangerZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafetyConfig {
  dangerZone: DangerZone;
  minConfidence: number;
  confirmationFrames: number;
  minZoneOverlap: number;
  alertCooldownMs: number;
}

export interface SafetyDecision {
  state: SafetyState;
  /** A confirmed approaching object overlaps the configured image-space door zone. */
  risk: boolean;
  warning: boolean;
  alert: boolean;
  message: string;
  reason: string;
  candidate: TrackedObject | null;
  candidateOverlap: number;
  evaluatedAt: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  // Right-side door / traffic demonstration zone in normalized image space.
  dangerZone: { x: 0.56, y: 0.18, width: 0.38, height: 0.66 },
  minConfidence: 0.55,
  confirmationFrames: 4,
  minZoneOverlap: 0.12,
  alertCooldownMs: 6000,
};

export type SimulatedDoorState = 'CLOSED' | 'OPEN';
export type SimulatedDoorAction = 'OPEN_REQUEST' | 'CLOSE' | 'RESET';

export interface DoorTransition {
  state: SimulatedDoorState;
  opened: boolean;
  message: string;
}

export function transitionSimulatedDoor(
  current: SimulatedDoorState,
  action: SimulatedDoorAction,
): DoorTransition {
  if (action === 'CLOSE' || action === 'RESET') {
    return { state: 'CLOSED', opened: false, message: 'Door closed.' };
  }
  if (current === 'OPEN') {
    return { state: 'OPEN', opened: true, message: 'Door is already open.' };
  }
  return { state: 'OPEN', opened: true, message: 'Door opened. Check the Safe Exit warning.' };
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const area = (box: NormalizedBox) => Math.max(0, box.width) * Math.max(0, box.height);

function normalizedZone(zone: DangerZone): DangerZone {
  const x = clamp(zone.x);
  const y = clamp(zone.y);
  const right = clamp(zone.x + zone.width);
  const bottom = clamp(zone.y + zone.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function zoneOverlap(box: NormalizedBox, zone: DangerZone) {
  const safeZone = normalizedZone(zone);
  const left = Math.max(box.x, safeZone.x);
  const top = Math.max(box.y, safeZone.y);
  const right = Math.min(box.x + box.width, safeZone.x + safeZone.width);
  const bottom = Math.min(box.y + box.height, safeZone.y + safeZone.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const objectArea = area(box);
  return objectArea > 0 ? intersection / objectArea : 0;
}

export function isInsideZone(point: { x: number; y: number }, zone: DangerZone) {
  const safeZone = normalizedZone(zone);
  return point.x >= safeZone.x && point.x <= safeZone.x + safeZone.width
    && point.y >= safeZone.y && point.y <= safeZone.y + safeZone.height;
}

/**
 * Returns true when the smoothed image-space velocity points generally toward
 * the centre of the configured zone. This is not a distance or time-to-impact
 * estimate; it only supplies a directional cue for the demonstration logic.
 */
export function isMovingTowardZone(object: TrackedObject, zone: DangerZone) {
  const safeZone = normalizedZone(zone);
  const target = { x: safeZone.x + safeZone.width / 2, y: safeZone.y + safeZone.height / 2 };
  const toZone = { x: target.x - object.center.x, y: target.y - object.center.y };
  const targetLength = Math.hypot(toZone.x, toZone.y);
  const speed = object.movement.speed;
  if (targetLength < 0.001 || speed < 0.025) return false;
  const dot = object.movement.dx * toZone.x + object.movement.dy * toZone.y;
  return dot / (speed * targetLength) > 0.12;
}

function emptyDecision(state: SafetyState, evaluatedAt: number, reason: string): SafetyDecision {
  return {
    state,
    risk: false,
    warning: state === 'WARNING',
    alert: false,
    message: '',
    reason,
    candidate: null,
    candidateOverlap: 0,
    evaluatedAt,
  };
}

interface Confirmation {
  frames: number;
  lastSeenAt: number;
  overlap: number;
}

/** Stateful only for temporal confirmation and alert cooldown; all thresholds are explicit inputs. */
export class SafeExitSafetyEngine {
  private readonly confirmations = new Map<number, Confirmation>();
  private lastAlertAt = -Infinity;

  reset() {
    this.confirmations.clear();
    this.lastAlertAt = -Infinity;
  }

  evaluate({
    objects,
    cameraState,
    now,
    config,
  }: {
    objects: readonly TrackedObject[];
    cameraState: SafetyCameraState;
    now: number;
    config: SafetyConfig;
  }): SafetyDecision {
    if (cameraState === 'error') return emptyDecision('CAMERA_ERROR', now, 'Camera error');
    if (cameraState !== 'ready') return emptyDecision('INACTIVE', now, 'Camera is stopped');

    const candidates: { object: TrackedObject; overlap: number; frames: number }[] = [];
    const seenIds = new Set<number>();
    for (const object of objects) {
      seenIds.add(object.trackId);
      const overlap = zoneOverlap(object.box, config.dangerZone);
      const centreInside = isInsideZone(object.center, config.dangerZone);
      // A track must overlap the door zone and show an approach cue. Mere
      // presence in the camera frame, or standing still in the zone, is not
      // enough to trigger a warning.
      const inConfiguredZone = overlap >= config.minZoneOverlap;
      const movingTowardZone = isMovingTowardZone(object, config.dangerZone);
      const approachingCamera = centreInside
        && object.movement.sizeTrend === 'expanding'
        && object.movement.speed >= 0.025;
      const candidate = object.confidence >= config.minConfidence
        && inConfiguredZone
        && (movingTowardZone || approachingCamera);
      const previous = this.confirmations.get(object.trackId);
      if (!candidate) {
        if (previous && now - previous.lastSeenAt > 650) this.confirmations.delete(object.trackId);
        continue;
      }

      const frames = previous && now - previous.lastSeenAt <= 650 ? previous.frames + 1 : 1;
      this.confirmations.set(object.trackId, { frames, lastSeenAt: now, overlap });
      if (object.confirmed && frames >= Math.max(1, Math.round(config.confirmationFrames))) {
        candidates.push({ object, overlap, frames });
      }
    }

    for (const [trackId, confirmation] of this.confirmations) {
      if (!seenIds.has(trackId) && now - confirmation.lastSeenAt > 900) this.confirmations.delete(trackId);
    }

    const candidate = candidates.sort((a, b) => b.overlap - a.overlap)[0];
    if (!candidate) {
      return emptyDecision('MONITORING', now, 'Monitoring for an approaching object in the configured door zone');
    }

    const shouldAlert = now - this.lastAlertAt >= Math.max(0, config.alertCooldownMs);
    if (shouldAlert) this.lastAlertAt = now;
    const label = candidate.object.label
      ? `${candidate.object.label[0].toUpperCase()}${candidate.object.label.slice(1)}`
      : 'Object';
    return {
      state: 'WARNING',
      risk: true,
      warning: true,
      alert: shouldAlert,
      message: `${label} detected near the door zone. Check surroundings before opening.`,
      reason: `${candidate.object.label} #${candidate.object.trackId} confirmed in the configured image-space zone`,
      candidate: candidate.object,
      candidateOverlap: candidate.overlap,
      evaluatedAt: now,
    };
  }
}
