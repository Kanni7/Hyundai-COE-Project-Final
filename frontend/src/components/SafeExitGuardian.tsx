import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  DoorOpen,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { ObjectDetector as ObjectDetectorT } from '@mediapipe/tasks-vision';
import { carAudio } from '../lib/audio';
import {
  DEFAULT_SAFETY_CONFIG,
  SafeExitSafetyEngine,
  transitionSimulatedDoor,
  type DangerZone,
  type SafetyConfig,
  type SafetyDecision,
  type SimulatedDoorState,
} from '../lib/safeExit';
import {
  ObjectTracker,
  type DetectionClass,
  type NormalizedBox,
  type RawDetection,
  type TrackedObject,
} from '../lib/objectTracking';

const ASSETS = `${import.meta.env.BASE_URL}mediapipe`;
const MODEL_PATH = `${ASSETS}/efficientdet_lite0.tflite`;
const DETECTION_INTERVAL_MS = 110;
const UI_INTERVAL_MS = 120;
// Keep display detection forgiving enough for a laptop webcam. Safety still
// applies the stricter configurable confidence threshold before showing a warning.
const DETECTION_SCORE_THRESHOLD = 0.3;

type CameraState = 'inactive' | 'starting' | 'ready' | 'error';
type DetectorResult = ReturnType<ObjectDetectorT['detectForVideo']>;

const MODEL_LABEL_TO_CLASS: Record<string, DetectionClass | undefined> = {
  person: 'person',
  car: 'car',
  motorcycle: 'motorcycle',
  bicycle: 'bicycle',
  bus: 'bus',
  truck: 'truck',
};

const DISPLAY_LABEL: Record<DetectionClass, string> = {
  person: 'Person',
  car: 'Car',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  bus: 'Bus',
  truck: 'Truck',
};

const emptyDecision = (): SafetyDecision => ({
  state: 'INACTIVE',
  risk: false,
  warning: false,
  alert: false,
  message: '',
  reason: 'Camera is stopped',
  candidate: null,
  candidateOverlap: 0,
  evaluatedAt: 0,
});

function bestCategory(categories: readonly { categoryName?: string; displayName?: string; score: number }[]) {
  return categories.reduce<(typeof categories)[number] | null>((best, category) => {
    if (!best || category.score > best.score) return category;
    return best;
  }, null);
}

function resultToDetections(result: DetectorResult, width: number, height: number, minConfidence: number): RawDetection[] {
  return result.detections.flatMap((detection) => {
    const category = bestCategory(detection.categories);
    const rawLabel = (category?.categoryName || category?.displayName || '').trim().toLowerCase();
    const className = MODEL_LABEL_TO_CLASS[rawLabel];
    const box = detection.boundingBox;
    const confidence = category?.score ?? 0;
    if (!className || !box || confidence < minConfidence || width <= 0 || height <= 0) return [];
    const normalized: NormalizedBox = {
      x: box.originX / width,
      y: box.originY / height,
      width: box.width / width,
      height: box.height / height,
    };
    return [{ className, label: rawLabel, confidence, box: normalized }];
  });
}

function cameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) return `Camera failed: ${error instanceof Error ? error.message : String(error)}`;
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site, then try Start Camera again.';
  }
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
    return 'No compatible camera was found. Connect a webcam or check the browser camera settings.';
  }
  if (error.name === 'NotReadableError') {
    return 'The camera is already in use by another application. Close it there and retry.';
  }
  return `Camera failed: ${error.message || error.name}`;
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  objects: readonly TrackedObject[],
  riskTrackId: number | null,
  zone: DangerZone,
  warningTrackId: number | null,
) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);

  const zoneX = zone.x * width;
  const zoneY = zone.y * height;
  const zoneW = zone.width * width;
  const zoneH = zone.height * height;
  const warning = warningTrackId !== null;
  const risk = riskTrackId !== null;
  context.fillStyle = warning ? 'rgba(255, 74, 86, 0.18)' : risk ? 'rgba(255, 184, 77, 0.16)' : 'rgba(61, 139, 255, 0.12)';
  context.fillRect(zoneX, zoneY, zoneW, zoneH);
  context.strokeStyle = warning ? '#ff6973' : risk ? '#ffc15c' : '#70aeff';
  context.lineWidth = Math.max(2, width / 360);
  context.setLineDash([10, 8]);
  context.strokeRect(zoneX, zoneY, zoneW, zoneH);
  context.setLineDash([]);
  context.font = `600 ${Math.max(12, width / 34)}px Segoe UI, sans-serif`;
  context.fillStyle = warning ? '#ffd5d8' : risk ? '#ffe0a3' : '#b8d5ff';
  context.fillText('DOOR ZONE · DEMO', zoneX + 10, zoneY + Math.max(18, width / 26));

  for (const object of objects) {
    const x = object.box.x * width;
    const y = object.box.y * height;
    const w = object.box.width * width;
    const h = object.box.height * height;
    const isWarning = object.trackId === warningTrackId;
    const isRisk = object.trackId === riskTrackId;
    const colour = isWarning ? '#ff5967' : isRisk ? '#ffc15c' : '#57e5a0';
    context.strokeStyle = colour;
    context.lineWidth = Math.max(2, width / 320);
    context.strokeRect(x, y, w, h);

    const label = `${DISPLAY_LABEL[object.className]} #${object.trackId} ${Math.round(object.confidence * 100)}%`;
    const labelHeight = Math.max(20, width / 27);
    const labelWidth = context.measureText(label).width + 16;
    const labelY = Math.max(labelHeight, y);
    context.fillStyle = isWarning ? 'rgba(94, 8, 18, 0.9)' : isRisk ? 'rgba(75, 43, 7, 0.92)' : 'rgba(4, 16, 24, 0.88)';
    context.fillRect(x, labelY - labelHeight, labelWidth, labelHeight);
    context.fillStyle = '#fff';
    context.fillText(label, x + 8, labelY - labelHeight / 3);

    context.beginPath();
    context.arc(object.center.x * width, object.center.y * height, Math.max(3, width / 150), 0, Math.PI * 2);
    context.fillStyle = colour;
    context.fill();
  }
}

async function createDetector(): Promise<ObjectDetectorT> {
  const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(ASSETS);
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO' as const,
    maxResults: 8,
    scoreThreshold: DETECTION_SCORE_THRESHOLD,
  });
  try {
    return await ObjectDetector.createFromOptions(fileset, options('GPU'));
  } catch {
    return ObjectDetector.createFromOptions(fileset, options('CPU'));
  }
}

function stateLabel(state: SafetyDecision['state'], doorState: SimulatedDoorState) {
  if (state === 'WARNING') return 'WARNING';
  if (state === 'CAMERA_ERROR') return 'CAMERA ERROR';
  if (doorState === 'OPEN') return 'DOOR OPEN';
  if (state === 'MONITORING') return 'MONITORING';
  return 'INACTIVE';
}

function stateReason(decision: SafetyDecision, cameraState: CameraState, error: string | null, doorState: SimulatedDoorState) {
  if (cameraState === 'starting') return 'Loading camera and local object model…';
  if (cameraState === 'error') return error ?? 'Camera unavailable';
  if (decision.state === 'WARNING') return decision.reason;
  if (doorState === 'OPEN') return 'Simulated door is open. Close or reset it before the next trial.';
  if (cameraState === 'inactive') return 'Start the camera to begin local monitoring';
  return decision.reason;
}

