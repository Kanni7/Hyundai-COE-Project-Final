import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CornerUpRight, Fan, Phone } from 'lucide-react';
import type { SceneConfig, XY } from '../scenes';
import type { CarState, Intent, Toast } from '../types';
import { quadToMatrix3d } from '../lib/homography';
import { carAudio } from '../lib/audio';
import { AMBIENT_RGB, ambientColors } from '../lib/ambient';
import { engine } from '../lib/engine';
import { ventAims } from '../lib/ventAim';
import { AmbientFilter } from './AmbientFilter';
import { Airflow } from './Airflow';
import { Windshield } from './Windshield';
import { Infotainment, type VoicePhase } from './Infotainment';
import { DrawnCabin } from '../drawn/DrawnCabin';

interface Props {
  car: CarState;
  scene: SceneConfig;
  toast: Toast | null;
  voice: { phase: VoicePhase; interim: string; reply: string };
  onIntent: (i: Intent) => void;
  /** cabin = whole interior, dash = dashboard and wheel, screen = lean in to the centre screen. */
  view: CockpitView;
  /** Double-clicking the screen leans in to it, or back out. */
  onToggleFocus: () => void;
  onMic: () => void;
}

/** 'seats' shows the cabin behind the seat side view (SeatView). */
export type CockpitView = 'cabin' | 'dash' | 'screen' | 'seats';

const COMPARE = new URLSearchParams(window.location.search).get('compare');
/**
 * Zoom limit, as a multiple of the width fit. With the assistant in its side column nothing covers the
 * bottom, so the cabin may crop its sides (the passenger door goes first) to fill a 16:10 window; with the
 * bottom strip, a tall window keeps some dark floor under the cabin (the strip covers it) rather than a
 * dashboard cropped down to the steering wheel.
 */
const MAX_ZOOM = { side: 1.5, bottom: 1.12 };
/** Voice assistant layout, kept in step with `.dock` in index.css. */
const DOCK_SIDE_MIN_WIDTH = 900;
const DOCK_SIDE_WIDTH = 460;
const DOCK_BOTTOM_HEIGHT = 128;
const poly = (pts: XY[]) => `polygon(${pts.map(([x, y]) => `${x}px ${y}px`).join(',')})`;
const at = ([x, y]: XY, extra?: CSSProperties): CSSProperties => ({ left: x, top: y, ...extra });

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

