import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Armchair, AudioLines, Lock, Car, CloudRain, Contrast, CornerUpRight, Disc3, Fan, Flame, Flower2, Fuel, Gauge, Heart, House,
  Leaf, Lightbulb, MapPin, Mic, MicOff, Minus, Music, Navigation, Palette, PartyPopper, Pause, Phone, PhoneOff, Play, Plus, Power,
  Radio, Rainbow, SkipBack, SkipForward, Snowflake, Sparkles, Sun, Target, Thermometer, TriangleAlert, Volume2, VolumeX, Waves,
  Wind, Zap, Grid2x2,
} from 'lucide-react';
import type { AmbientColor, AmbientMode, CarState, Intent, Mood, Page, Toast } from '../types';
import { COLOR_LABEL, currentTrack, FAN_MAX, GENRE_LABEL, VOLUME_MAX } from '../state/car';
import { AMBIENT_MODES, ambientColors, HUE_STEPS, hueCss } from '../lib/ambient';
import { PROFILES, useProfileIds, useProfiles } from '../lib/profiles';
import { AddProfileModal } from './AddProfileModal';
import { EqBars } from './EqBars';
import { MapView } from './MapView';

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  car: CarState;
  toast: Toast | null;
  voice: { phase: VoicePhase; interim: string; reply: string };
  onIntent: (i: Intent) => void;
  width: number;
  height: number;
}

