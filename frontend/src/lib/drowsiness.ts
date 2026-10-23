// Driver drowsiness from facial cues, frame by frame. All cues are produced in the browser by
// MediaPipe; this module only keeps a short-lived numeric history and never stores camera frames.

export type DriverState = 'starting' | 'calibrating' | 'no-face' | 'low-confidence' | 'alert' | 'tired' | 'drowsy';

export interface HeadPose {
  /** Normalised head turn: -1 = left, +1 = right. */
  yaw: number;
  /** Normalised head tilt: -1 = up, +1 = down. */
  pitch: number;
  /** Normalised roll: -1 = tilted left, +1 = tilted right. */
  roll: number;
}

export interface FaceCues {
  /** Mean eyeBlinkLeft/Right blendshape, 0 (open) .. 1 (closed). */
  eyeClosure: number;
  /** jawOpen blendshape, 0 .. 1. */
  jawOpen: number;
  /** Confidence in the face geometry and blendshapes, 0 .. 1. */
  confidence: number;
  /** Pose estimated from the face landmarks. */
  headPose?: HeadPose;
}

export interface DriverStatus {
  state: DriverState;
  /** Why the state was chosen, for the display and the spoken warning. */
  reason: string;
  eyesClosed: boolean;
  /** Length of the current eye closure, seconds. */
  closedS: number;
  /** Share of observed time in the PERCLOS window with eyes closed, 0 .. 1. */
  perclos: number | null;
  blinksPerMin: number;
  yawns: number;
  /** Long closures (micro-sleeps) completed in the last 30 seconds. */
  microsleeps: number;
  /** Current face-tracking confidence, 0 .. 1. */
  confidence: number;
  /** Progress of the driver-specific baseline calibration, 0 .. 1. */
  calibrationProgress: number;
  /** Seconds of usable face observations represented by the PERCLOS data. */
  observedS: number;
  headPose: HeadPose | null;
}

export const DROWSY_CLOSED_S = 2;
export const PERCLOS_WINDOW_S = 30;
export const PERCLOS_MIN_S = 10;
export const PERCLOS_TIRED = 0.15;
export const PERCLOS_DROWSY = 0.3;
export const CALIBRATION_S = 8;
export const MIN_FACE_CONFIDENCE = 0.58;
export const YAWN_WINDOW_S = 120;
export const AWAKE_S = 4;

const PERCLOS_DROWSY_EXIT = 0.25;
const YAWN_JAW = 0.55;
const YAWN_MIN_S = 1.2;
const YAWNS_TIRED = 2;
const NO_FACE_S = 1.5;
const LOW_CONFIDENCE_S = 1.25;
const BLINK_MAX_MS = 500;
const MICROSLEEP_MIN_MS = 1200;
const MICROSLEEP_WINDOW_S = 30;
const MICROSLEEPS_TIRED = 2;
const MICROSLEEPS_DROWSY = 3;
const MICROSLEEP_DROWSY_ACTIVE_S = 8;
const MAX_SAMPLE_GAP_MS = 650;
const DROWSY_HOLD_MS = AWAKE_S * 1000;

export class DrowsinessTracker {
  private samples: { t: number; closed: boolean }[] = [];
  private closed = false;
  private closedSince = 0;
  private blinks: number[] = [];
  private yawnSince: number | null = null;
  private yawnCounted = false;
  private yawnTimes: number[] = [];
  private longClosures: number[] = [];
  private lastAnyFace = -Infinity;
  private lastGoodFace = -Infinity;
  private lastConfidence = 0;
  private lastPose: HeadPose | null = null;
  private startedAt = -Infinity;
  private calibrationGoodMs = 0;
  private lastCalibrationSample = -Infinity;
  private calibrationLevels: number[] = [];
  private calibrated = false;
  private restingEyeLevel = 0.08;
  private perclosDrowsy = false;
  private lastLongClosure = -Infinity;
  private lastDrowsy = -Infinity;
  private wasDrowsy = false;
  private drowsyReason = '';

  /** Reset the driver-specific baseline and all short-lived measurements. */
  reset() {
    this.samples = [];
    this.closed = false;
    this.closedSince = 0;
    this.blinks = [];
    this.yawnSince = null;
    this.yawnCounted = false;
    this.yawnTimes = [];
    this.longClosures = [];
    this.lastAnyFace = -Infinity;
    this.lastGoodFace = -Infinity;
    this.lastConfidence = 0;
    this.lastPose = null;
    this.startedAt = -Infinity;
    this.calibrationGoodMs = 0;
    this.lastCalibrationSample = -Infinity;
    this.calibrationLevels = [];
    this.calibrated = false;
    this.restingEyeLevel = 0.08;
    this.perclosDrowsy = false;
    this.lastLongClosure = -Infinity;
    this.lastDrowsy = -Infinity;
    this.wasDrowsy = false;
    this.drowsyReason = '';
  }