export function Cockpit({ car, scene, toast, voice, onIntent, view, onToggleFocus, onMic }: Props) {
  const vp = useViewport();
  // Space the voice assistant takes (mirrors `.dock` in index.css): a column over the empty passenger
  // side of a wide window, a strip along the bottom of a narrow one.
  const side = vp.w > DOCK_SIDE_MIN_WIDTH;
  const reserveLeft = side ? DOCK_SIDE_WIDTH : 0;
  const reserveBottom = side ? 0 : DOCK_BOTTOM_HEIGHT;

  // Fill the width (in the dashboard view, only the scene's frame columns) and, within MAX_ZOOM, the height
  // above the dock. Any further side crop is taken around scene.focusX, so that point (the steering wheel) keeps its place.
  const [x0, x1] = (view === 'dash' && scene.frame) || [0, scene.width];
  const fit = vp.w / (x1 - x0);
  let s = Math.min(Math.max(fit, (vp.h - reserveBottom) / scene.height), fit * MAX_ZOOM[side ? 'side' : 'bottom']);
  let sw = scene.width * s;
  let sh = scene.height * s;
  const fx = (scene.focusX * scene.width - x0) / (x1 - x0);
  let left = -x0 * s - ((x1 - x0) * s - vp.w) * fx;
  left = sw > vp.w ? Math.min(0, Math.max(vp.w - sw, left)) : (vp.w - sw) / 2;
  let top = sh > vp.h ? -(sh - vp.h) * 0.4 : 0;
  // In a short window, lift the cabin (losing some sky, at most 12%) so the console clears the dock.
  if (scene.keepAboveDock) top = Math.min(top, Math.max(vp.h - reserveBottom - scene.keepAboveDock * s, -sh * 0.12));
  const cabinBottom = Math.min(vp.h, top + sh);
  if (view === 'screen') {
    // Lean in towards the centre stack, like a driver glancing at the screen, centred beside the assistant.
    const [fx0, fy0, fx1, fy1] = scene.focus;
    const room = vp.h - reserveBottom - 90;
    const free = vp.w - reserveLeft;
    s = Math.min((free * 0.9) / (fx1 - fx0), room / (fy1 - fy0));
    sw = scene.width * s;
    sh = scene.height * s;
    left = reserveLeft + free / 2 - ((fx0 + fx1) / 2) * s;
    top = 70 + room / 2 - ((fy0 + fy1) / 2) * s;
  }

  const screenTransform = useMemo(() => quadToMatrix3d(scene.screen.ui.w, scene.screen.ui.h, scene.screen.quad), [scene]);
  const amb = car.ambient;
  const ambientColor = amb.on ? ambientColors(car).rgb : AMBIENT_RGB.off;
  const c = car.climate;
  const drawn = scene.kind === 'drawn';
  // In the drawn cockpit the centre vents can be aimed by their tabs; the air follows.
  const airflow = <Airflow scene={scene} on={c.on && car.ignition !== 'off'} fan={c.fan} temp={c.temp} aims={drawn ? ventAims : undefined} />;
  const screen = (
    <div className="screen" onDoubleClick={onToggleFocus} style={{ transform: screenTransform, width: scene.screen.ui.w, height: scene.screen.ui.h, borderRadius: scene.screen.radius }}>
      <Infotainment car={car} toast={toast} voice={voice} onIntent={onIntent} width={scene.screen.ui.w} height={scene.screen.ui.h} />
    </div>
  );

  return (
    <div className="viewport">
      <div className={`stage ${view === 'screen' ? 'focused' : ''}`} key={scene.id}
        style={{ width: scene.width, height: scene.height, transform: `translate(${left}px, ${top}px) scale(${s})` }}>
        <div className="cabin" style={{ width: scene.width, height: scene.height }}>
          <img className="layer" src={scene.src} alt="Hyundai Verna interior" draggable={false} />
          {!drawn && (
            <>
              <AmbientFilter id={`amb-${scene.id}`} color={ambientColor} gain={amb.on ? amb.brightness : 1} threshold={scene.ambient.threshold}
                mode={amb.on ? amb.mode : 'static'} />
              <div className="layer ambient">
                <img className="layer" src={scene.src} alt="" draggable={false}
                  style={{ filter: `url(#amb-${scene.id})`, clipPath: poly(scene.ambient.clip) }} />
              </div>
            </>
          )}

          {scene.windshield.headlight && (
            <div className={`headlight ${car.headlights ? 'on' : ''}`} style={ellipseStyle(scene.windshield.headlight)} />
          )}
          <div className={`sunlight ${car.sunroof ? 'on' : ''} ${scene.id}`} />
          <Windshield scene={scene} mode={car.wipers} />

          {drawn ? (
            <>
              <DrawnCabin car={car} onIntent={onIntent} onMic={onMic} airflow={airflow} screen={screen} />
              {/* Dev aid: ?compare=split or ?compare=overlay lays the source photo over the drawing */}
              {COMPARE && <img className={`layer compare-${COMPARE}`} src={scene.src} alt="" />}
            </>
          ) : (
            <>
              {airflow}
              {scene.seat && <div className={`seat-glow lvl-${car.seats.passenger}`} style={ellipseStyle(scene.seat)} />}
              {scene.cluster && <Cluster car={car} cfg={scene.cluster} />}
              {scene.climate.kind === 'lcd' ? (
                <>
                  <LcdTemp pos={scene.climate.left} size={scene.climate.size} value={c.temp} on={c.on} label="Cabin temperature"
                    onStep={(d) => onIntent({ type: 'climate.setTemp', value: c.temp + d })} />
                  {/* Single-zone AC: the second display shows blower speed instead of a duplicate temperature. */}
                  <LcdFan pos={scene.climate.right} size={scene.climate.size} fan={c.on ? c.fan : 0}
                    onStep={(d) => onIntent({ type: 'climate.fan', delta: d })} />
                </>
              ) : (
                <div className="lcd-chip" style={at(scene.climate.at, { width: scene.climate.w, height: scene.climate.h })}>
                  <span>{c.on ? `${c.temp.toFixed(1)}°` : 'OFF'}</span>
                  <i>{Array.from({ length: 8 }, (_, k) => <b key={k} className={c.on && k < c.fan ? 'on' : ''} />)}</i>
                </div>
              )}
              <button className={`hazard-btn ${car.hazard ? 'on' : ''}`} style={at(scene.hazard)}
                onClick={() => onIntent({ type: 'lights.hazard', on: !car.hazard })} aria-label="Hazard lights" title="Hazard lights" />
              {screen}
              <button className="horn" style={{ left: scene.horn.cx, top: scene.horn.cy, width: scene.horn.r * 2, height: scene.horn.r * 2 }}
                onClick={() => carAudio.horn()} aria-label="Horn" title="Horn" />
            </>
          )}
        </div>
      </div>
      <div className="viewport-fade" style={{ top: cabinBottom - 160, opacity: view === 'screen' ? 0 : 1 }} />
    </div>
  );
}