const GENRE_ICON = { lofi: Disc3, romantic: Heart, party: PartyPopper, devotional: Flower2, retro: Radio };
const TOAST_ICON = { climate: Thermometer, fan: Fan, music: Music, volume: Volume2, light: Lightbulb, seat: Armchair, wiper: CloudRain, window: Wind, drive: Car, nav: Navigation, phone: Phone, power: Power, lock: Lock };

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function Infotainment({ car, toast, voice, onIntent, width, height }: Props) {
  const now = useClock();
  const cycling = car.ambient.mode === 'rainbow' || car.ambient.mode === 'music';
  const accent = car.ambient.on && !cycling ? ambientColors(car).css : '#3d8bff';
  const style = { width, height, '--accent': accent, fontSize: `${height / 25}px` } as CSSProperties;
  const go = (page: Page) => onIntent({ type: 'screen', page });
  const [picking, setPicking] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const profileIds = useProfileIds();
  const profiles = useProfiles();
  const me = profiles[car.profile] ?? PROFILES[car.profile];

  return (
    <div className="ivi" style={style}>
      {car.ignition !== 'off' ? (<>
        <header className="ivi-status">
          <div className="ivi-time">
            <b>{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</b>
            <span>{now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          </div>
          <div className="ivi-status-mid">
            {car.phone && <span className="pill live"><Phone /> {car.phone.contact}</span>}
            {car.nav && !car.phone && <span className="pill"><Navigation /> {car.nav.destination} · {car.nav.minutes} min</span>}
            {car.media.playing && !car.nav && !car.phone && <span className="pill"><Music /> {car.media.radio ? `FM ${car.media.freq.toFixed(1)}` : currentTrack(car.media).title}</span>}
          </div>
          <button className="ivi-profile" onClick={() => setPicking(true)} aria-label={`Driver profile: ${me.name}. Change profile`}>
            <i style={{ background: me.accent }}>{me.name[0]}</i>{me.name}
          </button>
          <div className="ivi-icons">
            {car.hazard && <TriangleAlert className="blink-red" />}
            {car.wipers !== 'off' && <CloudRain />}
            {car.ignition === 'acc' && <span className="acc-pill">ACC</span>}
            <span>27°C</span>
          </div>
        </header>

        {picking && (
          <div className="ivi-profiles" role="dialog" aria-label="Choose driver profile" onClick={() => setPicking(false)}>
            <small>Who's driving?</small>
            <div>
              {profileIds.map((id) => {
                const item = profiles[id] ?? PROFILES[id];
                return (
                  <button key={id} className={id === car.profile ? 'on' : ''} style={{ '--pc': item.accent } as CSSProperties}
                    onClick={() => { onIntent({ type: 'profile', id }); setPicking(false); }}>
                    <i>{item.name[0]}</i><b>{item.name}</b><span>{item.heightCm} cm · {item.build}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="seat-add-btn"
                style={{ padding: '6px 12px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPicking(false);
                  setShowAddModal(true);
                }}
              >
                <i>+</i><b>Add New</b><span>Profile</span>
              </button>
            </div>
          </div>
        )}
        <AddProfileModal
          isOpen={showAddModal}
          onClose={() => setShowAddModal(false)}
          onProfileCreated={(np) => onIntent({ type: 'profile', id: np.id })}
        />

        <main className="ivi-body" key={car.screen}>
          {car.screen === 'home' && <HomePage car={car} onIntent={onIntent} go={go} />}
          {car.screen === 'media' && <MediaPage car={car} onIntent={onIntent} />}
          {car.screen === 'climate' && <ClimatePage car={car} onIntent={onIntent} />}
          {car.screen === 'lights' && <LightsPage car={car} onIntent={onIntent} />}
          {car.screen === 'nav' && <NavPage car={car} onIntent={onIntent} />}
          {car.screen === 'phone' && <PhonePage car={car} onIntent={onIntent} />}
          {car.screen === 'vehicle' && <VehiclePage car={car} onIntent={onIntent} />}
        </main>

        <nav className="ivi-dock">
          {([
            ['home', House, 'Home'], ['nav', Navigation, 'Navigation'], ['media', Music, 'Media'],
            ['climate', Fan, 'Climate'], ['lights', Palette, 'Lights'], ['phone', Phone, 'Phone'], ['vehicle', Car, 'Vehicle'],
          ] as const).map(([page, Icon, label]) => (
            <button key={page} className={car.screen === page ? 'on' : ''} onClick={() => go(page)} aria-label={label}>
              <Icon /><span>{label}</span>
            </button>
          ))}
          <div className="dock-climate">
            <span>{car.climate.on ? `${car.climate.temp.toFixed(1)}°C` : 'AC OFF'}</span>
            <Fan /> <i>{car.climate.on ? car.climate.fan : '-'}</i>
          </div>
        </nav>

        {toast && (
          <div className="ivi-toast" key={toast.id}>
            {(() => { const Icon = TOAST_ICON[toast.icon]; return <Icon />; })()}
            <span>{toast.label}</span>
            <b>{toast.value}</b>
          </div>
        )}
      </>) : (
        <div className="standby">
          <b>{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</b>
          <span>VERNA</span>
          <small>Press ENGINE START or say "gaadi start karo"</small>
        </div>
      )}

      {voice.phase !== 'idle' && (
        <div className={`ivi-voice ${voice.phase}`}>
          <div className="voice-orb"><i /><i /><i /><Mic /></div>
          <div className="voice-text">
            <small>{voice.phase === 'listening' ? 'Listening… Boliye' : voice.phase === 'thinking' ? 'Understanding…' : 'Verna'}</small>
            <p>{voice.phase === 'speaking' ? voice.reply : voice.interim || '…'}</p>
          </div>
        </div>
      )}
      <div className="ivi-glare" />
    </div>
  );
}

type PageProps = { car: CarState; onIntent: (i: Intent) => void };

function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <section className={`card ${className}`} onClick={onClick}>{children}</section>;
}

function Art({ car, size = 'md' }: { car: CarState; size?: 'md' | 'lg' }) {
  const Icon = car.media.radio ? Radio : GENRE_ICON[car.media.genre];
  return (
    <div className={`art art-${car.media.radio ? 'radio' : car.media.genre} art-${size} ${car.media.playing ? 'spin' : ''}`}>
      <Icon />
    </div>
  );
}

function FanBars({ level }: { level: number }) {
  return (
    <div className="fanbars">
      {Array.from({ length: FAN_MAX }, (_, i) => <i key={i} className={i < level ? 'on' : ''} style={{ height: `${30 + i * 10}%` }} />)}
    </div>
  );
}

function HomePage({ car, onIntent, go }: PageProps & { go: (p: Page) => void }) {
  const t = currentTrack(car.media);
  return (
    <div className="home">
      <Card className="home-nav" onClick={() => go('nav')}>
        <MapView destination={car.nav?.destination ?? null} mini />
        <div className="home-nav-info">
          {car.nav ? (
            <><small>Navigating to</small><b>{car.nav.destination}</b><span>{car.nav.minutes} min · {car.nav.km} km</span></>
          ) : (
            <>
              <small>Where to?</small>
              <div className="chips" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onIntent({ type: 'nav.start', destination: 'Home' })}><House /> Home</button>
                <button onClick={() => onIntent({ type: 'nav.start', destination: 'Office' })}><MapPin /> Office</button>
              </div>
            </>
          )}
        </div>
      </Card>
      <Card className="home-media" onClick={() => go('media')}>
        <Art car={car} />
        <div className="meta">
          <small>{car.media.playing ? 'Now playing' : 'Paused'}</small>
          <b>{car.media.radio ? `FM ${car.media.freq.toFixed(1)}` : t.title}</b>
          <span>{car.media.radio ? 'Live radio' : t.artist}</span>
        </div>
        {car.media.playing && <EqBars bars={14} active={!car.media.muted} className="eq-sm" />}
        <div className="ctrl" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onIntent(car.media.playing ? { type: 'media.pause' } : { type: 'media.play' })}>
            {car.media.playing ? <Pause /> : <Play />}
          </button>
          <button onClick={() => onIntent({ type: 'media.skip', dir: 1 })}><SkipForward /></button>
        </div>
      </Card>
      <Card className="home-climate" onClick={() => go('climate')}>
        <small>Climate {car.climate.auto && <em>AUTO</em>}</small>
        <div className="big-temp">{car.climate.on ? car.climate.temp.toFixed(1) : 'OFF'}{car.climate.on && <sup>°C</sup>}</div>
        <span>{car.climate.on ? `Fan ${car.climate.fan} · ${car.climate.temp <= 21 ? 'Cooling' : car.climate.temp >= 26 ? 'Warming' : 'Comfort'}` : 'Climate off'}</span>
        <FanBars level={car.climate.on ? car.climate.fan : 0} />
        <div className="row-icons">
          {car.seats.driver > 0 && <span className="tag"><Armchair /> {car.seats.driver}</span>}
          {car.sunroof && <span className="tag"><Sun /> Roof</span>}
          {car.climate.on && <span className="tag"><Snowflake /> AC</span>}
        </div>
      </Card>
    </div>
  );
}

function MediaPage({ car, onIntent }: PageProps) {
  const t = currentTrack(car.media);
  const g = GENRE_LABEL[car.media.genre];
  return (
    <div className="media">
      <Art car={car} size="lg" />
      <div className="media-main">
        <small>{car.media.radio ? 'Radio' : `${g.en} mix`}</small>
        <h2>{car.media.radio ? `FM ${car.media.freq.toFixed(1)}` : t.title}</h2>
        <p>{car.media.radio ? 'Live broadcast' : t.artist}</p>
        <div className="progress"><i key={`${car.media.genre}-${car.media.track}`} className={car.media.playing ? 'run' : ''} /></div>
        <div className="media-ctrl">
          <button onClick={() => onIntent({ type: 'media.skip', dir: -1 })}><SkipBack /></button>
          <button className="primary" onClick={() => onIntent(car.media.playing ? { type: 'media.pause' } : { type: 'media.play' })}>
            {car.media.playing ? <Pause /> : <Play />}
          </button>
          <button onClick={() => onIntent({ type: 'media.skip', dir: 1 })}><SkipForward /></button>
        </div>
        <div className="volume">
          <button onClick={() => onIntent({ type: 'media.volume', mute: !car.media.muted })}>{car.media.muted ? <VolumeX /> : <Volume2 />}</button>
          <div className="vol-track"><i style={{ width: `${car.media.muted ? 0 : (car.media.volume / VOLUME_MAX) * 100}%` }} /></div>
          <b>{car.media.muted ? 'Mute' : car.media.volume}</b>
        </div>
      </div>
      <EqBars bars={28} active={car.media.playing && !car.media.muted} className="eq-lg" />
    </div>
  );
}

function TempControl({ label, value, on, onStep }: { label: string; value: number; on: boolean; onStep: (d: number) => void }) {
  return (
    <div className="temp-ctl">
      <button onClick={() => onStep(0.5)}><Plus /></button>
      <div className="temp-val">
        <small>{label}</small>
        <b>{on ? value.toFixed(1) : '--'}</b>
        <span>°C</span>
      </div>
      <button onClick={() => onStep(-0.5)}><Minus /></button>
    </div>
  );
}

function ClimatePage({ car, onIntent }: PageProps) {
  const c = car.climate;
  return (
    <div className="climate">
      <TempControl label="Cabin" value={c.temp} on={c.on} onStep={(d) => onIntent({ type: 'climate.setTemp', value: c.temp + d })} />
      <div className="climate-mid">
        <div className="fan-ring">
          {Array.from({ length: FAN_MAX }, (_, i) => (
            <i key={i} className={c.on && i < c.fan ? 'on' : ''} style={{ transform: `rotate(${-112 + i * 32}deg) translateY(-2.6em)` }} />
          ))}
          <div><Fan className={c.on ? 'spin-fan' : ''} style={{ animationDuration: `${2.4 - c.fan * 0.25}s` }} /><b>{c.on ? c.fan : 0}</b></div>
        </div>
        <div className="fan-btns">
          <button onClick={() => onIntent({ type: 'climate.fan', delta: -1 })}><Minus /></button>
          <button className={c.on ? 'on' : ''} onClick={() => onIntent({ type: 'climate.power', on: !c.on })}><Power /> AC</button>
          <button className={c.auto ? 'on' : ''} onClick={() => onIntent({ type: 'climate.auto' })}>AUTO</button>
          <button onClick={() => onIntent({ type: 'climate.fan', delta: 1 })}><Plus /></button>
        </div>
        <div className="seat-btns">
          {(['driver', 'passenger'] as const).map((z) => (
            <button key={z} className={car.seats[z] ? 'on' : ''} onClick={() => onIntent({ type: 'seat.vent', target: z, level: (car.seats[z] + 1) % 4 })}>
              <Armchair /><Wind />
              <span className="lvl">{[0, 1, 2].map((i) => <i key={i} className={i < car.seats[z] ? 'on' : ''} />)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NavPage({ car, onIntent }: PageProps) {
  const eta = car.nav ? new Date(car.nav.startedAt + car.nav.minutes * 60000) : null;
  return (
    <div className="navpage">
      <MapView destination={car.nav?.destination ?? null} />
      {car.nav ? (
        <>
          <div className="turn-card"><CornerUpRight /><div><b>400 m</b><span>Turn right onto Outer Ring Rd</span></div></div>
          <div className="eta-card">
            <div><b>{car.nav.minutes}</b><small>min</small></div>
            <div><b>{car.nav.km}</b><small>km</small></div>
            <div><b>{eta!.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</b><small>arrival</small></div>
            <div className="dest"><MapPin />{car.nav.destination}</div>
            <button onClick={() => onIntent({ type: 'nav.stop' })}>End</button>
          </div>
        </>
      ) : (
        <div className="eta-card idle">
          <span>Say "<b>ghar le chalo</b>" or "<b>take me to the airport</b>"</span>
          <button onClick={() => onIntent({ type: 'nav.start', destination: 'Home' })}><House /> Home</button>
        </div>
      )}
    </div>
  );
}

function PhonePage({ car, onIntent }: PageProps) {
  const now = useClock();
  const [muted, setMuted] = useState(false);
  if (!car.phone) {
    return (
      <div className="phone idle">
        <Grid2x2 />
        <p>Say "<b>Mummy ko call karo</b>" or "<b>call Rahul</b>"</p>
        <div className="chips">
          {['Mummy', 'Papa', 'Rahul'].map((n) => (
            <button key={n} onClick={() => onIntent({ type: 'phone.call', contact: n })}><Phone /> {n}</button>
          ))}
        </div>
      </div>
    );
  }
  const secs = Math.max(0, Math.floor((now.getTime() - car.phone.startedAt) / 1000) - 3);
  const status = secs <= 0 ? 'Calling…' : `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="phone">
      <div className={`avatar ${secs <= 0 ? 'ringing' : ''}`}>{car.phone.contact.slice(0, 1)}</div>
      <h2>{car.phone.contact}</h2>
      <p>{status}</p>
      <div className="phone-btns">
        <button className={muted ? 'on' : ''} onClick={() => setMuted(!muted)}>{muted ? <MicOff /> : <Mic />}</button>
        <button className="end" onClick={() => onIntent({ type: 'phone.end' })}><PhoneOff /></button>
        <button><Grid2x2 /></button>
      </div>
    </div>
  );
}

const MOOD_BUTTONS: [Mood, typeof Heart, string][] = [
  ['party', PartyPopper, 'Party'], ['relax', Leaf, 'Relax'], ['romantic', Heart, 'Romantic'],
  ['focus', Target, 'Focus'], ['energy', Zap, 'Energy'], ['cozy', Flame, 'Cozy'],
];
const MODE_ICON: Record<AmbientMode, typeof Heart> = {
  static: Lightbulb, breathe: Waves, flow: Sparkles, music: AudioLines, drive: Gauge, rainbow: Rainbow, dual: Contrast,
};

/** Ambient lighting: mood presets, light effects, 10 named colours plus the 64-colour palette. */
function LightsPage({ car, onIntent }: PageProps) {
  const a = car.ambient;
  const [target, setTarget] = useState<'dash' | 'doors'>('dash');
  const doors = a.mode === 'dual' && target === 'doors';
  const name = a.hue !== null ? `Colour ${a.hue + 1} / ${HUE_STEPS}` : COLOR_LABEL[a.color].en;
  const pick = (color: AmbientColor) => onIntent(doors ? { type: 'ambient.mode', mode: 'dual', color2: color } : { type: 'ambient.color', color });
  return (
    <div className="lights">
      <div className="lights-head">
        <button className={`power ${a.on ? 'on' : ''}`} onClick={() => onIntent({ type: 'ambient.power', on: !a.on })} aria-label="Ambient lighting on or off"><Power /></button>
        <div className="name">
          <small>Ambient lighting</small>
          <b>{a.on ? <>{name}{a.mode === 'dual' && <> · {COLOR_LABEL[a.color2].en}</>}</> : 'Off'}</b>
        </div>
        {a.mode === 'dual' && (
          <div className="segmented dual-target">
            <button className={target === 'dash' ? 'on' : ''} onClick={() => setTarget('dash')}>Dash</button>
            <button className={target === 'doors' ? 'on' : ''} onClick={() => setTarget('doors')}>Doors</button>
          </div>
        )}
        <div className="bright">
          <button onClick={() => onIntent({ type: 'ambient.brightness', delta: -0.2 })} aria-label="Dimmer"><Minus /></button>
          <div className="vol-track"><i style={{ width: `${(a.brightness / 1.5) * 100}%` }} /></div>
          <button onClick={() => onIntent({ type: 'ambient.brightness', delta: 0.2 })} aria-label="Brighter"><Plus /></button>
        </div>
      </div>
      <div className="moods">
        {MOOD_BUTTONS.map(([mood, Icon, label]) => (
          <button key={mood} onClick={() => onIntent({ type: 'mood', mood })}><Icon /> {label}</button>
        ))}
      </div>
      <div className="segmented fx">
        {AMBIENT_MODES.map((m) => {
          const Icon = MODE_ICON[m.id];
          return <button key={m.id} className={a.on && a.mode === m.id ? 'on' : ''} onClick={() => onIntent({ type: 'ambient.mode', mode: m.id })}><Icon /> {m.en}</button>;
        })}
      </div>
      <div className="swatches">
        {(Object.keys(COLOR_LABEL) as AmbientColor[]).map((c) => {
          const on = doors ? a.color2 === c : a.hue === null && a.color === c;
          return <button key={c} className={on ? 'on' : ''} style={{ background: COLOR_LABEL[c].css }} onClick={() => pick(c)} aria-label={COLOR_LABEL[c].en} title={COLOR_LABEL[c].en} />;
        })}
        <div className="hue" title="64-colour palette">
          {Array.from({ length: HUE_STEPS }, (_, i) => (
            <button key={i} className={!doors && a.hue === i ? 'on' : ''} style={{ background: hueCss(i) }} disabled={doors}
              onClick={() => onIntent({ type: 'ambient.hue', hue: i })} aria-label={`Colour ${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function VehiclePage({ car, onIntent }: PageProps) {
  return (
    <div className="vehicle">
      <svg viewBox="0 0 120 220" className="car-top">
        <defs>
          <linearGradient id="body" x1="0" x2="1">
            <stop offset="0" stopColor="#2a3346" /><stop offset="0.5" stopColor="#56627b" /><stop offset="1" stopColor="#2a3346" />
          </linearGradient>
        </defs>
        <path d="M60 6 C 92 6, 104 22, 106 48 L 108 170 C 108 200, 92 214, 60 214 C 28 214, 12 200, 12 170 L 14 48 C 16 22, 28 6, 60 6 Z" fill="url(#body)" stroke="#7d8aa6" strokeWidth="1" />
        <path d="M26 58 C 40 50, 80 50, 94 58 L 88 82 C 70 78, 50 78, 32 82 Z" fill="#0b1220" />
        <rect x="38" y="92" width="44" height="38" rx="6" className={car.sunroof ? 'glass open' : 'glass'} />
        <path d="M18 88 L 24 86 L 24 126 L 18 128 Z" className={car.windows.passenger ? 'glass open' : 'glass'} />
        <path d="M102 88 L 96 86 L 96 126 L 102 128 Z" className={car.windows.driver ? 'glass open' : 'glass'} />
        <path d="M30 186 C 48 192, 72 192, 90 186 L 86 168 C 70 172, 50 172, 34 168 Z" fill="#0b1220" />
        {car.headlights && <><path d="M30 8 L 10 -30 L 50 -30 Z" fill="#fff6d0" opacity="0.35" /><path d="M90 8 L 70 -30 L 110 -30 Z" fill="#fff6d0" opacity="0.35" /></>}
        {car.hazard && <><circle cx="16" cy="40" r="4" className="blink-amber" /><circle cx="104" cy="40" r="4" className="blink-amber" /><circle cx="16" cy="196" r="4" className="blink-amber" /><circle cx="104" cy="196" r="4" className="blink-amber" /></>}
      </svg>
      <div className="vehicle-side">
        <small>Drive mode</small>
        <div className="segmented">
          {(['eco', 'normal', 'sport'] as const).map((m) => (
            <button key={m} className={`${car.driveMode === m ? 'on' : ''} mode-${m}`} onClick={() => onIntent({ type: 'drive.mode', mode: m })}>{m}</button>
          ))}
        </div>
        <div className="toggles">
          <button className={car.headlights ? 'on' : ''} onClick={() => onIntent({ type: 'lights.head', on: !car.headlights })}><Lightbulb /> Headlights</button>
          <button className={car.hazard ? 'on danger' : ''} onClick={() => onIntent({ type: 'lights.hazard', on: !car.hazard })}><TriangleAlert /> Hazard</button>
          <button className={car.wipers !== 'off' ? 'on' : ''} onClick={() => onIntent({ type: 'wipers', mode: car.wipers === 'off' ? 'slow' : car.wipers === 'slow' ? 'fast' : 'off' })}><CloudRain /> Wipers {car.wipers !== 'off' && car.wipers}</button>
          <button className={car.sunroof ? 'on' : ''} onClick={() => onIntent({ type: 'sunroof', open: !car.sunroof })}><Sun /> Sunroof</button>
          <button className={car.windows.driver || car.windows.passenger ? 'on' : ''} onClick={() => onIntent({ type: 'window', target: 'both', open: car.windows.driver || car.windows.passenger ? 0 : 100 })}><Wind /> Windows</button>
          <button className={car.adas.lka ? 'on' : ''} onClick={() => onIntent({ type: 'adas.lka', on: !car.adas.lka })}><Car /> Lane keep</button>
          <button className={car.adas.cruise !== null ? 'on' : ''} onClick={() => onIntent({ type: 'cruise', on: car.adas.cruise === null })}><Gauge /> Cruise {car.adas.cruise ?? ''}</button>
          <button className={car.autoHold ? 'on' : ''} onClick={() => onIntent({ type: 'autohold', on: !car.autoHold })}><Lock /> Auto hold</button>
        </div>
        <div className="fuel">
          <Fuel /><div className="vol-track"><i style={{ width: `${car.fuel}%` }} /></div><b>{car.range} km</b>
        </div>
      </div>
    </div>
  );
}
