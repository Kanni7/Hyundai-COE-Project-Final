import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CarState } from '../types';
import { engine, type Telemetry } from '../lib/engine';
import { currentTrack } from '../state/car';
import { Part } from './Part';
import { arc, polar } from './geometry';

const THEME = { eco: '#3ee08c', normal: '#3cc4f0', sport: '#ff5a4a' } as const;
const RED = '#ff4a3a';
const AMBER = '#ffb02e';
const GREEN = '#3ee08c';
const TANK_L = 45;
/** Centre column, between the two dials. */
const CX = 1592;
/** Size of the top-view car in the centre column (the image is 121 × 220). */
const CAR = { w: 18.2, h: 33 };

// Twin dials where the real cluster has them. Each sweeps 190°, open towards the centre
// column, so the scales stay clear of the steering-wheel hub and spokes.
const L = { cx: 1500, cy: 369, r: 55, a0: 140, a1: 330, max: 240, n: 24, every: 4 };
const R = { cx: 1683, cy: 374, r: 55, a0: 210, a1: 400, max: 8, n: 16, every: 2 };
type Dial = typeof L;

const angle = (g: Dial, v: number) => g.a0 + (g.a1 - g.a0) * Math.max(0, Math.min(1, v / g.max));
const setText = (el: Element | undefined, s: string) => { if (el && el.textContent !== s) el.textContent = s; };
// Per-frame state goes in data attributes, which React never overwrites on a re-render.
const flag = (el: Element | undefined, on: boolean) => el?.setAttribute('data-on', String(on));
const timeNow = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

