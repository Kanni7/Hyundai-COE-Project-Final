// Driver monitoring camera: face tracking and drowsiness scoring stay in the browser. The monitor
// only keeps numeric cues in memory; it never uploads or stores camera frames.

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Minus, RefreshCw, ScanFace, X } from 'lucide-react';
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
import { carAudio } from '../lib/audio';
import { speak } from '../lib/speech';

const ASSETS = `${import.meta.env.BASE_URL}mediapipe`;
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const MOUTH = [61, 81, 13, 311, 291, 402, 14, 178];
const WARN_EVERY_MS = 6000;
const TIRED_HINT_EVERY_MS = 120_000;

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

export function DriverMonitor({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<DrowsinessTracker | null>(null);
  const [status, setStatus] = useState<DriverStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mini, setMini] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let landmarker: FaceLandmarkerT | null = null;
    let raf = 0;
    let stopped = false;
    let lastVideoTime = -1;
    let lastUi = 0;
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
      draw(points, st);
      if (now - lastUi > 100 || st.state === 'drowsy') {
        lastUi = now;
        setStatus(st);
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

  // Warnings: alarm + repeated voice while drowsy, a gentle spoken hint when tired.
  const state = status?.state;
  const reason = status?.reason;
  useEffect(() => {
    if (state !== 'drowsy') return;
    carAudio.alarm(true);
    const warn = () => speak('Wake up! You seem drowsy. Please open your eyes and take a break soon.');
    warn();
    const t = window.setInterval(warn, WARN_EVERY_MS);
    return () => {
      window.clearInterval(t);
      carAudio.alarm(false);
      window.speechSynthesis?.cancel();
    };
  }, [state]);

  const lastHint = useRef(-Infinity);
  useEffect(() => {
    if (state !== 'tired' || performance.now() - lastHint.current < TIRED_HINT_EVERY_MS) return;
    lastHint.current = performance.now();
    speak(`You look tired: ${reason?.toLowerCase()}. Consider a short break.`);
  }, [state, reason]);
  useEffect(() => () => carAudio.alarm(false), []);

  const s = status?.state ?? 'starting';
  const perclos = status?.perclos;
  const confidence = status?.confidence ?? 0;
  const pose = status?.headPose;
  const poseLabel = !pose ? '—' : Math.abs(pose.yaw) > 0.4 ? 'turned' : Math.abs(pose.pitch) > 0.45 ? 'tilted' : 'centred';
  return (
    <>
      {s === 'drowsy' && (
        <div className="dm-alarm" role="alert">
          <AlertTriangle />
          <b>WAKE UP!</b>
          <span>{status?.reason}. Please take a break.</span>
        </div>
      )}
      <section className={`dm ${s} ${mini ? 'mini' : ''}`} aria-label="Driver monitor">
        <header>
          <ScanFace />
          <b>Driver monitor</b>
          <button onClick={recalibrate} aria-label="Recalibrate driver monitor" title="Recalibrate"><RefreshCw /></button>
          <button onClick={() => setMini((m) => !m)} aria-label={mini ? 'Expand driver monitor' : 'Minimise driver monitor'}><Minus /></button>
          <button onClick={onClose} aria-label="Turn off driver monitor"><X /></button>
        </header>
        <div className="dm-cam">
          <video ref={video} muted playsInline aria-label="Mirrored driver camera" />
          <canvas ref={canvas} />
          {(loading || error) && <p className="dm-msg">{error ?? 'Starting camera and face model…'}</p>}
        </div>
        <div className="dm-state" aria-live="polite">
          {s === 'alert' || s === 'tired' ? <Eye /> : <EyeOff />}
          <div><b>{LABEL[s]}</b><span>{status?.reason ?? ''}</span></div>
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
