export type Lang = 'en' | 'hi';
export type Genre = 'lofi' | 'romantic' | 'party' | 'devotional' | 'retro';
export type AmbientColor =
  | 'blue' | 'red' | 'green' | 'purple' | 'pink' | 'orange' | 'white' | 'yellow' | 'cyan' | 'gold';
/** How the ambient light pipes behave, on top of their colour. */
export type AmbientMode = 'static' | 'breathe' | 'flow' | 'music' | 'drive' | 'rainbow' | 'dual';
export type DriveMode = 'eco' | 'normal' | 'sport';
export type Page = 'home' | 'nav' | 'media' | 'climate' | 'lights' | 'phone' | 'vehicle';
export type Zone = 'driver' | 'passenger' | 'both';
export type Mood = 'party' | 'relax' | 'romantic' | 'focus' | 'energy' | 'cozy';
/** What the centre of the instrument cluster shows (cycled with the right spoke arrows). */
export type ClusterView = 'drive' | 'trip' | 'tyres';
export type WiperMode = 'off' | 'slow' | 'fast';
export type SceneId = 'live' | 'night' | 'day';
export type Gear = 'P' | 'R' | 'N' | 'D';
/** Push-button ignition: OFF, ACC (electronics on, engine off) and ON (engine running). */
export type Ignition = 'off' | 'acc' | 'on';
export type Indicator = 'off' | 'left' | 'right';
/** Driver profile id: 'default' is always present; others are user-created. */
export type ProfileId = string;

export type Intent =
  | { type: 'climate.setTemp'; value: number }
  | { type: 'climate.adjustTemp'; delta: number; feeling?: 'hot' | 'cold' }
  | { type: 'climate.power'; on: boolean }
  | { type: 'climate.fan'; value?: number; delta?: number }
  | { type: 'climate.auto' }
  | { type: 'climate.recirc'; on?: boolean }
  | { type: 'climate.defrost'; on?: boolean }
  | { type: 'media.play'; genre?: Genre; radio?: boolean; freq?: number }
  | { type: 'media.pause' }
  | { type: 'media.skip'; dir: 1 | -1 }
  | { type: 'media.volume'; value?: number; delta?: number; mute?: boolean }
  | { type: 'ambient.color'; color: AmbientColor }
  | { type: 'ambient.power'; on: boolean }
  | { type: 'ambient.brightness'; delta: number }
  | { type: 'ambient.mode'; mode: AmbientMode; color2?: AmbientColor }
  /** One of the 64 palette steps (0-63) of the custom colour wheel. */
  | { type: 'ambient.hue'; hue: number }
  | { type: 'mood'; mood: Mood }
  | { type: 'wipers'; mode: WiperMode; rain?: boolean }
  | { type: 'window'; target: Zone; open: number }
  | { type: 'sunroof'; open: boolean; fresh?: boolean }
  | { type: 'seat.vent'; target: Zone; level?: number; delta?: number }
  | { type: 'nav.start'; destination: string }
  | { type: 'nav.stop' }
  | { type: 'phone.call'; contact: string }
  | { type: 'phone.end' }
  | { type: 'drive.mode'; mode: DriveMode }
  | { type: 'lights.head'; on: boolean }
  | { type: 'lights.hazard'; on: boolean }
  | { type: 'scene'; scene: SceneId }
  /** Switch driver profile; without an id, the next one. */
  | { type: 'profile'; id?: ProfileId }
  | { type: 'ignition'; mode: Ignition }
  | { type: 'rev' }
  | { type: 'gear'; gear: Gear }
  | { type: 'indicator'; dir: Indicator }
  | { type: 'lights.cabin'; on: boolean }
  | { type: 'doors.lock'; locked: boolean }
  | { type: 'autohold'; on?: boolean }
  | { type: 'screen'; page: Page }
  | { type: 'cluster.view'; view?: ClusterView; dir?: 1 | -1 }
  | { type: 'adas.lka'; on: boolean }
  /** Smart Cruise Control: set speed in km/h, nudge it, or cancel. */
  | { type: 'cruise'; on: boolean; speed?: number; delta?: number }
  | { type: 'query'; topic: 'temp' | 'fuel' | 'music' | 'time' | 'speed' | 'tyres' }
  | { type: 'greet' }
  | { type: 'help' }
  | { type: 'thanks' };

export interface CarState {
  scene: SceneId;
  climate: { on: boolean; temp: number; fan: number; auto: boolean; recirc: boolean; defrost: boolean };
  media: { playing: boolean; radio: boolean; freq: number; genre: Genre; track: number; volume: number; muted: boolean };
  /** `hue` (0-63) overrides `color` when set; `color2` is the door colour in dual-tone mode. */
  ambient: { on: boolean; color: AmbientColor; color2: AmbientColor; hue: number | null; brightness: number; mode: AmbientMode };
  wipers: WiperMode;
  windows: { driver: number; passenger: number };
  sunroof: boolean;
  seats: { driver: number; passenger: number };
  /** Active driver profile: sets seat and steering position and the driver's preferences. */
  profile: ProfileId;
  nav: { destination: string; minutes: number; km: number; startedAt: number } | null;
  phone: { contact: string; startedAt: number } | null;
  driveMode: DriveMode;
  headlights: boolean;
  hazard: boolean;
  ignition: Ignition;
  gear: Gear;
  indicator: Indicator;
  cabinLight: boolean;
  locked: boolean;
  autoHold: boolean;
  screen: Page;
  cluster: ClusterView;
  /** Lane Keeping Assist and the Smart Cruise set speed (null = cruise off). */
  adas: { lka: boolean; cruise: number | null };
  fuel: number;
  range: number;
  /** Tyre pressures in psi: front left, front right, rear left, rear right. */
  tyres: [number, number, number, number];
}

export interface Toast {
  id: number;
  icon: 'climate' | 'fan' | 'music' | 'volume' | 'light' | 'seat' | 'wiper' | 'window' | 'drive' | 'nav' | 'phone' | 'power' | 'lock';
  label: string;
  value: string;
}

export interface Reply {
  en: string;
  hi: string;
  toast?: Omit<Toast, 'id'>;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'car';
  text: string;
  intents?: Intent[];
  via?: 'voice' | 'text' | 'chip';
  /** Which NLU understood the command (set only while the backend is connected). */
  engine?: 'backend' | 'local' | 'llm';
}
