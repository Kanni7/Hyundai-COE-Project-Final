/**
 * Lightweight image-space multi-object tracker for the Safe Exit Guardian demo.
 *
 * The tracker deliberately works in normalized image coordinates so it is
 * independent of the webcam's pixel resolution. It uses class-aware greedy
 * matching with IoU and predicted-centre distance, then applies exponential
 * smoothing to the box and velocity. This is not a production automotive
 * tracker, but it is a useful local prototype and keeps the detection and
 * safety-decision layers independent.
 */

export const SUPPORTED_OBJECT_CLASSES = ['person', 'car', 'motorcycle', 'bicycle', 'bus', 'truck'] as const;
export type DetectionClass = (typeof SUPPORTED_OBJECT_CLASSES)[number];

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawDetection {
  className: DetectionClass;
  /** The model's original category label, retained for model transparency. */
  label: string;
  confidence: number;
  box: NormalizedBox;
}

export type MovementDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'up-left'
  | 'up-right'
  | 'down-left'
  | 'down-right'
  | 'still';

export type SizeTrend = 'expanding' | 'contracting' | 'stable';

export interface ObjectMovement {
  /** Normalized image-space velocity per second. */
  dx: number;
  dy: number;
  speed: number;
  direction: MovementDirection;
  /** Relative area change per second, not a physical distance estimate. */
  scaleDelta: number;
  sizeTrend: SizeTrend;
}

export interface TrackedObject {
  trackId: number;
  className: DetectionClass;
  label: string;
  confidence: number;
  box: NormalizedBox;
  center: { x: number; y: number };
  movement: ObjectMovement;
  ageFrames: number;
  missedFrames: number;
  confirmed: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Timestamp for the local detection event stream. */
  timestampMs: number;
}

interface InternalTrack extends TrackedObject {
  lastArea: number;
}

interface TrackerOptions {
  maxMissedFrames?: number;
  maxTrackAgeMs?: number;
  confirmationFrames?: number;
}