/** Tick marks with a few legible numbers on the major ones. */
function Scale({ g, redFrom }: { g: Dial; redFrom?: number }) {
  return (
    <g>
      <g stroke="#cfe6ff" strokeLinecap="round">
        {Array.from({ length: g.n + 1 }, (_, i) => {
          const a = g.a0 + ((g.a1 - g.a0) * i) / g.n;
          const major = i % g.every === 0;
          const [x0, y0] = polar(g.cx, g.cy, g.r - (major ? 8 : 5), a);
          const [x1, y1] = polar(g.cx, g.cy, g.r - 3, a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={major ? 1.2 : 0.7} opacity={major ? 0.75 : 0.3} />;
        })}
      </g>
      {Array.from({ length: g.n / g.every + 1 }, (_, i) => {
        const v = (g.max * i * g.every) / g.n;
        const [x, y] = polar(g.cx, g.cy, g.r - 15, angle(g, v));
        return <text key={i} x={x} y={y + 2.2} className="cl-num" fill={redFrom !== undefined && v >= redFrom ? RED : undefined}>{v}</text>;
      })}
    </g>
  );
}

function Needle({ g, k }: { g: Dial; k: string }) {
  return (
    <g data-k={k} transform={`rotate(${g.a0} ${g.cx} ${g.cy})`}>
      <path d={`M${g.cx + 34} ${g.cy} L${g.cx + 52} ${g.cy - 1.3} L${g.cx + 52} ${g.cy + 1.3} Z`} fill="#f4fbff" filter="url(#d-b1)" opacity="0.55" />
      <path d={`M${g.cx + 34} ${g.cy} L${g.cx + 52} ${g.cy - 0.7} L${g.cx + 52} ${g.cy + 0.7} Z`} fill="#ffffff" />
    </g>
  );
}

/** One indicator lamp in the centre column's top row. */
function Lamp({ x, show, color, children, title }: { x: number; show: boolean; color: string; children: ReactNode; title: string }) {
  return (
    <g transform={`translate(${x} 319)`} className={`cl-lamp ${show ? 'lit' : ''}`} stroke={color} fill="none" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" style={{ color }}>
      <title>{title}</title>
      {children}
    </g>
  );
}

/**
 * Blind View Monitor: while indicating, the camera under that side mirror replaces
 * the dial on the same side. Drawn as a night road with the car's own flank.
 */
function BlindView({ side, g }: { side: 'left' | 'right'; g: Dial }) {
  const id = `bvm-${side}`;
  const flip = side === 'right' ? -1 : 1;
  return (
    <g className="bvm">
      <defs>
        <clipPath id={id}><circle cx={g.cx} cy={g.cy} r={g.r - 3} /></clipPath>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#06090f" /><stop offset="1" stopColor="#1b2840" />
        </linearGradient>
        <linearGradient id={`${id}-road`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1d22" /><stop offset="1" stopColor="#2a2e35" />
        </linearGradient>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3b4250" /><stop offset="0.35" stopColor="#8a93a3" /><stop offset="1" stopColor="#262b33" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id})`}>
        <g transform={`translate(${g.cx} ${g.cy}) scale(${flip} 1)`}>
          <rect x="-70" y="-70" width="140" height="56" fill={`url(#${id}-sky)`} />
          <rect x="-70" y="-14" width="140" height="84" fill={`url(#${id}-road)`} />
          {/* Far streetlights and a following car's headlamps near the vanishing point */}
          <circle cx="-38" cy="-30" r="1.2" fill="#ffd9a0" opacity="0.7" />
          <circle cx="-18" cy="-24" r="0.9" fill="#ffd9a0" opacity="0.6" />
          <ellipse cx="-6" cy="-11" rx="5" ry="1.6" fill="#fff6dc" opacity="0.35" filter="url(#d-b1)" />
          <path d="M14 -14 L-70 60" stroke="#c9ced6" strokeWidth="1.4" opacity="0.7" />
          <path data-k="dash" d="M14 -14 L22 70" stroke="#e8ecf2" strokeWidth="1.6" strokeDasharray="7 6" />
          {/* Own car: rear door and wheel arch along the inside edge */}
          <path d="M30 -70 L70 -70 L70 70 L26 70 Q34 30 30 -10 Z" fill={`url(#${id}-body)`} />
          <path d="M31 -10 Q34 30 27 70" stroke="#c9d2e0" strokeWidth="0.8" opacity="0.6" fill="none" />
          {/* A car following in the next lane: the reason to look */}
          <g transform="translate(-20 6)">
            <path d="M-12 6 L-9 -3 Q-7 -6 -3 -6 L3 -6 Q7 -6 9 -3 L12 6 Z" fill="#0c0f14" stroke="#3a4250" strokeWidth="0.6" />
            <ellipse cx="-7.5" cy="3" rx="3" ry="1.6" fill="#fffbe8" />
            <ellipse cx="7.5" cy="3" rx="3" ry="1.6" fill="#fffbe8" />
            <ellipse cy="4" rx="20" ry="6" fill="#fff6dc" opacity="0.25" filter="url(#d-b3)" />
          </g>
        </g>
        <text x={g.cx} y={g.cy - 30} className="cl-label" fill="#e8f0ff">{side === 'left' ? '◀ BLIND VIEW' : 'BLIND VIEW ▶'}</text>
      </g>
      <circle cx={g.cx} cy={g.cy} r={g.r - 3} stroke={GREEN} strokeWidth="1.2" fill="none" opacity="0.8" />
    </g>
  );
}

/** Digital instrument cluster seen through the steering wheel. */
export function Cluster({ car }: { car: CarState }) {
  const theme = THEME[car.driveMode];
  const live = car.ignition !== 'off';
  const running = car.ignition === 'on';
  const blinkL = car.hazard || car.indicator === 'left';
  const blinkR = car.hazard || car.indicator === 'right';
  const bvm = running && !car.hazard && car.indicator !== 'off' ? car.indicator : null;

  const [clock, setClock] = useState(timeNow);
  useEffect(() => {
    const t = window.setInterval(() => setClock(timeNow()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // Elements tagged with data-k are written straight to the DOM every frame by the vehicle model.
  const root = useRef<SVGGElement>(null);
  const els = useRef<Record<string, Element>>({});
  const latest = useRef(car);
  const sweeping = useRef(false);
  const startedAt = useRef(0);
  const repaint = useRef<(() => void) | null>(null);
  // After every React render: refresh the element lookup and re-apply the live readings.
  useEffect(() => {
    latest.current = car;
    const found: Record<string, Element> = {};
    root.current?.querySelectorAll('[data-k]').forEach((el) => { found[el.getAttribute('data-k')!] = el; });
    els.current = found;
    repaint.current?.();
  });

  useEffect(() => {
    const render = (rpm: number, t: Telemetry, sweep?: number) => {
      const c = latest.current;
      const e = els.current;
      const spd = sweep !== undefined ? sweep * L.max : t.speed;
      const rev = sweep !== undefined ? sweep * R.max : rpm;
      const a = angle(L, spd);
      e.speedFill?.setAttribute('d', arc(L.cx, L.cy, L.r, L.a0, a + 0.01));
      e.speedNeedle?.setAttribute('transform', `rotate(${a.toFixed(2)} ${L.cx} ${L.cy})`);
      setText(e.speed, String(Math.round(spd)));
      const b = angle(R, rev);
      e.rpmFill?.setAttribute('d', arc(R.cx, R.cy, R.r, R.a0, b + 0.01));
      e.rpmNeedle?.setAttribute('transform', `rotate(${b.toFixed(2)} ${R.cx} ${R.cy})`);
      setText(e.rpm, rev.toFixed(1));
      e.red?.setAttribute('opacity', rev > 6.1 ? '1' : '0');
      setText(e.gearNo, t.selector === 'D' && t.running ? String(t.gear) : '');

      // Coolant warms up over the first half-minute after a start.
      if (t.running && !startedAt.current) startedAt.current = performance.now();
      if (!t.running) startedAt.current = 0;
      const warm = t.running ? Math.min(3, 1 + Math.floor((performance.now() - startedAt.current) / 9000)) : c.ignition === 'off' ? 0 : 1;
      e.coolant?.querySelectorAll('rect').forEach((el, i) => flag(el, i < warm));

      const fuelPct = Math.max(0, c.fuel - (t.fuelUsed / TANK_L) * 100);
      e.fuel?.querySelectorAll('rect').forEach((el, i) => flag(el, i < Math.ceil(fuelPct / 12.5)));
      if (e.trip) {
        setText(e.trip, t.trip.toFixed(1));
        setText(e.avg, t.trip > 0.05 && t.fuelUsed > 0 ? (t.trip / t.fuelUsed).toFixed(1) : '--.-');
        setText(e.odo, Math.floor(t.odo).toLocaleString('en-IN'));
        e.inst?.setAttribute('width', ((Math.min(30, t.instant ?? 0) / 30) * 40).toFixed(1));
      }

      // Lane Keeping Assist turns the lane lines green once it is actively steering (above 60 km/h).
      const steering = c.adas.lka && t.running && t.speed > 60;
      flag(e.lanes, steering);
      flag(e.lka, steering);
      flag(e.held, t.held);
      e.lanes?.setAttribute('stroke-dashoffset', ((t.odo * 1000 * 0.8) % 11).toFixed(2));
      e.dash?.setAttribute('stroke-dashoffset', (-(t.odo * 1000 * 1.2) % 13).toFixed(2));
    };
    repaint.current = () => { if (!sweeping.current) render(engine.rpm, engine.telemetry()); };
    const off = engine.subscribe((rpm, _th, t) => { if (!sweeping.current) render(rpm, t); });
    if (!live) return off;
    // Needle sweep to full scale and back, like a real cluster waking up.
    sweeping.current = true;
    const t0 = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      // The first frame's timestamp can precede t0; a negative p would make the sweep NaN.
      const p = Math.min(1, Math.max(0, (now - t0) / 1500));
      if (p < 1) {
        render(0, engine.telemetry(), Math.sin(Math.PI * p) ** 1.4);
        raf = requestAnimationFrame(loop);
      } else {
        sweeping.current = false;
        render(engine.rpm, engine.telemetry());
      }
    };
    raf = requestAnimationFrame(loop);
    return () => { off(); cancelAnimationFrame(raf); sweeping.current = false; };
  }, [live]);

  let info: [string, string];
  if (car.phone) info = [car.phone.contact, 'ON CALL'];
  else if (car.nav) info = [`${car.nav.km} km`, car.nav.destination.toUpperCase()];
  else if (car.media.playing) info = [car.media.radio ? `FM ${car.media.freq.toFixed(1)}` : currentTrack(car.media).title, 'NOW PLAYING'];
  else info = [car.driveMode.toUpperCase(), 'DRIVE MODE'];

  const acc = car.ignition === 'acc';
  const tpmsLow = car.tyres.some((p) => p < 30);
  const [fl, fr, rl, rr] = car.tyres;

  return (
    <Part x={1418} y={280} w={364} h={154} className="cluster">
      <defs>
        <radialGradient id="cl-bg" cx="0.5" cy="0.45" r="0.7">
          <stop offset="0" stopColor="#040a14" />
          <stop offset="1" stopColor="#01030a" />
        </radialGradient>
        <linearGradient id="cl-tacho" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={theme} stopOpacity="0.45" />
          <stop offset="1" stopColor={theme} />
        </linearGradient>
        <linearGradient id="cl-speedo" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor={theme} stopOpacity="0.4" />
          <stop offset="1" stopColor={theme} />
        </linearGradient>
        <linearGradient id="cl-lane" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* The display glass, set into the hood */}
      <path d="M1444 314 Q1445 305 1455 305 L1737 305 Q1747 305 1748 314 L1749 416 Q1749 424 1741 424 L1452 424 Q1444 424 1444 416 Z" fill="url(#cl-bg)" stroke="#121924" strokeWidth="1" />

      <g ref={root} className={live ? 'cluster-on' : 'cluster-off'}>
        {/* Faint drive-mode wash behind each dial */}
        <circle cx={L.cx} cy={L.cy} r={L.r - 6} fill={theme} opacity="0.05" filter="url(#d-b8)" />
        <circle cx={R.cx} cy={R.cy} r={R.r - 6} fill={theme} opacity="0.05" filter="url(#d-b8)" />

        {/* Speedometer: 0-240 km/h */}
        <path d={arc(L.cx, L.cy, L.r, L.a0, L.a1)} stroke={theme} strokeWidth="2" opacity="0.3" fill="none" />
        <path data-k="speedFill" d={arc(L.cx, L.cy, L.r, L.a0, L.a0 + 0.01)} stroke="url(#cl-speedo)" strokeWidth="3.2" fill="none" />
        <Scale g={L} />
        {car.adas.cruise !== null && running && (() => {
          const [x, y] = polar(L.cx, L.cy, L.r + 3, angle(L, car.adas.cruise));
          return <circle cx={x} cy={y} r="2" fill={GREEN} />;
        })()}
        <Needle g={L} k="speedNeedle" />
        {car.adas.cruise !== null && running && <text x={L.cx} y={L.cy - 22} className="cl-label" fill={GREEN}>SCC {car.adas.cruise}</text>}
        <text data-k="speed" x={L.cx} y={L.cy + 7} className="cl-big">0</text>
        <text x={L.cx} y={L.cy + 17} className="cl-unit">km/h</text>
        {/* Coolant temperature */}
        <g data-k="coolant" className="cl-bars">
          {Array.from({ length: 6 }, (_, i) => <rect key={i} x={1479 + i * 7} y="403" width="6" height="2" rx="0.6" />)}
        </g>

        {/* Tachometer: 0-8 x1000 rpm, redline from 6.5 */}
        <path d={arc(R.cx, R.cy, R.r, R.a0, R.a1)} stroke={theme} strokeWidth="2" opacity="0.3" fill="none" />
        <path d={arc(R.cx, R.cy, R.r, angle(R, 6.5), R.a1)} stroke={RED} strokeWidth="1.6" fill="none" opacity="0.7" />
        <path data-k="red" d={arc(R.cx, R.cy, R.r + 2, angle(R, 6.5), R.a1)} stroke={RED} strokeWidth="5" opacity="0" filter="url(#d-b3)" fill="none" />
        <path data-k="rpmFill" d={arc(R.cx, R.cy, R.r, R.a0, R.a0 + 0.01)} stroke="url(#cl-tacho)" strokeWidth="3.2" fill="none" />
        <Scale g={R} redFrom={7} />
        <Needle g={R} k="rpmNeedle" />
        <text data-k="rpm" x={R.cx} y={R.cy + 2} className="cl-big">0.0</text>
        <text x={R.cx} y={R.cy + 11} className="cl-unit">x1000 rpm</text>
        <text x={R.cx} y={R.cy + 22} className="cl-line">{info[0].length > 14 ? `${info[0].slice(0, 13)}…` : info[0]}</text>
        <text x={R.cx} y={R.cy + 29} className="cl-label">{info[1].slice(0, 18)}</text>
        {/* Fuel gauge */}
        <g data-k="fuel" className="cl-bars cl-fuel">
          {Array.from({ length: 8 }, (_, i) => <rect key={i} x={R.cx - 16 + i * 4} y={R.cy + 33} width="3.2" height="2" rx="0.5" />)}
        </g>

        {/* Top row: clock (ACC with the engine off), flanked by indicator lamps */}
        {acc ? <text x={CX} y="321" className="cl-acc">ACC</text> : <text x={CX} y="321" className="cl-small">{clock}</text>}

        {/* Gear selector with the gearbox's current ratio */}
        <text x={CX} y="341" className="cl-gear">{car.gear}</text>
        <text data-k="gearNo" x={CX + 6} y="341" className="cl-gearno" />

        {/* Centre: driving assist, trip computer or tyre pressures */}
        {car.cluster === 'drive' && (
          <g>
            <g data-k="lanes" className={`cl-lanes ${car.adas.lka ? 'lka' : ''}`} strokeDasharray="6 5">
              <path d={`M${CX - 36} 408 L${CX - 11} 350`} />
              <path d={`M${CX + 36} 408 L${CX + 11} 350`} />
            </g>
            {car.adas.cruise !== null && running && (
              <g>
                <g transform={`translate(${CX} 356) scale(0.45)`} opacity="0.9">
                  <rect x="-11" y="-14" width="22" height="28" rx="6" fill="#aab6c8" />
                  <rect x="-8" y="-9" width="16" height="6" rx="2" fill="#2a3446" />
                </g>
                {[0, 1, 2].map((i) => <path key={i} d={`M${CX - 8 + i} ${366 + i * 3} L${CX + 8 - i} ${366 + i * 3}`} stroke={GREEN} strokeWidth="1.2" opacity={0.9 - i * 0.2} />)}
              </g>
            )}
            <ellipse cx={CX} cy="386" rx="16" ry="8" fill={theme} opacity="0.14" filter="url(#d-b3)" />
            {/* The car itself, from above: the Verna's own top view */}
            <image href="/images/verna-top.webp" x={CX - CAR.w / 2} y={384 - CAR.h / 2} width={CAR.w} height={CAR.h} />
          </g>
        )}
        {car.cluster === 'trip' && (
          <g className="cl-trip">
            <text x={CX} y="354" className="cl-label">TRIP</text>
            <text x="1560" y="366" className="k">TRIP A</text><text data-k="trip" x="1617" y="366" className="v">0.0</text><text x="1619" y="366" className="u">km</text>
            <text x="1560" y="377" className="k">AVG</text><text data-k="avg" x="1617" y="377" className="v">--.-</text><text x="1619" y="377" className="u">km/l</text>
            <rect x="1560" y="382" width="40" height="2.4" rx="1.2" fill="#1b2638" />
            <rect data-k="inst" x="1560" y="382" width="0" height="2.4" rx="1.2" fill={theme} />
            <text x="1560" y="396" className="k">ODO</text><text data-k="odo" x="1617" y="396" className="v">0</text><text x="1619" y="396" className="u">km</text>
          </g>
        )}
        {car.cluster === 'tyres' && (
          <g className="cl-trip">
            <text x={CX} y="354" className="cl-label">TYRES · PSI</text>
            <g transform={`translate(${CX} 378)`}>
              <rect x="-8" y="-17" width="16" height="34" rx="5" fill="none" stroke="#8fa3c0" strokeWidth="1" />
              {[[-10, -10], [10, -10], [-10, 10], [10, 10]].map(([x, y], i) => <rect key={i} x={x - 2} y={y - 4} width="4" height="8" rx="1.2" fill={car.tyres[i] < 30 ? AMBER : GREEN} />)}
            </g>
            <text x={CX - 24} y="371" className="v p">{fl}</text><text x={CX + 24} y="371" className="v p">{fr}</text>
            <text x={CX - 24} y="393" className="v p">{rl}</text><text x={CX + 24} y="393" className="v p">{rr}</text>
          </g>
        )}

        {/* Lamps: only the ones that mean something right now */}
        <Lamp x={CX - 26} show={car.headlights} color={GREEN} title="Headlights">
          <path d="M-1.5 0 Q2 -3.6 4 0 Q2 3.6 -1.5 0 Z" fill={GREEN} stroke="none" /><path d="M-2.5 -2.4 h-2.2 M-2.5 0 h-2.2 M-2.5 2.4 h-2.2" />
        </Lamp>
        <Lamp x={CX - 38} show={car.gear === 'P' && running} color={RED} title="Parking brake">
          <circle r="3.4" /><text y="1.9" className="cl-tell" fill={RED} stroke="none">P</text>
        </Lamp>
        <Lamp x={CX - 50} show={tpmsLow && live} color={AMBER} title="Tyre pressure">
          <path d="M-3.4 -2.8 Q-5 0.2 -3.4 2.8 L3.4 2.8 Q5 0.2 3.4 -2.8" /><path d="M0 -1.6 v2.2 M0 1.8 v0.1" />
        </Lamp>
        <g data-k="held" className={`cl-hold ${car.autoHold ? 'lit' : ''}`}>
          <Lamp x={CX + 26} show color="currentColor" title="Auto Hold">
            <circle r="3.6" /><text y="1.8" className="cl-tell" fill="currentColor" stroke="none">A</text>
          </Lamp>
        </g>
        <g data-k="lka" className={`cl-lka ${car.adas.lka ? 'lit' : ''}`}>
          <Lamp x={CX + 38} show color="currentColor" title="Lane Keeping Assist">
            <path d="M-4 3 L-2 -3 M4 3 L2 -3" /><circle cy="0.6" r="1.5" />
          </Lamp>
        </g>
        <Lamp x={CX + 50} show={car.adas.cruise !== null && running} color={GREEN} title="Smart Cruise Control">
          <path d="M-3.6 1.6 A3.7 3.7 0 1 1 3.6 1.6" /><path d="M0 0.6 L1.9 -1.7" />
        </Lamp>

        {/* Blind View Monitor replaces the dial on the side being indicated */}
        {bvm === 'left' && <BlindView side="left" g={L} />}
        {bvm === 'right' && <BlindView side="right" g={R} />}
      </g>

      {/* Turn signals stay live even with the engine off (hazards) */}
      <path className={blinkL ? 'cl-turn on' : 'cl-turn'} transform={`translate(${CX - 19} 337)`} d="M-7 0 L0 -5.5 L0 -2.5 L6 -2.5 L6 2.5 L0 2.5 L0 5.5 Z" />
      <path className={blinkR ? 'cl-turn on' : 'cl-turn'} transform={`translate(${CX + 19} 337)`} d="M7 0 L0 -5.5 L0 -2.5 L-6 -2.5 L-6 2.5 L0 2.5 L0 5.5 Z" />
      {!live && <text x={CX} y="372" className="cl-unit" opacity="0.55">PRESS START</text>}
    </Part>
  );
}
