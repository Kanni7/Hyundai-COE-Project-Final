import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { CarState, Intent } from '../types';
import { aimVent, onVentsMoved, ventAims, type VentAim } from '../lib/ventAim';
import { Part } from './Part';

/**
 * One long, slim vent unit: a single chrome outline, two vent mouths and the hazard switch
 * between them. Level and mirror-symmetric about the centre-stack axis (x 1146).
 */
const OUTLINE = 'M967 428 L1325 428 Q1331 428 1329 441 Q1321 466 1299 481 Q1291 486 1279 486 L1013 486 Q1001 486 993 481 Q971 466 963 441 Q961 428 967 428 Z';
const MOUTH = 'M978 434.5 L1314 434.5 Q1319 434.5 1307 452 Q1295 469 1277 477 L1015 477 Q997 469 985 452 Q973 434.5 978 434.5 Z';
/** Horizontal louvres; they tilt up and down. */
const SLATS = [444, 452, 460, 468];
/** The two vent mouths, either side of the hazard switch, and the tab's travel inside each. */
const VENTS = [
  { x0: 972, x1: 1120, cx: 1046 },
  { x0: 1172, x1: 1320, cx: 1246 },
];
const TAB_Y = 456;
const TRAVEL_X = 48;
const TRAVEL_Y = 6;
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** Vertical vanes behind the louvres: seen edge-on when straight, showing a face as they turn. */
function Vanes({ x0, x1, aim }: { x0: number; x1: number; aim: number }) {
  const n = 10;
  const step = (x1 - x0) / n;
  const face = 0.8 + 3.4 * Math.abs(aim);
  return (
    <g>
      {Array.from({ length: n - 1 }, (_, i) => {
        const x = x0 + step * (i + 1);
        return (
          <g key={i}>
            <rect x={aim >= 0 ? x : x - face} y="436" width={face} height="42" fill="#0a0d12" />
            <path d={`M${aim >= 0 ? x + face : x - face} 436 V478`} stroke="#171c24" strokeWidth="0.6" />
          </g>
        );
      })}
    </g>
  );
}

/** One horizontal louvre: a thin blade edge-on when level, showing its lit top or its dark underside as it tilts. */
function Slat({ x0, x1, y, tilt }: { x0: number; x1: number; y: number; tilt: number }) {
  const h = 1.6 + 4.6 * Math.abs(tilt);
  const down = tilt >= 0;
  return (
    <g>
      <rect x={x0} y={y - h / 2} width={x1 - x0} height={h} fill={down ? 'url(#v-bladeTop)' : 'url(#v-bladeUnder)'} />
      {/* The front edge, nearest the cabin, catches the light */}
      <path d={`M${x0} ${down ? y + h / 2 : y - h / 2} H${x1}`} stroke="#4c5664" strokeWidth="0.7" />
    </g>
  );
}