  /** One camera frame at time `t` (ms); `cues` is null when no face is visible. */
  update(t: number, cues: FaceCues | null): DriverStatus {
    if (this.startedAt === -Infinity) this.startedAt = t;

    if (cues) {
      this.lastAnyFace = t;
      this.lastConfidence = Math.max(0, Math.min(1, cues.confidence));
      this.lastPose = cues.headPose ?? null;
      if (this.isUsable(cues)) {
        this.lastGoodFace = t;
        this.calibrate(t, cues.eyeClosure);
        if (this.calibrated) {
          this.eyes(t, cues.eyeClosure);
          this.mouth(t, cues.jawOpen);
        }
      }
    }

    const st = this.judge(t);
    // Keep a real drowsy event visible for the full recovery window. This prevents the alarm
    // from flickering off on the first open frame, but never masks a missing/uncertain face.
    if (st.state === 'drowsy') {
      // Record the transition once. While the eyes remain shut, keep extending the
      // recovery clock; an already-open driver must not extend it on every frame.
      if (!this.wasDrowsy) {
        this.lastDrowsy = t;
        this.drowsyReason = st.reason;
      } else if (st.eyesClosed) {
        this.lastDrowsy = t;
      }
      this.wasDrowsy = true;
      return st;
    }
    const recovering = this.wasDrowsy;
    this.wasDrowsy = false;
    if (recovering && !['no-face', 'low-confidence', 'starting', 'calibrating'].includes(st.state) && t - this.lastDrowsy < DROWSY_HOLD_MS) {
      this.wasDrowsy = true;
      return { ...st, state: 'drowsy', reason: this.drowsyReason || st.reason };
    }
    return st;
  }

  private isUsable(cues: FaceCues): boolean {
    const p = cues.headPose;
    return cues.confidence >= MIN_FACE_CONFIDENCE && (!p || (Math.abs(p.yaw) <= 0.58 && Math.abs(p.pitch) <= 0.62));
  }

  private calibrate(t: number, level: number) {
    if (this.calibrated) {
      // Slowly follow a genuinely open eye level so small camera/lighting changes do not
      // turn narrow eyes or glasses into false closures.
      if (!this.closed && level < this.restingEyeLevel + 0.12) this.restingEyeLevel = this.restingEyeLevel * 0.995 + level * 0.005;
      return;
    }
    if (this.lastCalibrationSample !== -Infinity) {
      this.calibrationGoodMs += Math.min(200, Math.max(0, t - this.lastCalibrationSample));
    }
    this.lastCalibrationSample = t;
    this.calibrationLevels.push(level);
    if (this.calibrationLevels.length > 600) this.calibrationLevels.shift();
    if (this.calibrationGoodMs >= CALIBRATION_S * 1000 && this.calibrationLevels.length >= 30) {
      const sorted = [...this.calibrationLevels].sort((a, b) => a - b);
      this.restingEyeLevel = sorted[Math.floor(sorted.length * 0.2)] ?? 0.08;
      this.calibrated = true;
    }
  }

