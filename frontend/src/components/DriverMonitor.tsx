// Driver monitoring camera: face tracking and drowsiness scoring stay in the browser. The monitor
// only keeps numeric cues in memory; it never uploads or stores camera frames. What the car does
// about the driver's state (alarms, cabin changes, voice) lives in lib/useFatigueGuard.ts.

import { useEffect, useRef, useState } from 'react';
import { CameraOff, Eye, EyeOff, Minus, RefreshCw, ScanFace, X } from 'lucide-react';
import type { FaceLandmarker as FaceLandmarkerT } from '@mediapipe/tasks-vision';
import {
  DROWSY_CLOSED_S,
  DrowsinessTracker,
  PERCLOS_DROWSY,
  PERCLOS_TIRED,
  PERCLOS_WINDOW_S,
  type DriverStatus,
  type HeadPose,
} from '../lib/drowsiness';
import type { CarState } from '../types';
import type { FatigueGuard } from '../lib/useFatigueGuard';
import { FatiguePresenter, FatigueTimeline } from './FatiguePanel';

const ASSETS = `${import.meta.env.BASE_URL}mediapipe`;
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const MOUTH = [61, 81, 13, 311, 291, 402, 14, 178];
/** A covered lens: very dark, or one flat colour, for this long with no face in view. */
const BLOCKED_MEAN = 28;
const BLOCKED_SPREAD = 6;
const BLOCKED_HOLD_MS = 1000;
const BLOCK_CHECK_MS = 400;

type Point = { x: number; y: number; z?: number };

const LABEL: Record<DriverStatus['state'], string> = {
  starting: 'Looking for driver…',
  calibrating: 'Calibrating…',
  'no-face': 'Driver not visible',
  'low-confidence': 'Unable to assess',
  alert: 'Alert',
  tired: 'Tired',
  drowsy: 'Drowsy!',
};

function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function poseFromLandmarks(points: readonly Point[]): HeadPose | null {
  const required = [1, 10, 33, 61, 152, 263, 291];
  if (required.some((i) => !points[i])) return null;
  const leftEye = points[33];
  const rightEye = points[263];
  const nose = points[1];
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeSpan = Math.max(0.001, Math.abs(rightEye.x - leftEye.x));
  const mouthY = (points[61].y + points[291].y) / 2;
  const ys = points.map((p) => p.y);
  const top = Math.min(...ys);
  const height = Math.max(0.001, Math.max(...ys) - top);
  const roll = clamp(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) / 0.8);
  const yaw = clamp(((nose.x - eyeMidX) / eyeSpan) * 2.4);
  const nosePosition = (nose.y - top) / height;
  const mouthDistance = Math.max(0.001, mouthY - eyeMidY);
  const pitch = clamp(((nosePosition - 0.42) * 2.4) + ((nose.y - eyeMidY) / mouthDistance - 0.45) * 0.25);
  return { yaw, pitch, roll };
}

function confidenceFromLandmarks(points: readonly Point[], categories: readonly { categoryName?: string }[], pose: HeadPose | null) {
  if (points.length < 300) return 0;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const size = clamp((Math.min(width, height) - 0.12) / 0.22, 0, 1);
  const centre = 1 - clamp(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 0.5) * 1.7, 0, 1) * 0.25;
  const posePenalty = pose
    ? clamp(Math.max(0, Math.abs(pose.yaw) - 0.32) * 1.6 + Math.max(0, Math.abs(pose.pitch) - 0.38) * 1.2, 0, 1)
    : 0.25;
  const poseScore = 1 - posePenalty;
  const blendshapeScore = categories.length >= 8 ? 1 : categories.length / 8;
  return clamp(size * 0.5 + poseScore * 0.3 + centre * 0.1 + blendshapeScore * 0.1, 0, 1);
}