/** Centre vents with the hazard switch between them. Drag a vent's chrome tab to aim the air. */
export function VentModule({ car, onIntent }: { car: CarState; onIntent: (i: Intent) => void }) {
  const [aims, setAims] = useState<VentAim[]>(() => ventAims.map((a) => ({ ...a })));
  const drag = useRef<{ i: number; x: number; y: number; aim: VentAim } | null>(null);
  // The car can swing the vents itself (fatigue response): follow it.
  useEffect(() => onVentsMoved(() => setAims(ventAims.map((a) => ({ ...a })))), []);

  const aimAt = (i: number, aim: VentAim) => {
    aimVent(i, aim);
    setAims((a) => a.map((v, k) => (k === i ? aim : v)));
  };
  // Pointer position in drawing pixels, whatever the stage's zoom.
  const toCabin = (e: PointerEvent<SVGElement>) => {
    const svg = e.currentTarget.ownerSVGElement!;
    const m = svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  };
  const onDown = (i: number) => (e: PointerEvent<SVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toCabin(e);
    drag.current = { i, x: p.x, y: p.y, aim: aims[i] };
  };
  const onMove = (e: PointerEvent<SVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toCabin(e);
    aimAt(d.i, { x: clamp(d.aim.x + (p.x - d.x) / TRAVEL_X), y: clamp(d.aim.y + (p.y - d.y) / TRAVEL_Y) });
  };
  const onUp = () => { drag.current = null; };

  return (
    <Part x={950} y={420} w={392} h={80} className="vents">
      <defs>
        <clipPath id="v-mouth"><path d={MOUTH} /></clipPath>
        <linearGradient id="v-depth" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#010203" />
          <stop offset="0.6" stopColor="#04060a" />
          <stop offset="1" stopColor="#090c11" />
        </linearGradient>
        <linearGradient id="v-bladeTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a313b" />
          <stop offset="1" stopColor="#161b22" />
        </linearGradient>
        <linearGradient id="v-bladeUnder" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0c0f14" />
          <stop offset="1" stopColor="#151a21" />
        </linearGradient>
        <linearGradient id="v-tab" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#c3cad4" />
          <stop offset="1" stopColor="#59616d" />
        </linearGradient>
      </defs>
      <path d={OUTLINE} fill="#06080b" />
      <path d={MOUTH} fill="url(#v-depth)" />

      <g clipPath="url(#v-mouth)">
        {VENTS.map((v, i) => (
          <g key={i}>
            <Vanes x0={v.x0} x1={v.x1} aim={aims[i].x} />
            {SLATS.map((y) => <Slat key={y} x0={v.x0} x1={v.x1} y={y + aims[i].y * 1.5} tilt={aims[i].y} />)}
          </g>
        ))}
      </g>
      <path d={MOUTH} fill="none" stroke="#000" strokeWidth="2" opacity="0.7" />

      {/* Chrome tabs: drag sideways to turn the vanes, up or down to tilt the louvres; double-click to centre */}
      {VENTS.map((v, i) => {
        const x = v.cx + aims[i].x * TRAVEL_X;
        const y = TAB_Y + aims[i].y * TRAVEL_Y * 0.5;
        return (
          <g key={i} className="hit vent-tab" role="slider" aria-label={`${i === 0 ? 'Passenger' : 'Driver'} side vent`}
            aria-valuetext={`${Math.round(aims[i].x * 100)}% right, ${Math.round(aims[i].y * 100)}% down`}
            onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
            onDoubleClick={() => aimAt(i, { x: 0, y: 0 })}>
            <title>Vent: drag to aim the air, double-click to centre</title>
            <rect x={x - 18} y={y - 9} width="36" height="18" fill="transparent" />
            <rect x={x - 13.5} y={y - 1.4} width="27" height="5.2" rx="2.4" fill="#000" opacity="0.6" />
            <rect x={x - 13} y={y - 2.6} width="26" height="5" rx="2.4" fill="url(#v-tab)" />
            <path d={`M${x - 11} ${y - 1.8} H${x + 11}`} stroke="#ffffff" strokeWidth="0.6" opacity="0.8" />
            {/* Finger grip */}
            <path d={`M${x - 2.5} ${y - 1.2} V${y + 1.4} M${x} ${y - 1.2} V${y + 1.4} M${x + 2.5} ${y - 1.2} V${y + 1.4}`} stroke="#6b7480" strokeWidth="0.6" />
          </g>
        );
      })}

      {/* Chrome surround: bright along the top, softer round the ends and the lower lip */}
      <path d={OUTLINE} fill="none" stroke="url(#d-chrome)" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M970 429.4 L1322 429.4" stroke="#ffffff" strokeWidth="0.8" opacity="0.7" />
      <path d="M1013 487.6 L1279 487.6" stroke="#dfe5ee" strokeWidth="0.8" opacity="0.55" />

      {/* Hazard switch */}
      <g className={`hit hazard ${car.hazard ? 'on' : ''}`} onClick={() => onIntent({ type: 'lights.hazard', on: !car.hazard })} role="button" aria-label="Hazard lights">
        <title>Hazard lights</title>
        <rect x="1123" y="444.5" width="46" height="33" rx="4" fill="#06080b" />
        <rect x="1125" y="446.5" width="42" height="29" rx="3.4" fill="#0c0e12" stroke="#252b35" strokeWidth="0.8" />
        <path d="M1127.5 447.6 L1164.5 447.6" stroke="#3a414d" strokeWidth="0.7" />
        <g className="hz-glow"><path d="M1146 452 L1157.5 470.5 L1134.5 470.5 Z" fill="#ff2a2a" opacity="0.5" filter="url(#d-b3)" /></g>
        <path d="M1146 451.5 L1157.5 470.5 L1134.5 470.5 Z" fill="none" stroke="#ff3a30" strokeWidth="2.2" strokeLinejoin="round" className="hz-tri" />
        <path d="M1146 458 L1151.6 467.4 L1140.4 467.4 Z" fill="none" stroke="#ff3a30" strokeWidth="1.3" strokeLinejoin="round" className="hz-tri" />
      </g>
    </Part>
  );
}
