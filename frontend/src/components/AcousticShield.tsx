import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Clapperboard, Ear, Map as MapIcon, OctagonX, Orbit, Pause, Play, Plus, Radar, RotateCcw, SlidersHorizontal, Snail, Trash2, Video, Volume2, VolumeX, X } from 'lucide-react';
import { DEFAULT_CONFIG, DEG, cloneConfig, fromKmh, toKmh, type AcousticShieldConfig } from '../acoustic/config';
import { LEVEL_COLORS, ShieldScene, type CameraMode } from '../acoustic/scene3d';
import { SCENARIOS } from '../acoustic/scenarios';
import { AcousticShieldSimulation, type HistorySample } from '../acoustic/simulation';
import { MAX_PINK_LEVEL, PinkNoiseSink } from '../acoustic/pinkNoise';
import { norm, wrapAngle } from '../acoustic/vehicle';
import type { ThreatLevel } from '../acoustic/decision';
import '@fontsource-variable/manrope/wght.css';
import './AcousticShield.css';

type RunState = 'idle' | 'running' | 'paused' | 'ended';

const TIME_SCALES = [0.1, 0.25, 0.5, 1, 2];
const STEPS = [
  { title: 'Detect', text: 'Radar tracks every car around the Hyundai.' },
  { title: 'Predict', text: 'Paths are projected ahead to find a collision.' },
  { title: 'Protect', text: 'A short sound primes the ear before the crash noise.' },
  { title: 'Impact', text: 'Shield timing is checked against the moment of impact.' },
];
const fmt = (n: number | null | undefined, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits));
const deg = (rad: number) => (rad / DEG);

function Slider({ label, value, min, max, step, unit, digits = 0, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit?: string; digits?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="acs-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--pct': `${((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100}%` } as CSSProperties} />
      <em>{fmt(value, digits)}{unit ? ` ${unit}` : ''}</em>
    </label>
  );
}

/** Top-down sketch of each scenario: white = Hyundai, red outline = other car, arrows = direction of travel. */
function ScenarioGlyph({ id }: { id: string }) {
  const m = `ah-${id}`;
  const car = (x: number, y: number, w: number, h: number, ego = false) => <rect x={x} y={y} width={w} height={h} rx={1.6} className={ego ? 'g-ego' : 'g-other'} />;
  const go = (d: string) => <path d={d} className="g-path" markerEnd={`url(#${m})`} />;
  const stop = (d: string) => <path d={d} className="g-stop" />;
  const art: Record<string, ReactNode> = {
    side: <>{car(12, 19, 6, 9, true)}{go('M15 18 V12')}{car(1, 9, 8, 5)}{go('M10 11.5 H17')}</>,
    rear: <>{car(12, 3, 6, 9, true)}{go('M15 2.5 V1')}{car(12, 20, 6, 9)}{go('M15 19 V15')}</>,
    headon: <>{car(12, 19, 6, 9, true)}{go('M15 18 V14')}{car(12, 2, 6, 9)}{go('M15 12 V15.5')}</>,
    nearmiss: <>{car(12, 19, 6, 9, true)}{go('M15 18 V12')}{car(20, 6, 8, 5)}<path d="M3 8.5 H18" className="g-trail" /></>,
    avoided: <>{car(12, 19, 6, 9, true)}{go('M15 18 V12')}{car(1, 9, 8, 5)}{stop('M11 7.5 V15.5')}</>,
    stationary: <>{car(12, 19, 6, 9, true)}{go('M15 18 V13')}{car(12, 2, 6, 9)}{stop('M10.5 12.5 H19.5')}</>,
  };
  return (
    <svg className="acs-glyph" viewBox="0 0 30 30" aria-hidden="true">
      <defs><marker id={m} viewBox="0 0 6 6" refX={3} refY={3} markerWidth={4} markerHeight={4} orient="auto"><path d="M0 0 L6 3 L0 6 z" className="g-head" /></marker></defs>
      {art[id] ?? car(12, 19, 6, 9, true)}
    </svg>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="acs-section">
      <header><h3>{title}</h3>{aside}</header>
      {children}
    </section>
  );
}

function Row({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="acs-row">
      <span>{label}</span>
      <b style={tone ? { color: tone } : undefined}>{value}</b>
      {sub !== undefined && <small>{sub}</small>}
    </div>
  );
}