async function loadLandmarker(): Promise<FaceLandmarkerT> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(ASSETS);
  const make = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${ASSETS}/face_landmarker.task`, delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  try {
    return await make('GPU');
  } catch {
    return make('CPU');
  }
}

/** Brightness mean and spread of a tiny copy of the frame: a hand or tape over the lens is dark or flat. */
function lensCovered(v: HTMLVideoElement, probe: HTMLCanvasElement): boolean {
  const g = probe.getContext('2d', { willReadFrequently: true });
  if (!g || !v.videoWidth) return false;
  g.drawImage(v, 0, 0, probe.width, probe.height);
  const px = g.getImageData(0, 0, probe.width, probe.height).data;
  let sum = 0;
  let sq = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    sum += y;
    sq += y * y;
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return mean < BLOCKED_MEAN || spread < BLOCKED_SPREAD;
}

type Tab = 'monitor' | 'timeline' | 'presenter';

interface Props {
  onClose: () => void;
  /** Every reading goes to the fatigue response; `blocked` = the lens looks covered. */
  onStatus: (st: DriverStatus, blocked: boolean) => void;
  guard: FatigueGuard;
  car: CarState;
  onStartEngine: () => void;
}

export function DriverMonitor({ onClose, onStatus, guard, car, onStartEngine }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<DrowsinessTracker | null>(null);
  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mini, setMini] = useState(false);
  const [tab, setTab] = useState<Tab>('monitor');
  const statusCb = useRef(onStatus);
  useEffect(() => { statusCb.current = onStatus; }, [onStatus]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let landmarker: FaceLandmarkerT | null = null;
    let raf = 0;
    let stopped = false;
    let lastVideoTime = -1;
    let lastUi = 0;
    let lastProbe = 0;
    let darkSince: number | null = null;
    let isBlocked = false;
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 24;
    const tracker = new DrowsinessTracker();
    trackerRef.current = tracker;

    const draw = (pts: readonly Point[] | undefined, st: DriverStatus) => {
      const c = canvas.current;
      const v = video.current;
      if (!c || !v) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext('2d');
      if (!g || !pts) {
        g?.clearRect(0, 0, c.width, c.height);
        return;
      }
      g.clearRect(0, 0, c.width, c.height);
      const colour = st.state === 'drowsy' ? '#ff4d4d'
        : st.state === 'tired' ? '#ffb84d'
          : st.state === 'low-confidence' || st.state === 'calibrating' ? '#8db7ff' : '#3ee08c';
      g.lineWidth = Math.max(2, c.width / 260);
      g.strokeStyle = colour;
      for (const ring of [LEFT_EYE, RIGHT_EYE, MOUTH]) {
        g.beginPath();
        ring.forEach((i, k) => (k ? g.lineTo : g.moveTo).call(g, pts[i].x * c.width, pts[i].y * c.height));
        g.closePath();
        g.stroke();
      }
      const xs = pts.map((p) => p.x * c.width);
      const ys = pts.map((p) => p.y * c.height);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      g.setLineDash([10, 8]);
      g.strokeRect(x0 - 12, y0 - 12, x1 - x0 + 24, y1 - y0 + 24);
      g.setLineDash([]);
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = video.current;
      if (!v || !landmarker || v.readyState < 2 || v.currentTime === lastVideoTime) return;
      lastVideoTime = v.currentTime;
      const now = performance.now();
      const res = landmarker.detectForVideo(v, now);
      const points = res.faceLandmarks?.[0] as Point[] | undefined;
      const shapes = res.faceBlendshapes?.[0]?.categories ?? [];
      const score = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
      const pose = points ? poseFromLandmarks(points) : null;
      const hasEyes = shapes.some((c) => c.categoryName === 'eyeBlinkLeft') && shapes.some((c) => c.categoryName === 'eyeBlinkRight');
      const cues = points && hasEyes
        ? {
            eyeClosure: (score('eyeBlinkLeft') + score('eyeBlinkRight')) / 2,
            jawOpen: score('jawOpen'),
            confidence: confidenceFromLandmarks(points, shapes, pose),
            headPose: pose ?? undefined,
          }
        : points
          ? { eyeClosure: 0, jawOpen: 0, confidence: 0.25, headPose: pose ?? undefined }
          : null;
      const st = tracker.update(now, cues);
      // Covered lens: checked only while no face is found, so a dark cabin with a visible face never counts.
      if (now - lastProbe > BLOCK_CHECK_MS) {
        lastProbe = now;
        const covered = !points && lensCovered(v, probe);
        darkSince = covered ? (darkSince ?? now) : null;
        isBlocked = darkSince !== null && now - darkSince >= BLOCKED_HOLD_MS;
      }
      draw(points, st);
      statusCb.current(st, isBlocked);
      if (now - lastUi > 100 || st.state === 'drowsy') {
        lastUi = now;
        setStatus(st);
        setBlocked(isBlocked);
      }
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
        if (stopped) return;
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        landmarker = await loadLandmarker();
        if (stopped) return;
        setLoading(false);
        loop();
      } catch (e) {
        setLoading(false);
        setError(e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow the camera to monitor the driver.'
          : e instanceof DOMException && e.name === 'NotFoundError' ? 'No camera found.' : `Driver monitor failed: ${e instanceof Error ? e.message : e}`);
      }
    })();

    return () => {
      stopped = true;
      trackerRef.current = null;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      landmarker?.close();
    };
  }, []);

  const recalibrate = () => {
    trackerRef.current?.reset();
    setStatus(null);
  };

  // Alarms, voice and cabin changes for these states are run by the fatigue response (useFatigueGuard).

  const s = status?.state ?? 'starting';
  const label = blocked ? 'Camera blocked' : LABEL[s];
  const sub = blocked ? 'Lens covered: monitoring paused, not treated as drowsiness' : status?.reason ?? '';
  const perclos = status?.perclos;
  const confidence = status?.confidence ?? 0;
  const pose = status?.headPose;
  const poseLabel = !pose ? '—' : Math.abs(pose.yaw) > 0.4 ? 'turned' : Math.abs(pose.pitch) > 0.45 ? 'tilted' : 'centred';
  return (
    <>
      <section className={`dm ${blocked ? 'no-face' : s} ${mini ? 'mini' : ''} tab-${tab}`} aria-label="Driver monitor">
        <header>
          <ScanFace />
          <b>Driver monitor</b>
          <button onClick={recalibrate} aria-label="Recalibrate driver monitor" title="Recalibrate"><RefreshCw /></button>
          <button onClick={() => setMini((m) => !m)} aria-label={mini ? 'Expand driver monitor' : 'Minimise driver monitor'}><Minus /></button>
          <button onClick={onClose} aria-label="Turn off driver monitor"><X /></button>
        </header>
        {!mini && (
          <div className="dm-tabs" role="tablist">
            {(['monitor', 'timeline', 'presenter'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'monitor' ? 'Monitor' : t === 'timeline' ? `Timeline${guard.timeline.length ? ` (${guard.timeline.length})` : ''}` : 'Presenter'}
              </button>
            ))}
          </div>
        )}
        <div className="dm-cam">
          <video ref={video} muted playsInline aria-label="Mirrored driver camera" />
          <canvas ref={canvas} />
          {(loading || error) && <p className="dm-msg">{error ?? 'Starting camera and face model…'}</p>}
        </div>
        <div className="dm-state" aria-live="polite">
          {blocked ? <CameraOff /> : s === 'alert' || s === 'tired' ? <Eye /> : <EyeOff />}
          <div><b>{label}</b><span>{sub}</span></div>
        </div>
        {!mini && (
          <>
            <div className="dm-quality">
              <span>Tracking {Math.round(confidence * 100)}%</span>
              <span>Pose {poseLabel}</span>
              {s === 'calibrating' && <span>Baseline {Math.round((status?.calibrationProgress ?? 0) * 100)}%</span>}
            </div>
            <dl className="dm-metrics">
              <div>
                <dt>Eyes</dt>
                <dd className={status?.eyesClosed ? 'warn' : ''}>{status?.eyesClosed ? `closed ${status.closedS.toFixed(1)} s` : 'open'}</dd>
                <meter min={0} max={DROWSY_CLOSED_S} value={Math.min(DROWSY_CLOSED_S, status?.closedS ?? 0)} />
              </div>
              <div>
                <dt>Eyes closed (PERCLOS, {PERCLOS_WINDOW_S} s)</dt>
                <dd>{perclos == null ? `measuring (${Math.round(status?.observedS ?? 0)} s)` : `${Math.round(perclos * 100)}%`}</dd>
                <meter min={0} max={0.5} low={PERCLOS_TIRED} high={PERCLOS_DROWSY} optimum={0} value={perclos ?? 0} />
              </div>
              <div><dt>Blinks / min</dt><dd>{status?.blinksPerMin ?? 0}</dd></div>
              <div><dt>Microsleeps / 30 s</dt><dd>{status?.microsleeps ?? 0}</dd></div>
              <div><dt>Yawns / 2 min</dt><dd>{status?.yawns ?? 0}</dd></div>
            </dl>
          </>
        )}
        {!mini && tab === 'timeline' && <FatigueTimeline guard={guard} />}
        {!mini && tab === 'presenter' && <FatiguePresenter guard={guard} car={car} onStartEngine={onStartEngine} />}
        {!mini && (
          <p className="dm-note">
            Video is processed on this device only. Monitoring is assistive, not autonomous.
            <button onClick={recalibrate}>Recalibrate</button>
          </p>
        )}
      </section>
    </>
  );
}