export function SafeExitGuardian({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const detectorRef = useRef<ObjectDetectorT | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef(new ObjectTracker());
  const safetyRef = useRef(new SafeExitSafetyEngine());
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const lastVideoTime = useRef(-1);
  const lastDetectionAt = useRef(-Infinity);
  const lastUiAt = useRef(-Infinity);
  const frameCount = useRef(0);
  const fpsAt = useRef(0);
  const processFrameRef = useRef<(timestamp: number) => void>(() => {});
  const configRef = useRef<SafetyConfig>(DEFAULT_SAFETY_CONFIG);
  const objectsRef = useRef<TrackedObject[]>([]);
  const soundMutedRef = useRef(false);

  const [cameraState, setCameraState] = useState<CameraState>('inactive');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [objects, setObjects] = useState<TrackedObject[]>([]);
  const [decision, setDecision] = useState<SafetyDecision>(emptyDecision);
  const [doorState, setDoorState] = useState<SimulatedDoorState>('CLOSED');
  const [soundMuted, setSoundMuted] = useState(false);
  const [config, setConfig] = useState<SafetyConfig>(DEFAULT_SAFETY_CONFIG);
  const [fps, setFps] = useState(0);
  const [showSettings, setShowSettings] = useState(false);

  const releaseResources = useCallback((resetUi: boolean) => {
    runningRef.current = false;
    window.cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    detectorRef.current?.close();
    detectorRef.current = null;
    if (video.current) video.current.srcObject = null;
    trackerRef.current.reset();
    safetyRef.current.reset();
    objectsRef.current = [];
    lastVideoTime.current = -1;
    lastDetectionAt.current = -Infinity;
    lastUiAt.current = -Infinity;
    frameCount.current = 0;
    fpsAt.current = 0;
    if (resetUi && mountedRef.current) {
      setCameraState('inactive');
      setCameraError(null);
      setObjects([]);
      setDecision(emptyDecision());
      setDoorState('CLOSED');
      setFps(0);
    }
  }, []);

  const processFrame = useCallback((timestamp: number) => {
    if (!runningRef.current) return;
    rafRef.current = window.requestAnimationFrame((nextTimestamp) => processFrameRef.current(nextTimestamp));
    const detector = detectorRef.current;
    const currentVideo = video.current;
    if (!detector || !currentVideo || currentVideo.readyState < 2 || currentVideo.currentTime === lastVideoTime.current) return;
    if (timestamp - lastDetectionAt.current < DETECTION_INTERVAL_MS) return;
    lastDetectionAt.current = timestamp;
    lastVideoTime.current = currentVideo.currentTime;

    try {
      const width = currentVideo.videoWidth || 640;
      const height = currentVideo.videoHeight || 480;
      const result = detector.detectForVideo(currentVideo, timestamp);
      const raw = resultToDetections(result, width, height, DETECTION_SCORE_THRESHOLD);
      const nextObjects = trackerRef.current.update(raw, timestamp);
      const nextDecision = safetyRef.current.evaluate({
        objects: nextObjects,
        cameraState: 'ready',
        now: timestamp,
        config: configRef.current,
      });
      objectsRef.current = nextObjects;
      drawOverlay(
        canvas.current!,
        width,
        height,
        nextObjects,
        nextDecision.risk ? nextDecision.candidate?.trackId ?? null : null,
        configRef.current.dangerZone,
        nextDecision.warning ? nextDecision.candidate?.trackId ?? null : null,
      );
      frameCount.current += 1;
      if (!fpsAt.current) fpsAt.current = timestamp;
      if (timestamp - fpsAt.current >= 1000) {
        setFps(frameCount.current);
        frameCount.current = 0;
        fpsAt.current = timestamp;
      }
      if (timestamp - lastUiAt.current >= UI_INTERVAL_MS || nextDecision.state === 'WARNING') {
        lastUiAt.current = timestamp;
        setObjects(nextObjects);
        setDecision(nextDecision);
      }
      if (nextDecision.alert && !soundMutedRef.current) {
        carAudio.unlock();
        carAudio.chime('error');
      }
    } catch (error) {
      runningRef.current = false;
      window.cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      detectorRef.current?.close();
      detectorRef.current = null;
      const message = `Local detection stopped: ${error instanceof Error ? error.message : String(error)}`;
      setCameraState('error');
      setCameraError(message);
      setDecision({ ...emptyDecision(), state: 'CAMERA_ERROR', reason: message });
    }
  }, []);

  const startCamera = useCallback(async () => {
    if (cameraState === 'starting' || cameraState === 'ready') return;
    carAudio.unlock();
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = 'This browser does not support webcam access. Use a current Chrome, Edge, or Safari build.';
      setCameraState('error');
      setCameraError(message);
      setDecision({ ...emptyDecision(), state: 'CAMERA_ERROR', reason: message });
      return;
    }
    releaseResources(false);
    trackerRef.current.reset();
    safetyRef.current.reset();
    objectsRef.current = [];
    setDoorState('CLOSED');
    setCameraState('starting');
    setCameraError(null);
    setObjects([]);
    setDecision(emptyDecision());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const currentVideo = video.current;
      if (!currentVideo) throw new Error('Camera preview is unavailable');
      currentVideo.srcObject = stream;
      await currentVideo.play();
      const detector = await createDetector();
      if (!mountedRef.current) {
        detector.close();
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      detectorRef.current = detector;
      runningRef.current = true;
      setCameraState('ready');
      rafRef.current = window.requestAnimationFrame(processFrame);
    } catch (error) {
      releaseResources(false);
      const message = cameraErrorMessage(error);
      setCameraState('error');
      setCameraError(message);
      setDecision({ ...emptyDecision(), state: 'CAMERA_ERROR', reason: message });
    }
  }, [cameraState, processFrame, releaseResources]);

  useEffect(() => {
    processFrameRef.current = processFrame;
    return () => { processFrameRef.current = () => {}; };
  }, [processFrame]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseResources(false);
    };
  }, [releaseResources]);

  const updateZone = (field: keyof DangerZone, value: number) => {
    setConfig((previous) => {
      const nextZone = { ...previous.dangerZone, [field]: value };
      if (field === 'x') nextZone.x = Math.min(nextZone.x, 1 - nextZone.width);
      if (field === 'y') nextZone.y = Math.min(nextZone.y, 1 - nextZone.height);
      if (field === 'width') nextZone.width = Math.min(nextZone.width, 1 - nextZone.x);
      if (field === 'height') nextZone.height = Math.min(nextZone.height, 1 - nextZone.y);
      const next = { ...previous, dangerZone: nextZone };
      configRef.current = next;
      return next;
    });
  };

  const updateConfig = (patch: Partial<SafetyConfig>) => {
    setConfig((previous) => {
      const next = { ...previous, ...patch };
      configRef.current = next;
      return next;
    });
  };

  const evaluateCurrentSafety = () => {
    const nextDecision = safetyRef.current.evaluate({
      objects: objectsRef.current,
      cameraState: 'ready',
      now: performance.now(),
      config: configRef.current,
    });
    setDecision(nextDecision);
    if (nextDecision.alert && !soundMutedRef.current) {
      carAudio.unlock();
      carAudio.chime('error');
    }
    return nextDecision;
  };

  const requestDoorOpen = () => {
    if (cameraState !== 'ready' || doorState === 'OPEN') return;
    carAudio.unlock();
    const nextDecision = evaluateCurrentSafety();
    const transition = transitionSimulatedDoor(doorState, 'OPEN_REQUEST');
    setDoorState(transition.state);
    setDecision(nextDecision.warning
      ? { ...nextDecision, reason: `${nextDecision.message} Door opened for the demonstration; check surroundings.` }
      : { ...nextDecision, reason: transition.message });
  };

  const closeDoor = () => {
    carAudio.unlock();
    setDoorState('CLOSED');
    if (cameraState === 'ready') {
      const nextDecision = evaluateCurrentSafety();
      setDecision(nextDecision.warning ? nextDecision : { ...nextDecision, reason: 'Door closed. Monitoring live detections.' });
    }
  };

  const resetDemo = () => {
    carAudio.unlock();
    safetyRef.current.reset();
    setDoorState('CLOSED');
    setDecision(cameraState === 'ready'
      ? { ...emptyDecision(), state: 'MONITORING', reason: 'Demo reset. Monitoring live detections.' }
      : emptyDecision());
  };

  const toggleSound = () => {
    setSoundMuted((previous) => {
      const next = !previous;
      soundMutedRef.current = next;
      return next;
    });
  };

  const detectedClasses = [...new Set(objects.map((object) => DISPLAY_LABEL[object.className]))];
  const statusClass = decision.state.toLowerCase().replace('_', '-');
  const statusIcon = decision.state === 'WARNING'
    ? <AlertTriangle />
    : decision.state === 'CAMERA_ERROR'
      ? <AlertTriangle />
      : decision.state === 'MONITORING'
        ? <ShieldCheck />
        : <ShieldAlert />;

  return (
    <section className={`safe-exit ${statusClass} door-${doorState.toLowerCase()}`} aria-label="Safe Exit Guardian">
      <header className="safe-exit-head">
        <div className="safe-exit-title">
          <ShieldAlert />
          <div>
            <b>Safe Exit Guardian</b>
            <small>Local object detection · demonstration heuristic</small>
          </div>
        </div>
        <div className="safe-exit-head-actions">
          <button onClick={toggleSound} aria-label={soundMuted ? 'Unmute warning sound' : 'Mute warning sound'} title={soundMuted ? 'Unmute warning sound' : 'Mute warning sound'}>
            {soundMuted ? <VolumeX /> : <Volume2 />}
          </button>
          <button onClick={onClose} aria-label="Close Safe Exit Guardian" title="Close"><X /></button>
        </div>
      </header>

      <div className="safe-exit-cam">
        <video ref={video} muted playsInline aria-label="Safe Exit Guardian webcam preview" />
        <canvas ref={canvas} aria-hidden="true" />
        <div className="safe-exit-cam-badge">
          <span className={`safe-exit-live-dot ${cameraState}`} />
          <span>{cameraState === 'ready' ? 'CAMERA CONNECTED' : cameraState === 'starting' ? 'STARTING CAMERA' : 'CAMERA OFF'}</span>
        </div>
        {cameraState !== 'ready' && (
          <div className="safe-exit-cam-message">
            <Camera />
            <b>{cameraState === 'error' ? 'Camera needs attention' : 'Start local monitoring'}</b>
            <span>{cameraError ?? 'Frames stay in this browser and are not uploaded or stored.'}</span>
            <button onClick={() => void startCamera()} disabled={cameraState === 'starting'}>
              {cameraState === 'starting' ? 'Loading…' : cameraState === 'error' ? 'Retry Camera' : 'Start Camera'}
            </button>
          </div>
        )}
      </div>

      <div className={`safe-exit-status ${doorState.toLowerCase()}`} aria-live="polite">
        {statusIcon}
        <div>
          <b>{cameraState === 'starting' ? 'STARTING' : stateLabel(decision.state, doorState)}</b>
          <span>{stateReason(decision, cameraState, cameraError, doorState)}</span>
        </div>
      </div>

      <div className="safe-exit-door-row">
        <div className={`safe-exit-door-state ${doorState.toLowerCase()}`}>
          <DoorOpen />
          <div><small>SIMULATED DOOR</small><b>{doorState}</b></div>
        </div>
        <div className="safe-exit-door-actions">
          <button className="safe-exit-open" onClick={requestDoorOpen} disabled={cameraState !== 'ready' || doorState === 'OPEN'}>
            <DoorOpen /> Open Door
          </button>
          {doorState === 'OPEN' && <button className="safe-exit-close" onClick={closeDoor}><X /> Close</button>}
          <button className="safe-exit-reset-inline" onClick={resetDemo} title="Reset door state and temporal confirmation"><RefreshCw /> Reset</button>
        </div>
      </div>

      <div className="safe-exit-controls">
        {cameraState === 'ready' ? (
          <button className="safe-exit-stop" onClick={() => releaseResources(true)}><X /> Stop Camera</button>
        ) : (
          <button className="safe-exit-start" onClick={() => void startCamera()} disabled={cameraState === 'starting'}><Camera /> Start Camera</button>
        )}
      </div>

      <div className="safe-exit-metrics">
        <div><small>Objects</small><b>{objects.length}</b></div>
        <div><small>Classes</small><b>{detectedClasses.length ? detectedClasses.join(', ') : '—'}</b></div>
        <div><small>Process</small><b>{fps ? `${fps} FPS` : '—'}</b></div>
      </div>

      <div className="safe-exit-list">
        <div className="safe-exit-list-head"><span>Tracked objects</span><small>{objects.length ? 'IDs persist across short gaps' : 'No supported object in view'}</small></div>
        {objects.length > 0 ? objects.map((object) => (
          <div key={object.trackId} className={`safe-exit-object ${decision.warning && decision.candidate?.trackId === object.trackId ? 'candidate' : decision.risk && decision.candidate?.trackId === object.trackId ? 'risk' : ''}`}>
            <span className="safe-exit-object-dot" />
            <div><b>{DISPLAY_LABEL[object.className]} <em>#{object.trackId}</em></b><small>{Math.round(object.confidence * 100)}% · {object.movement.direction} · {object.movement.sizeTrend}</small></div>
            <span className="safe-exit-object-state">{object.confirmed ? 'TRACKED' : 'SEEN'}</span>
          </div>
        )) : (
          <p className="safe-exit-empty">{cameraState === 'ready' ? 'Move a supported person, car, motorcycle, bicycle, bus, or truck into view.' : 'Start the camera to see local detections.'}</p>
        )}
      </div>

      <div className="safe-exit-settings-toggle">
        <button onClick={() => setShowSettings((value) => !value)} aria-expanded={showSettings}><SlidersHorizontal /> <span>Detection &amp; danger-zone settings</span><strong>{showSettings ? 'Hide' : 'Show'}</strong></button>
      </div>
      {showSettings && (
        <div className="safe-exit-settings">
          <label className="safe-exit-range"><span>Safety confidence</span><input type="range" min="0.3" max="0.9" step="0.05" value={config.minConfidence} onChange={(event) => updateConfig({ minConfidence: Number(event.target.value) })} /><em>{Math.round(config.minConfidence * 100)}%</em></label>
          <label className="safe-exit-range"><span>Confirmation frames</span><input type="range" min="2" max="8" step="1" value={config.confirmationFrames} onChange={(event) => updateConfig({ confirmationFrames: Number(event.target.value) })} /><em>{config.confirmationFrames}</em></label>
          <label className="safe-exit-range"><span>Zone left edge</span><input type="range" min="0.2" max="0.78" step="0.01" value={config.dangerZone.x} onChange={(event) => updateZone('x', Number(event.target.value))} /><em>{Math.round(config.dangerZone.x * 100)}%</em></label>
          <label className="safe-exit-range"><span>Zone width</span><input type="range" min="0.16" max="0.62" step="0.01" value={config.dangerZone.width} onChange={(event) => updateZone('width', Number(event.target.value))} /><em>{Math.round(config.dangerZone.width * 100)}%</em></label>
          <label className="safe-exit-range"><span>Zone top</span><input type="range" min="0.05" max="0.65" step="0.01" value={config.dangerZone.y} onChange={(event) => updateZone('y', Number(event.target.value))} /><em>{Math.round(config.dangerZone.y * 100)}%</em></label>
          <label className="safe-exit-range"><span>Zone height</span><input type="range" min="0.18" max="0.82" step="0.01" value={config.dangerZone.height} onChange={(event) => updateZone('height', Number(event.target.value))} /><em>{Math.round(config.dangerZone.height * 100)}%</em></label>
          <button className="safe-exit-reset" onClick={() => { configRef.current = DEFAULT_SAFETY_CONFIG; setConfig(DEFAULT_SAFETY_CONFIG); }}><RefreshCw /> Reset demonstration zone</button>
        </div>
      )}

      <p className="safe-exit-note">
        {decision.warning
          ? <><AlertTriangle /> {decision.message}</>
          : <><CheckCircle2 /> Only an approaching object inside the configured door zone triggers a warning.</>}
        <span>This is an image-space demo heuristic, not calibrated blind-spot, distance, speed, or collision detection.</span>
      </p>
    </section>
  );
}