const DEFAULT_OPTIONS: Required<TrackerOptions> = {
  maxMissedFrames: 8,
  maxTrackAgeMs: 1100,
  confirmationFrames: 3,
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

function boxArea(box: NormalizedBox) {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function centerOf(box: NormalizedBox) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function normalizeBox(box: NormalizedBox): NormalizedBox {
  const x = clamp(box.x);
  const y = clamp(box.y);
  const right = clamp(box.x + box.width);
  const bottom = clamp(box.y + box.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

export function intersectionOverUnion(a: NormalizedBox, b: NormalizedBox) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = boxArea(a) + boxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function movementDirection(dx: number, dy: number, threshold = 0.018): MovementDirection {
  const horizontal = Math.abs(dx) >= threshold;
  const vertical = Math.abs(dy) >= threshold;
  if (!horizontal && !vertical) return 'still';
  if (horizontal && vertical) {
    if (dx < 0 && dy < 0) return 'up-left';
    if (dx >= 0 && dy < 0) return 'up-right';
    if (dx < 0) return 'down-left';
    return 'down-right';
  }
  if (horizontal) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

function sizeTrend(scaleDelta: number): SizeTrend {
  if (scaleDelta > 0.08) return 'expanding';
  if (scaleDelta < -0.08) return 'contracting';
  return 'stable';
}

function predictedBox(track: InternalTrack, timestampMs: number): NormalizedBox {
  const dt = Math.max(0, Math.min(1.5, (timestampMs - track.lastSeenAt) / 1000));
  return normalizeBox({
    ...track.box,
    x: track.box.x + track.movement.dx * dt * 0.45,
    y: track.box.y + track.movement.dy * dt * 0.45,
  });
}

function centreDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Class-aware IoU/centroid tracker with short-term retention for disappear /
 * reappear cases. The IDs are session-local and reset when the camera stops.
 */
export class ObjectTracker {
  private readonly options: Required<TrackerOptions>;
  private tracks = new Map<number, InternalTrack>();
  private nextTrackId = 1;

  constructor(options: TrackerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset() {
    this.tracks.clear();
    this.nextTrackId = 1;
  }

  update(detections: readonly RawDetection[], timestampMs: number): TrackedObject[] {
    const normalized = detections.map((detection) => ({ ...detection, box: normalizeBox(detection.box) }));
    const activeTracks = [...this.tracks.values()].filter((track) => timestampMs - track.lastSeenAt <= this.options.maxTrackAgeMs);
    const matches: { track: InternalTrack; detectionIndex: number; score: number }[] = [];

    for (const track of activeTracks) {
      const predicted = predictedBox(track, timestampMs);
      const predictedCenter = centerOf(predicted);
      for (let i = 0; i < normalized.length; i++) {
        const detection = normalized[i];
        if (detection.className !== track.className) continue;
        const detectionCenter = centerOf(detection.box);
        const distance = centreDistance(predictedCenter, detectionCenter);
        const iou = intersectionOverUnion(predicted, detection.box);
        if (distance > 0.30 && iou < 0.03) continue;
        const distanceScore = Math.max(0, 1 - distance / 0.35);
        matches.push({ track, detectionIndex: i, score: iou * 0.68 + distanceScore * 0.32 });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const matchedTrackIds = new Set<number>();
    const matchedDetectionIndexes = new Set<number>();
    const byDetection = new Map<number, InternalTrack>();
    for (const match of matches) {
      if (matchedTrackIds.has(match.track.trackId) || matchedDetectionIndexes.has(match.detectionIndex)) continue;
      matchedTrackIds.add(match.track.trackId);
      matchedDetectionIndexes.add(match.detectionIndex);
      byDetection.set(match.detectionIndex, match.track);
    }

    const visible: TrackedObject[] = [];
    normalized.forEach((detection, detectionIndex) => {
      const previous = byDetection.get(detectionIndex);
      if (!previous) {
        const center = centerOf(detection.box);
        const created: InternalTrack = {
          trackId: this.nextTrackId++,
          className: detection.className,
          label: detection.label,
          confidence: detection.confidence,
          box: detection.box,
          center,
          movement: {
            dx: 0,
            dy: 0,
            speed: 0,
            direction: 'still',
            scaleDelta: 0,
            sizeTrend: 'stable',
          },
          ageFrames: 1,
          missedFrames: 0,
          confirmed: this.options.confirmationFrames <= 1,
          firstSeenAt: timestampMs,
          lastSeenAt: timestampMs,
          timestampMs,
          lastArea: boxArea(detection.box),
        };
        this.tracks.set(created.trackId, created);
        visible.push(created);
        return;
      }

      const dt = Math.max(0.016, (timestampMs - previous.lastSeenAt) / 1000);
      const alpha = previous.missedFrames > 0 ? 0.7 : 0.45;
      const box = {
        x: lerp(previous.box.x, detection.box.x, alpha),
        y: lerp(previous.box.y, detection.box.y, alpha),
        width: lerp(previous.box.width, detection.box.width, alpha),
        height: lerp(previous.box.height, detection.box.height, alpha),
      };
      const center = centerOf(box);
      const rawDx = (center.x - previous.center.x) / dt;
      const rawDy = (center.y - previous.center.y) / dt;
      const dx = lerp(previous.movement.dx, rawDx, previous.missedFrames > 0 ? 0.65 : 0.38);
      const dy = lerp(previous.movement.dy, rawDy, previous.missedFrames > 0 ? 0.65 : 0.38);
      const area = boxArea(box);
      const rawScaleDelta = (area - previous.lastArea) / Math.max(previous.lastArea, 0.0001) / dt;
      const scaleDelta = lerp(previous.movement.scaleDelta, rawScaleDelta, 0.4);
      const updated: InternalTrack = {
        ...previous,
        label: detection.label,
        confidence: lerp(previous.confidence, detection.confidence, 0.55),
        box,
        center,
        movement: {
          dx,
          dy,
          speed: Math.hypot(dx, dy),
          direction: movementDirection(dx, dy),
          scaleDelta,
          sizeTrend: sizeTrend(scaleDelta),
        },
        ageFrames: previous.ageFrames + 1,
        missedFrames: 0,
        confirmed: previous.confirmed || previous.ageFrames + 1 >= this.options.confirmationFrames,
        lastSeenAt: timestampMs,
        timestampMs,
        lastArea: area,
      };
      this.tracks.set(updated.trackId, updated);
      visible.push(updated);
    });

    for (const track of [...this.tracks.values()]) {
      if (matchedTrackIds.has(track.trackId) || visible.some((object) => object.trackId === track.trackId)) continue;
      const missed = track.missedFrames + 1;
      if (missed > this.options.maxMissedFrames || timestampMs - track.lastSeenAt > this.options.maxTrackAgeMs) {
        this.tracks.delete(track.trackId);
      } else {
        this.tracks.set(track.trackId, { ...track, missedFrames: missed });
      }
    }

    return visible.sort((a, b) => a.trackId - b.trackId);
  }
}