function ellipseStyle(e: { cx: number; cy: number; rx: number; ry: number }): CSSProperties {
  return { left: e.cx - e.rx, top: e.cy - e.ry, width: e.rx * 2, height: e.ry * 2 };
}

function LcdTemp({ pos, size, value, on, label, onStep }: {
  pos: XY; size: number; value: number; on: boolean; label: string; onStep: (d: number) => void;
}) {
  return (
    <div className="lcd" style={at(pos, { fontSize: size })} title={`${label}: scroll or click top/bottom half`}
      onWheel={(e) => onStep(e.deltaY < 0 ? 0.5 : -0.5)}>
      <button className="lcd-up" onClick={() => onStep(0.5)} aria-label={`Raise ${label}`} />
      <button className="lcd-down" onClick={() => onStep(-0.5)} aria-label={`Lower ${label}`} />
      <span key={`${on}-${value}`}>{on ? value.toFixed(1) : 'OFF'}</span>
    </div>
  );
}

function LcdFan({ pos, size, fan, onStep }: { pos: XY; size: number; fan: number; onStep: (d: number) => void }) {
  return (
    <div className="lcd lcd-fan" style={at(pos, { fontSize: size })} title="Fan speed: scroll or click top/bottom half"
      onWheel={(e) => onStep(e.deltaY < 0 ? 1 : -1)}>
      <button className="lcd-up" onClick={() => onStep(1)} aria-label="Fan faster" />
      <button className="lcd-down" onClick={() => onStep(-1)} aria-label="Fan slower" />
      <span key={fan}><Fan /><i>{Array.from({ length: 8 }, (_, k) => <b key={k} className={k < fan ? 'on' : ''} />)}</i></span>
    </div>
  );
}

const MODE_TINT = { eco: '#2bff88', normal: null, sport: '#ff2a2a' } as const;

/** Road speed straight from the vehicle model, updated every frame without re-rendering React. */
function LiveSpeed() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => engine.subscribe((_r, _t, tele) => {
    if (ref.current) ref.current.textContent = String(Math.round(tele.speed));
  }), []);
  return <b ref={ref}>0</b>;
}

function Cluster({ car, cfg }: { car: CarState; cfg: NonNullable<SceneConfig['cluster']> }) {
  const tint = MODE_TINT[car.driveMode];
  let info: ReactNode;
  if (car.phone) info = <><b className="sm"><Phone /> {car.phone.contact}</b><small>ON CALL</small></>;
  else if (car.nav) info = <><b className="sm"><CornerUpRight /> 400 m</b><small>{car.nav.destination.toUpperCase()}</small></>;
  else info = <><b className={`mode-${car.driveMode}`}>{car.driveMode.toUpperCase()}</b><small>DRIVE MODE</small></>;
  return (
    <>
      {tint && (
        <>
          <div className="cluster-tint" style={{ ...ellipseStyle(cfg.tint), background: `radial-gradient(ellipse at center, ${tint} 0%, ${tint} 55%, transparent 72%)` }} />
          <div className="cluster-glow" style={{ ...ellipseStyle(cfg.tint), background: `radial-gradient(ellipse at center, ${tint}22 0%, transparent 70%)` }} />
        </>
      )}
      <div className="cl-patch cl-speed" style={at(cfg.speed)}><LiveSpeed /><small>km/h</small></div>
      <div className="cl-patch cl-info" style={at(cfg.info)}>{info}</div>
      {cfg.arrows.map(([x, y], i) => (car.hazard || car.indicator === (i === 0 ? 'left' : 'right')) && (
        <svg key={i} className="cl-arrow" style={{ left: x - 7, top: y - 6 }} width="14" height="12" viewBox="0 0 14 12">
          <path d={i === 0 ? 'M0 6 L7 0 L7 3.5 L14 3.5 L14 8.5 L7 8.5 L7 12 Z' : 'M14 6 L7 0 L7 3.5 L0 3.5 L0 8.5 L7 8.5 L7 12 Z'} />
        </svg>
      ))}
    </>
  );
}