  private judge(t: number): DriverStatus {
    this.trim(t);
    const observedS = this.observedDurationS();
    const perclos = observedS >= PERCLOS_MIN_S ? this.closedShare() : null;
    const closedS = this.closed ? Math.max(0, (t - this.closedSince) / 1000) : 0;
    const microsleeps = this.longClosures.length;
    const base = {
      eyesClosed: this.closed,
      closedS,
      perclos,
      blinksPerMin: this.blinks.length,
      yawns: this.yawnTimes.length,
      microsleeps,
      confidence: this.lastConfidence,
      calibrationProgress: this.calibrationProgress(),
      observedS,
      headPose: this.lastPose,
    };

    if (t - this.lastAnyFace > NO_FACE_S * 1000) {
      return {
        ...base,
        state: this.lastAnyFace === -Infinity ? 'starting' : 'no-face',
        reason: this.lastAnyFace === -Infinity ? 'Looking for driver…' : 'Face not visible',
        eyesClosed: false,
        closedS: 0,
        confidence: 0,
      };
    }
    if (t - this.lastGoodFace > LOW_CONFIDENCE_S * 1000) {
      return { ...base, state: 'low-confidence', reason: this.lowConfidenceReason(), eyesClosed: false, closedS: 0 };
    }
    if (!this.calibrated) {
      return { ...base, state: 'calibrating', reason: `Calibrating driver baseline (${Math.round(base.calibrationProgress * 100)}%)`, eyesClosed: false, closedS: 0 };
    }

    if (closedS >= DROWSY_CLOSED_S) return { ...base, state: 'drowsy', reason: `Eyes closed for ${closedS.toFixed(1)} s` };

    if (perclos !== null) {
      if (!this.perclosDrowsy && perclos >= PERCLOS_DROWSY) this.perclosDrowsy = true;
      else if (this.perclosDrowsy && perclos <= PERCLOS_DROWSY_EXIT) this.perclosDrowsy = false;
    }
    const awake = t - this.lastLongClosure > AWAKE_S * 1000;
    if (this.perclosDrowsy && !awake) return { ...base, state: 'drowsy', reason: `Eyes closed ${Math.round((perclos ?? 0) * 100)}% of the last ${PERCLOS_WINDOW_S} s` };
    if (this.perclosDrowsy) return { ...base, state: 'tired', reason: `Eyes were closed ${Math.round((perclos ?? 0) * 100)}% of the last ${PERCLOS_WINDOW_S} s` };

    const recentMicrosleep = this.longClosures.length > 0 && t - this.longClosures[this.longClosures.length - 1] <= MICROSLEEP_DROWSY_ACTIVE_S * 1000;
    if (microsleeps >= MICROSLEEPS_DROWSY && recentMicrosleep) return { ...base, state: 'drowsy', reason: `${microsleeps} microsleeps detected in ${MICROSLEEP_WINDOW_S} s` };
    if (perclos !== null && perclos >= PERCLOS_TIRED) return { ...base, state: 'tired', reason: 'Slow, heavy blinking' };
    if (microsleeps >= MICROSLEEPS_TIRED) return { ...base, state: 'tired', reason: `${microsleeps} microsleeps detected in ${MICROSLEEP_WINDOW_S} s` };
    if (this.yawnTimes.length >= YAWNS_TIRED) return { ...base, state: 'tired', reason: `${this.yawnTimes.length} yawns in ${YAWN_WINDOW_S / 60} min` };
    return { ...base, state: 'alert', reason: 'Eyes open, attentive' };
  }

  private lowConfidenceReason(): string {
    const p = this.lastPose;
    if (p && Math.abs(p.yaw) > 0.58) return 'Turn your face toward the road';
    if (p && Math.abs(p.pitch) > 0.62) return 'Keep your face level with the road';
    return 'Lighting or face position limits tracking';
  }

  private calibrationProgress(): number {
    return Math.min(1, Math.max(0, this.calibrationGoodMs / (CALIBRATION_S * 1000)));
  }

  private eyes(t: number, level: number) {
    const shutAt = Math.min(0.86, Math.max(0.45, this.restingEyeLevel + 0.35));
    const isClosed = this.closed ? level > shutAt - 0.12 : level > shutAt;
    if (isClosed && !this.closed) this.closedSince = t;
    if (!isClosed && this.closed) {
      const duration = t - this.closedSince;
      if (duration < BLINK_MAX_MS) this.blinks.push(t);
      if (duration >= MICROSLEEP_MIN_MS) {
        this.longClosures.push(t);
        this.lastLongClosure = t;
      }
    }
    this.closed = isClosed;
    this.samples.push({ t, closed: isClosed });
  }

  private mouth(t: number, jaw: number) {
    if (jaw < YAWN_JAW) {
      this.yawnSince = null;
      this.yawnCounted = false;
      return;
    }
    this.yawnSince ??= t;
    if (!this.yawnCounted && t - this.yawnSince >= YAWN_MIN_S * 1000) {
      this.yawnCounted = true;
      this.yawnTimes.push(t);
    }
  }

  private trim(t: number) {
    const cut = t - PERCLOS_WINDOW_S * 1000;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    while (this.blinks.length && this.blinks[0] < t - 60_000) this.blinks.shift();
    while (this.yawnTimes.length && this.yawnTimes[0] < t - YAWN_WINDOW_S * 1000) this.yawnTimes.shift();
    while (this.longClosures.length && this.longClosures[0] < t - MICROSLEEP_WINDOW_S * 1000) this.longClosures.shift();
  }

  /** Time-weighted usable observation time; long camera gaps are not counted as closed or open. */
  private observedDurationS(): number {
    let total = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const dt = this.samples[i].t - this.samples[i - 1].t;
      if (dt <= MAX_SAMPLE_GAP_MS) total += dt;
    }
    return Math.min(PERCLOS_WINDOW_S, total / 1000);
  }

  /** Time-weighted share of the usable observation window with eyes closed. */
  private closedShare(): number {
    let closed = 0;
    let total = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const dt = this.samples[i].t - this.samples[i - 1].t;
      if (dt > MAX_SAMPLE_GAP_MS) continue;
      total += dt;
      if (this.samples[i - 1].closed) closed += dt;
    }
    return total ? closed / total : 0;
  }
}