function Timeline({ history, config, activationT, impactT }: { history: HistorySample[]; config: AcousticShieldConfig; activationT: number | null; impactT: number | null }) {
  const W = 320;
  const H = 120;
  const horizon = config.prediction.horizonS;
  const tEnd = Math.max(history.at(-1)?.t ?? 0, 1);
  const tStart = Math.max(0, tEnd - 15);
  const x = (t: number) => ((t - tStart) / Math.max(0.001, tEnd - tStart)) * W;
  const y = (ttc: number) => H - (Math.min(ttc, horizon) / horizon) * H;
  const pathOf = (key: 'ttc' | 'ttcTruth') => {
    let d = '';
    let pen = false;
    for (const s of history) {
      if (s.t < tStart) continue;
      const v = s[key];
      if (v === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const active: { a: number; b: number }[] = [];
  for (const s of history) {
    if (s.t < tStart || !s.active) continue;
    const last = active.at(-1);
    if (last && s.t - last.b < 0.11) last.b = s.t;
    else active.push({ a: s.t, b: s.t });
  }
  const threshold = (v: number, label: string, color: string) => (
    <g key={label}>
      <line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke={color} strokeDasharray="3 4" strokeWidth={1} opacity={0.75} />
      <text x={W - 2} y={y(v) - 3} textAnchor="end" fill={color}>{label} {v.toFixed(2)} s</text>
    </g>
  );
  return (
    <svg className="acs-timeline" viewBox={`0 0 ${W} ${H + 16}`} preserveAspectRatio="none" role="img" aria-label="Predicted time to collision over simulation time">
      {active.map((r, i) => <rect key={i} x={x(r.a)} y={0} width={Math.max(2, x(r.b) - x(r.a))} height={H} fill="#ff4d57" opacity={0.16} />)}
      {threshold(config.decision.warningTtcS, 'warning', LEVEL_COLORS.WARNING)}
      {threshold(config.decision.criticalTtcS, 'critical', LEVEL_COLORS.CRITICAL)}
      {threshold(config.protection.requiredLeadTimeS, 'lead', '#9aa6b8')}
      <path d={pathOf('ttcTruth')} fill="none" stroke="#ffffff" strokeOpacity={0.45} strokeDasharray="2 3" strokeWidth={1.2} />
      <path d={pathOf('ttc')} fill="none" stroke="#5cc8ff" strokeWidth={1.8} />
      {activationT !== null && activationT >= tStart && <line x1={x(activationT)} x2={x(activationT)} y1={0} y2={H} stroke="#ff4d57" strokeWidth={1.5} />}
      {impactT !== null && impactT >= tStart && <line x1={x(impactT)} x2={x(impactT)} y1={0} y2={H} stroke="#ffffff" strokeWidth={1.5} />}
      <line x1={0} x2={W} y1={H} y2={H} stroke="rgba(255,255,255,0.2)" />
      <text x={2} y={H + 12}>{tStart.toFixed(1)} s</text>
      <text x={W - 2} y={H + 12} textAnchor="end">{tEnd.toFixed(1)} s</text>
      <text x={2} y={10}>TTC {horizon.toFixed(0)} s</text>
    </svg>
  );
}

function StapediusIllustration({ active }: { active: boolean }) {
  return (
    <div className={`acs-ear ${active ? 'active' : ''}`}>
      <svg viewBox="0 0 220 96" role="img" aria-label="Illustrative middle-ear schematic">
        <path className="canal" d="M4 40 H70 M4 60 H70" />
        {[0, 1, 2].map((i) => <path key={i} className="wave" style={{ animationDelay: `${i * 0.25}s` }} d="M14 38 Q22 50 14 62" />)}
        <ellipse className="drum" cx={74} cy={50} rx={5} ry={22} />
        <path className="ossicle" d="M78 38 L98 30 L112 36" />
        <path className="ossicle" d="M112 36 L124 50" />
        <path className="ossicle stapes" d="M124 46 L140 46 M124 54 L140 54 M140 42 V58" />
        <rect className="window" x={141} y={40} width={4} height={20} rx={1} />
        <path className="muscle" d="M132 50 C140 72 168 80 190 74" />
        <text x={150} y={92}>stapedius</text>
        <text x={4} y={92}>stimulus</text>
        <text x={100} y={22}>ossicles</text>
      </svg>
      <p>{active ? 'Preconditioning stimulus playing: reflex contraction shown schematically.' : 'Idle.'} Illustrative only, not a physiological model; no biological response is simulated or implied.</p>
    </div>
  );
}

export function AcousticShield({ onClose }: { onClose: () => void }) {
  const [audio] = useState(() => new PinkNoiseSink());
  const [sim] = useState(() => new AcousticShieldSimulation(SCENARIOS[0], DEFAULT_CONFIG, [audio]));
  const [config, setConfigState] = useState<AcousticShieldConfig>(() => cloneConfig(DEFAULT_CONFIG));
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [run, setRun] = useState<RunState>('idle');
  const [timeScale, setTimeScale] = useState(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>('cinematic');
  const [selectedId, setSelectedId] = useState<string | null>('t1');
  const [showTruth, setShowTruth] = useState(false);
  const [showRadar, setShowRadar] = useState(false);
  // Presenter mode shows a few demo controls; Advanced brings back the full engineering panels.
  const [advanced, setAdvanced] = useState(false);
  const [speeds, setSpeeds] = useState(() => ({ ego: toKmh(SCENARIOS[0].ego.speed), other: toKmh(SCENARIOS[0].targets[0]?.speed ?? 0) }));
  const [lateral, setLateral] = useState<Record<string, number>>({});
  const [noiseScale, setNoiseScale] = useState(1);
  const [audioUi, setAudioUi] = useState({ enabled: false, muted: false, level: audio.level });
  const [, setFrame] = useState(0);
  const bump = useCallback(() => setFrame((f) => f + 1), []);

  const viewportRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ShieldScene | null>(null);
  const live = useRef({ run, timeScale, selectedId, showTruth, showRadar });
  useEffect(() => { live.current = { run, timeScale, selectedId, showTruth, showRadar }; }, [run, timeScale, selectedId, showTruth, showRadar]);

  // Render loop: physics advances on the fixed-step accumulator, rendering every animation frame.
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    const scene = new ShieldScene(container);
    sceneRef.current = scene;
    scene.onPick = (id) => setSelectedId(id === 'ego' ? null : id);
    let last = performance.now();
    let uiTimer = 0;
    let raf = 0;
    const frame = (ts: number) => {
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      const s = live.current;
      if (s.run === 'running') {
        sim.advance(dt * s.timeScale);
        if (sim.ended) setRun('ended');
      }
      scene.render(sim, { dt, selectedId: s.selectedId, showTruth: s.showTruth, showRadar: s.showRadar });
      uiTimer += dt;
      if (uiTimer >= 0.1) { uiTimer = 0; bump(); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    rootRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [sim, bump]);

  useEffect(() => () => audio.dispose(), [audio]);
  useEffect(() => { sceneRef.current?.setCameraMode(cameraMode); }, [cameraMode]);
  useEffect(() => { audio.setPaused(run !== 'running'); }, [audio, run]);

  const applyConfig = (next: AcousticShieldConfig) => {
    setConfigState(next);
    sim.setConfig(next);
    if (!sim.ended) sim.evaluate();
    bump();
  };

  const loadScenario = (id: string) => {
    const sc = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
    setScenarioId(sc.id);
    sim.load(sc);
    setLateral({});
    setSelectedId(sc.targets[0]?.id ?? null);
    setSpeeds({ ego: toKmh(sc.ego.speed), other: toKmh(sc.targets[0]?.speed ?? 0) });
    setRun('idle');
    bump();
  };

  // Presenter speeds: before Start they set the starting speed; while running the Hyundai cruises to the new
  // set speed and the other car changes speed at once. Replay keeps the presenter's chosen speeds.
  const applySpeeds = (s: { ego: number; other: number }, running: boolean) => {
    if (!running) sim.ego.speed = fromKmh(s.ego);
    sim.setEgoSetSpeed(fromKmh(s.ego));
    const other = sim.targets[0];
    if (other) sim.updateTarget(other.id, { speed: fromKmh(s.other) });
    else if (!sim.ended) sim.evaluate();
    bump();
  };
  const changeSpeeds = (patch: Partial<{ ego: number; other: number }>) => {
    const next = { ...speeds, ...patch };
    setSpeeds(next);
    if (sim.ended) return;
    // A new speed for a car that "Brake other car" stopped means it drives on: release that brake.
    const other = sim.targets[0];
    if (patch.other !== undefined && other && other.accel < -1) sim.updateTarget(other.id, { accel: 0 });
    applySpeeds(next, run === 'running' || run === 'paused');
  };

  // Hold-to-brake for pointer and keyboard (Space/Enter); releasing, leaving or losing focus lets go.
  const setBrake = (on: boolean) => { if (sim.egoBraking !== on) { sim.setEgoBraking(on); bump(); } };
  const holdBrake = {
    onPointerDown: () => setBrake(true),
    onPointerUp: () => setBrake(false),
    onPointerLeave: () => setBrake(false),
    onBlur: () => setBrake(false),
    onKeyDown: (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setBrake(true); } },
    onKeyUp: (e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') setBrake(false); },
  };

  const reset = () => {
    if (advanced) { loadScenario(scenarioId); return; }
    sim.load(scenario);
    applySpeeds(speeds, false);
    setSelectedId(sim.targets[0]?.id ?? null);
    setRun('idle');
  };

  // Telemetry focus: the selected target, else the most critical one, else the first.
  const focusId = (selectedId && sim.targets.some((t) => t.id === selectedId) ? selectedId : null)
    ?? sim.assessment.primary?.targetId ?? sim.targets[0]?.id ?? null;
  const target = sim.targets.find((t) => t.id === focusId) ?? null;
  const editTarget = sim.targets.find((t) => t.id === selectedId) ?? null;
  const pred = focusId ? sim.predictions.get(focusId) ?? null : null;
  const truth = focusId ? sim.truthPredictions.get(focusId) ?? null : null;
  const track = sim.trackViews.find((v) => v.track.objectId === focusId) ?? null;
  const assess = sim.assessment.targets.find((t) => t.targetId === focusId) ?? null;
  const level: ThreatLevel = sim.assessment.level;
  const protection = sim.protection;
  const activation = protection.activations.at(-1) ?? null;
  const active = protection.state === 'ACTIVE';
  const placement = editTarget ? sim.placementOf(editTarget.id) : null;
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const events = sim.events.slice(-80).reverse();

  // Presenter story: 0 watching, 1 collision predicted, 2 shield active, 3 impact.
  const stepIndex = sim.contact ? 3 : active ? 2 : pred?.collision ? 1 : 0;
  const statusTitle = protection.state === 'IMPACT' ? 'Impact reached'
    : active ? 'Acoustic Shield Active'
      : protection.state === 'ARMED' ? 'Armed: collision warning'
        : 'Standby';

  const setSensor = (patch: Partial<AcousticShieldConfig['sensor']>) => applyConfig({ ...config, sensor: { ...config.sensor, ...patch } });
  const setNoise = (k: number) => {
    setNoiseScale(k);
    const d = DEFAULT_CONFIG.sensor;
    setSensor({ rangeNoiseM: d.rangeNoiseM * k, azimuthNoiseDeg: d.azimuthNoiseDeg * k, rangeRateNoiseMps: d.rangeRateNoiseMps * k, orientationNoiseDeg: d.orientationNoiseDeg * k });
  };

  const placeEdit = (patch: Partial<{ distance: number; bearing: number }>) => {
    if (!editTarget || !placement) return;
    sim.placeTarget(editTarget.id, { distance: patch.distance ?? placement.distance, bearing: patch.bearing ?? placement.bearing, lateral: 0 });
    bump();
  };
  const setLane = (value: number) => {
    if (!editTarget || !placement) return;
    const prev = lateral[editTarget.id] ?? 0;
    sim.placeTarget(editTarget.id, { ...placement, lateral: value - prev });
    setLateral({ ...lateral, [editTarget.id]: value });
    bump();
  };
  const edit = (patch: Parameters<AcousticShieldSimulation['updateTarget']>[1]) => {
    if (!editTarget) return;
    sim.updateTarget(editTarget.id, patch);
    bump();
  };

  const toggleAudio = async () => {
    if (audio.enabled) audio.disable();
    else await audio.enable();
    setAudioUi((a) => ({ ...a, enabled: audio.enabled }));
  };

  return (
    <div
      ref={rootRef}
      className={`acs level-${level.toLowerCase()} ${active ? 'shield-active' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Acoustic Shield Simulator"
      tabIndex={-1}
      // Keep cockpit shortcuts (W/S, Space, Z) from firing while the simulator is open.
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <header className="acs-head">
        <div className="acs-title">
          <Ear />
          <div>
            <b>Hyundai Acoustic Shield</b>
            <small>{advanced ? 'Collision prediction & pre-impact acoustic preconditioning · engineering simulator' : 'Predicts a crash and protects your hearing before impact'}</small>
          </div>
        </div>
        <div className="acs-transport">
          {advanced && (
            <select value={scenarioId} disabled={run === 'running'} onChange={(e) => loadScenario(e.target.value)} aria-label="Scenario">
              {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {run === 'idle' && <button className="primary" onClick={() => setRun('running')}><Play /> Start</button>}
          {run === 'running' && <button onClick={() => setRun('paused')}><Pause /> Pause</button>}
          {run === 'paused' && <button className="primary" onClick={() => setRun('running')}><Play /> Resume</button>}
          {run === 'ended' && <button className="primary" onClick={() => { reset(); setRun('running'); }}><RotateCcw /> Replay</button>}
          <button onClick={reset}><RotateCcw /> Reset</button>
          {advanced ? (
            <label className="acs-scale">
              <span>Speed</span>
              <select value={timeScale} onChange={(e) => setTimeScale(Number(e.target.value))} aria-label="Simulation time scale">
                {TIME_SCALES.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            </label>
          ) : (
            <button className={timeScale < 1 ? 'on' : ''} onClick={() => setTimeScale(timeScale < 1 ? 1 : 0.25)} aria-pressed={timeScale < 1}><Snail /> Slow motion</button>
          )}
          <div className="acs-seg" role="group" aria-label="Camera">
            <button className={cameraMode === 'cinematic' ? 'on' : ''} onClick={() => setCameraMode('cinematic')} title="Keeps both cars in frame"><Clapperboard /> Cinematic</button>
            <button className={cameraMode === 'chase' ? 'on' : ''} onClick={() => setCameraMode('chase')} title="Third-person follow camera"><Video /> Chase</button>
            <button className={cameraMode === 'orbit' ? 'on' : ''} onClick={() => setCameraMode('orbit')} title="Drag to rotate, scroll to zoom; follows the Hyundai"><Orbit /> Orbit</button>
            <button className={cameraMode === 'top' ? 'on' : ''} onClick={() => setCameraMode('top')} title="Bird's-eye technical view"><MapIcon /> Top</button>
          </div>
          <button className={advanced ? 'on' : ''} onClick={() => setAdvanced(!advanced)} aria-pressed={advanced} title="Show every engineering parameter"><SlidersHorizontal /> Advanced</button>
        </div>
        <button className="acs-close" onClick={onClose} aria-label="Close simulator"><X /></button>
      </header>

      <div className={`acs-body ${advanced ? '' : 'simple'}`}>
        {!advanced && (
          <aside className="acs-panel acs-left acs-presenter">
            <div className="acs-p-group">
              <h3>Scenario</h3>
              <div className="acs-scn-list" role="radiogroup" aria-label="Scenario">
                {SCENARIOS.map((s) => (
                  <button key={s.id} role="radio" aria-checked={s.id === scenarioId} className={`acs-scn ${s.id === scenarioId ? 'on' : ''}`} disabled={run === 'running'} onClick={() => loadScenario(s.id)}>
                    <ScenarioGlyph id={s.id} />
                    <span>{s.name.split(' · ')[1] ?? s.name}</span>
                  </button>
                ))}
              </div>
              <p className="acs-scn-summary">{scenario.summary}</p>
            </div>
            <div className="acs-p-group">
              <h3>Speed</h3>
              <Slider label="Hyundai" value={speeds.ego} min={0} max={120} step={5} unit="km/h" onChange={(v) => changeSpeeds({ ego: v })} />
              {sim.targets[0] && <Slider label={sim.targets[0].label} value={speeds.other} min={0} max={120} step={5} unit="km/h" onChange={(v) => changeSpeeds({ other: v })} />}
            </div>
            <div className="acs-p-group">
              <h3>Driver input</h3>
              <button
                className={`acs-act ${sim.egoBraking ? 'on' : ''}`}
                disabled={run !== 'running'}
                {...holdBrake}
              ><b>Brake Hyundai</b><small>Hold · {config.egoControl.maxBrakeMps2} m/s²</small></button>
              {sim.targets[0] && (
                <button
                  className={`acs-act ${sim.targets[0].accel < -1 ? 'on' : ''}`}
                  disabled={run !== 'running' || sim.targets[0].accel < -1}
                  onClick={() => { sim.updateTarget(sim.targets[0].id, { accel: -8 }); bump(); }}
                ><b>{sim.targets[0].accel < -1 ? 'Other car braking' : 'Brake other car'}</b><small>Emergency stop · 8 m/s²</small></button>
              )}
              {run !== 'running' && <p className="acs-hint">Available while the scenario is running.</p>}
            </div>
            <div className="acs-toggles">
              <button className={audioUi.enabled ? 'on' : ''} onClick={() => void toggleAudio()} aria-pressed={audioUi.enabled}><Volume2 /> Sound</button>
              <button className={showRadar ? 'on' : ''} onClick={() => setShowRadar(!showRadar)} aria-pressed={showRadar}><Radar /> Sensors</button>
            </div>
          </aside>
        )}
        {advanced && <aside className="acs-panel acs-left">
          <Section title="Scenario">
            <p className="acs-note">{scenario.summary}</p>
            <p className="acs-note dim">Expected: {scenario.expectation}</p>
          </Section>

          <Section title="Hyundai (ego)">
            <Slider label="Set speed" value={toKmh(sim.egoSetSpeed)} min={0} max={120} step={1} unit="km/h" onChange={(v) => { sim.setEgoSetSpeed(fromKmh(v)); bump(); }} />
            <button
              className={`acs-brake ${sim.egoBraking ? 'on' : ''}`}
              {...holdBrake}
            ><OctagonX /> Hold to brake ({config.egoControl.maxBrakeMps2} m/s²)</button>
          </Section>

          <Section title="Vehicles" aside={<button className="acs-mini" onClick={() => { const v = sim.addTarget(); setSelectedId(v.id); bump(); }}><Plus /> Add</button>}>
            <div className="acs-vehicles">
              {sim.targets.map((t) => {
                const a = sim.assessment.targets.find((x) => x.targetId === t.id);
                const p = sim.predictions.get(t.id);
                return (
                  <button key={t.id} className={`acs-vehicle ${selectedId === t.id ? 'on' : ''}`} onClick={() => setSelectedId(t.id)}>
                    <i style={{ background: LEVEL_COLORS[a?.level ?? 'NORMAL'] }} />
                    <span>{t.label}</span>
                    <small>{a ? (p?.ttc !== null && p?.ttc !== undefined ? `TTC ${p.ttc.toFixed(2)} s` : a.level) : 'not tracked'}</small>
                  </button>
                );
              })}
              {!sim.targets.length && <p className="acs-note dim">No other vehicles. Add one to begin.</p>}
            </div>
            <p className="acs-note dim">Click a vehicle in the 3D view to select it.</p>
          </Section>

          {editTarget && placement && (
            <Section title={`Configure: ${editTarget.label}`} aside={<button className="acs-mini" onClick={() => { sim.removeTarget(editTarget.id); setSelectedId(sim.targets[0]?.id ?? null); bump(); }} title="Remove vehicle"><Trash2 /></button>}>
              <Slider label="Speed" value={toKmh(editTarget.speed)} min={0} max={150} step={1} unit="km/h" onChange={(v) => edit({ speed: fromKmh(v) })} />
              <Slider label="Accel / brake" value={editTarget.accel} min={-9} max={4} step={0.1} digits={1} unit="m/s²" onChange={(v) => edit({ accel: v })} />
              <Slider label="Direction (rel. Hyundai)" value={deg(wrapAngle(editTarget.heading - sim.ego.heading))} min={-180} max={180} step={1} unit="°" onChange={(v) => edit({ heading: sim.ego.heading + v * DEG })} />
              <Slider label="Yaw rate" value={deg(editTarget.yawRate)} min={-30} max={30} step={1} unit="°/s" onChange={(v) => edit({ yawRate: v * DEG })} />
              <div className="acs-subhead">Placement (moves the vehicle immediately)</div>
              <Slider label="Distance" value={placement.distance} min={5} max={200} step={0.5} digits={1} unit="m" onChange={(v) => placeEdit({ distance: v })} />
              <Slider label="Approach angle" value={deg(placement.bearing)} min={-180} max={180} step={1} unit="°" onChange={(v) => placeEdit({ bearing: v * DEG })} />
              <Slider label="Lane offset" value={lateral[editTarget.id] ?? 0} min={-7} max={7} step={0.25} digits={2} unit="m" onChange={setLane} />
              <div className="acs-subhead">Dimensions</div>
              <Slider label="Length" value={editTarget.length} min={3} max={12} step={0.1} digits={1} unit="m" onChange={(v) => edit({ length: v })} />
              <Slider label="Width" value={editTarget.width} min={1.4} max={2.6} step={0.05} digits={2} unit="m" onChange={(v) => edit({ width: v })} />
            </Section>
          )}

          <Section title="Sensor model (simulated)">
            <p className="acs-note dim">Measurements are generated from the simulator, not from radar hardware.</p>
            <Slider label="Noise scale" value={noiseScale} min={0} max={4} step={0.1} digits={1} unit="×" onChange={setNoise} />
            <Slider label="Latency" value={config.sensor.latencyS * 1000} min={0} max={300} step={5} unit="ms" onChange={(v) => setSensor({ latencyS: v / 1000 })} />
            <Slider label="Update rate" value={config.sensor.updateRateHz} min={5} max={50} step={1} unit="Hz" onChange={(v) => setSensor({ updateRateHz: v })} />
            <Slider label="Range" value={config.sensor.maxRangeM} min={30} max={250} step={5} unit="m" onChange={(v) => setSensor({ maxRangeM: v })} />
            <Slider label="Field of view" value={config.sensor.fovDeg} min={60} max={360} step={10} unit="°" onChange={(v) => setSensor({ fovDeg: v })} />
            <Slider label="Dropout" value={config.sensor.dropoutProbability * 100} min={0} max={80} step={1} unit="%" onChange={(v) => setSensor({ dropoutProbability: v / 100 })} />
            <Slider label="Corrupt samples" value={config.sensor.invalidProbability * 100} min={0} max={30} step={1} unit="%" onChange={(v) => setSensor({ invalidProbability: v / 100 })} />
            <label className="acs-check"><input type="checkbox" checked={config.sensor.occlusion} onChange={(e) => setSensor({ occlusion: e.target.checked })} /> Buildings block radar (line of sight)</label>
            <label className="acs-check"><input type="checkbox" checked={config.sensor.blackout} onChange={(e) => setSensor({ blackout: e.target.checked })} /> Sensor blackout (stale data)</label>
          </Section>

          <Section title="Decision thresholds (prototype)">
            <Slider label="Horizon" value={config.prediction.horizonS} min={3} max={10} step={0.5} digits={1} unit="s" onChange={(v) => applyConfig({ ...config, prediction: { ...config.prediction, horizonS: v } })} />
            <Slider label="Warning TTC" value={config.decision.warningTtcS} min={1} max={6} step={0.1} digits={1} unit="s" onChange={(v) => applyConfig({ ...config, decision: { ...config.decision, warningTtcS: Math.max(v, config.decision.criticalTtcS) } })} />
            <Slider label="Critical TTC" value={config.decision.criticalTtcS} min={0.3} max={3} step={0.05} digits={2} unit="s" onChange={(v) => applyConfig({ ...config, decision: { ...config.decision, criticalTtcS: Math.min(v, config.decision.warningTtcS) } })} />
            <Slider label="Required lead" value={config.protection.requiredLeadTimeS} min={0.05} max={1} step={0.05} digits={2} unit="s" onChange={(v) => applyConfig({ ...config, protection: { ...config.protection, requiredLeadTimeS: v } })} />
            <Slider label="Min closing speed" value={config.decision.minClosingSpeedMps} min={0} max={5} step={0.1} digits={1} unit="m/s" onChange={(v) => applyConfig({ ...config, decision: { ...config.decision, minClosingSpeedMps: v } })} />
            <Slider label="Min track confidence" value={config.decision.minTrackConfidence * 100} min={20} max={95} step={1} unit="%" onChange={(v) => applyConfig({ ...config, decision: { ...config.decision, minTrackConfidence: v / 100 } })} />
            <Slider label="Data freshness limit" value={config.decision.maxSensorAgeS * 1000} min={50} max={1000} step={10} unit="ms" onChange={(v) => applyConfig({ ...config, decision: { ...config.decision, maxSensorAgeS: v / 1000 } })} />
            <button className="acs-mini wide" onClick={() => { setNoiseScale(1); applyConfig(cloneConfig(DEFAULT_CONFIG)); }}><RotateCcw /> Restore defaults</button>
          </Section>
        </aside>}

        <main className="acs-viewport">
          <div ref={viewportRef} className="acs-canvas" />
          <div className="acs-hud">
            <div className="acs-chip" style={{ borderColor: LEVEL_COLORS[level], color: LEVEL_COLORS[level] }}>{level}</div>
            <div className="acs-clock">t = {sim.time.toFixed(2)} s · {timeScale}× · {run}</div>
          </div>
          {advanced && <div className="acs-hud-right">
            <label className="acs-check"><input type="checkbox" checked={showRadar} onChange={(e) => setShowRadar(e.target.checked)} /><Radar /> Radar &amp; tracks</label>
            <label className="acs-check"><input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> Ground-truth path</label>
          </div>}
          <div className="acs-readout">
            <div><span>Hyundai</span><b>{fmt(toKmh(sim.ego.speed), 1)}</b><small>km/h</small></div>
            <div><span>TTC</span><b style={{ color: pred?.collision ? LEVEL_COLORS[assess?.level ?? 'NORMAL'] : undefined }}>{pred?.ttc !== null && pred?.ttc !== undefined ? pred.ttc.toFixed(2) : '—'}</b><small>s</small></div>
            <div><span>Gap</span><b>{fmt(pred?.gap ?? truth?.gap, 1)}</b><small>m</small></div>
            <div><span>Closing</span><b>{fmt(pred?.closingSpeed ?? truth?.closingSpeed, 1)}</b><small>m/s</small></div>
          </div>
          {active && activation && (
            <div className="acs-banner">
              <Ear /> Acoustic Shield Active · impact predicted in {fmt(protection.timeRemaining, 2)} s
            </div>
          )}
          {sim.contact && (
            <div className="acs-banner impact">
              Footprint contact at t = {sim.contact.time.toFixed(3)} s
              {sim.contact.leadAchievedS !== null ? ` · stimulus lead ${sim.contact.leadAchievedS.toFixed(3)} s` : ' · protection not active'}
            </div>
          )}
        </main>

        {!advanced && (
          <aside className="acs-panel acs-right">
            <div className={`acs-hero is-${protection.state.toLowerCase()}`} style={{ '--lvl': LEVEL_COLORS[level] } as CSSProperties}>
              <span>{level === 'NORMAL' ? 'All clear' : level}</span>
              <b>{statusTitle}</b>
              <strong>{sim.contact ? 'Impact' : pred?.collision && pred.ttc !== null ? <>{pred.ttc.toFixed(1)}<em> s to impact</em></> : <em>No collision predicted</em>}</strong>
              {sim.contact && (
                <small>{sim.contact.leadAchievedS !== null ? `Shield was active ${sim.contact.leadAchievedS.toFixed(2)} s before impact` : 'Shield did not activate before impact'}</small>
              )}
              {!sim.contact && !active && activation?.endReason && <small>Shield cancelled: {activation.endReason}</small>}
            </div>
            <ol className="acs-steps">
              {STEPS.map((s, i) => (
                <li key={s.title} className={i === stepIndex ? 'on' : i < stepIndex ? 'done' : ''}>
                  <i>{i + 1}</i>
                  <div><b>{s.title}</b><small>{s.text}</small></div>
                </li>
              ))}
            </ol>
            <Section title="What the shield does">
              <StapediusIllustration active={active} />
            </Section>
          </aside>
        )}
        {advanced && <aside className="acs-panel acs-right">
          <Section title="Protection status">
            <div className={`acs-status is-${protection.state.toLowerCase()}`}>
              <b>{statusTitle}</b>
              <span>{sim.assessment.primary?.reason ?? 'No tracked objects'}</span>
            </div>
            {activation && (
              <div className="acs-grid2">
                <Row label="Activated at" value={`${activation.time.toFixed(3)} s`} />
                <Row label="TTC at activation" value={`${activation.ttcAtActivation.toFixed(3)} s`} />
                <Row label="Lead margin" value={`${activation.leadMarginS >= 0 ? '+' : ''}${activation.leadMarginS.toFixed(3)} s`} tone={activation.late ? LEVEL_COLORS.CRITICAL : LEVEL_COLORS.NORMAL} />
                <Row label={active ? 'Time to impact' : 'Ended'} value={active ? `${fmt(protection.timeRemaining, 3)} s` : activation.endedAt !== null ? `${activation.endedAt.toFixed(3)} s` : '—'} sub={!active ? activation.endReason ?? undefined : undefined} />
              </div>
            )}
          </Section>

          <Section title={`Telemetry${target ? ` · ${target.label}` : ''}`}>
            {target ? (
              <div className="acs-telemetry">
                <Row label="Hyundai speed" value={`${fmt(toKmh(sim.ego.speed), 1)} km/h`} sub={`${fmt(sim.ego.speed, 2)} m/s`} />
                <Row label="Target speed" value={track ? `${fmt(toKmh(track.state.speed), 1)} km/h` : 'not tracked'} sub={`truth ${fmt(toKmh(target.speed), 1)} km/h`} />
                <Row label="Distance (centres)" value={`${fmt(pred?.range ?? truth?.range, 2)} m`} sub={`bumper gap ${fmt(pred?.gap ?? truth?.gap, 2)} m`} />
                <Row label="Relative velocity" value={`${fmt(norm((pred ?? truth)?.relVel ?? { x: Number.NaN, y: 0 }), 2)} m/s`} sub={`(${fmt((pred ?? truth)?.relVel.x, 1)}, ${fmt((pred ?? truth)?.relVel.y, 1)})`} />
                <Row label="Closing speed" value={`${fmt(pred?.closingSpeed ?? truth?.closingSpeed, 2)} m/s`} />
                <Row label="Time to collision" value={pred ? (pred.ttc !== null ? `${pred.ttc.toFixed(3)} s` : 'none') : '—'} sub={`truth ${truth?.ttc !== null && truth?.ttc !== undefined ? `${truth.ttc.toFixed(3)} s` : 'none'}`} tone={pred?.collision ? LEVEL_COLORS[assess?.level ?? 'WATCH'] : undefined} />
                <Row label="Time to closest approach" value={`${fmt(pred?.tCpa ?? truth?.tCpa, 2)} s`} />
                <Row label="Min predicted separation" value={`${fmt(pred?.dCpa ?? truth?.dCpa, 2)} m`} sub="centre-to-centre at t_CPA" />
                <Row label="Prediction" value={pred ? (pred.collision ? 'Contact predicted' : 'No contact') : 'No track'} sub={pred ? (pred.collision ? pred.method : `within ${pred.horizonS.toFixed(1)} s horizon`) : undefined} />
                <Row label="Acceleration" value={`ego ${fmt(sim.ego.accel, 2)} m/s²`} sub={`target ${track ? fmt(track.state.accel, 2) : '—'} est · ${fmt(target.accel, 2)} truth`} />
                <Row label="Track" value={track ? `${Math.round(track.confidence * 100)}% conf` : '—'} sub={track ? `age ${(track.ageS * 1000).toFixed(0)} ms · σv ${track.velocityStd.toFixed(2)} m/s` : undefined} tone={track && !assess?.trusted ? LEVEL_COLORS.WATCH : undefined} />
              </div>
            ) : <p className="acs-note dim">No target vehicle.</p>}
          </Section>

          <Section title="TTC timeline">
            <Timeline history={sim.history} config={config} activationT={activation?.time ?? null} impactT={sim.contact?.time ?? null} />
            <p className="acs-legend"><i className="tracked" /> tracked <i className="truth" /> ground truth <i className="active" /> shield active</p>
          </Section>

          <Section title="Acoustic preconditioning">
            <StapediusIllustration active={active} />
            <div className="acs-audio">
              <button className={audioUi.enabled ? 'on' : ''} onClick={() => void toggleAudio()}><Volume2 /> {audioUi.enabled ? 'Sound enabled' : 'Enable sound'}</button>
              <button className={audioUi.muted ? 'on danger' : ''} onClick={() => { audio.setMuted(!audio.muted); setAudioUi((a) => ({ ...a, muted: audio.muted })); }}><VolumeX /> {audioUi.muted ? 'Muted' : 'Mute'}</button>
            </div>
            <Slider label="Output level" value={audioUi.level * 100} min={0} max={MAX_PINK_LEVEL * 100} step={1} unit="% FS" onChange={(v) => { audio.setLevel(v / 100); setAudioUi((a) => ({ ...a, level: audio.level })); }} />
            <p className="acs-note dim">Pink noise via Web Audio, off by default. Level is a fraction of browser full scale, not a calibrated sound pressure level.</p>
          </Section>

          <Section title="Event log">
            <ol className="acs-log">
              {events.map((e, i) => <li key={`${e.t}-${i}`} className={e.kind}><time>{e.t.toFixed(2)}</time><span>{e.message}</span></li>)}
            </ol>
          </Section>
        </aside>}
      </div>

      <footer className="acs-foot">
        {advanced ? <>Engineering prototype. Physics, geometry and decision logic run in the browser on simulated sensor data; thresholds are uncalibrated prototype parameters.
        Not production-ready, not safety-certified, and no vehicle hardware is connected or actuated.</> : 'Concept simulation on simulated sensor data. Not safety-certified; no vehicle hardware is connected.'}
      </footer>
    </div>
  );
}

export default AcousticShield;
