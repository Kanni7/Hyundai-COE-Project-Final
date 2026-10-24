import type { AmbientColor, CarState, ClusterView, Genre, Intent, Lang, Reply, Toast } from '../types';
import { AMBIENT_MODES, HUE_STEPS } from '../lib/ambient';
import { fitFor, PROFILE_IDS, PROFILES } from '../lib/profiles';

export const TEMP_MIN = 16;
export const TEMP_MAX = 30;
export const FAN_MAX = 8;
export const VOLUME_MAX = 30;
export const CRUISE_MIN = 30;
export const CRUISE_MAX = 180;
const CLUSTER_VIEWS: ClusterView[] = ['drive', 'trip', 'tyres'];

export const TRACKS: Record<Genre, { title: string; artist: string }[]> = {
  lofi: [
    { title: 'Monsoon Window', artist: 'Verna Sessions' },
    { title: 'Late Night Chai', artist: 'Verna Sessions' },
    { title: 'Sea Link Drift', artist: 'Verna Sessions' },
  ],
  romantic: [
    { title: 'Baarish Mein Tum', artist: 'Sound Lab Hyderabad' },
    { title: 'Slow Lanes', artist: 'Sound Lab Hyderabad' },
    { title: 'Marine Drive Nights', artist: 'Sound Lab Hyderabad' },
  ],
  party: [
    { title: 'Highway Dhamaal', artist: 'Turbo GDi' },
    { title: 'Neon Bazaar', artist: 'Turbo GDi' },
    { title: 'Sport Mode Bhangra', artist: 'Turbo GDi' },
  ],
  devotional: [
    { title: 'Subah Ki Aarti', artist: 'Mandir Strings' },
    { title: 'Ganga Ghat Dawn', artist: 'Mandir Strings' },
  ],
  retro: [
    { title: 'Cassette Days', artist: 'Doordarshan Disco' },
    { title: 'Purani Yaadein', artist: 'Doordarshan Disco' },
  ],
};

export const GENRE_LABEL: Record<Genre, { en: string; hi: string }> = {
  lofi: { en: 'lo-fi chill', hi: 'chill lo-fi' },
  romantic: { en: 'romantic', hi: 'romantic' },
  party: { en: 'party', hi: 'party wale' },
  devotional: { en: 'devotional', hi: 'bhakti' },
  retro: { en: 'retro classics', hi: 'purane' },
};

export const COLOR_LABEL: Record<AmbientColor, { en: string; hi: string; css: string }> = {
  blue: { en: 'blue', hi: 'neeli', css: '#3d8bff' },
  red: { en: 'red', hi: 'laal', css: '#ff3b30' },
  green: { en: 'green', hi: 'hari', css: '#34e07a' },
  purple: { en: 'purple', hi: 'baingani', css: '#9d5cff' },
  pink: { en: 'pink', hi: 'gulabi', css: '#ff4fa8' },
  orange: { en: 'orange', hi: 'narangi', css: '#ff8a1f' },
  white: { en: 'white', hi: 'safed', css: '#eef3ff' },
  yellow: { en: 'yellow', hi: 'peeli', css: '#ffd83a' },
  cyan: { en: 'cyan', hi: 'aasmani', css: '#22e4ff' },
  gold: { en: 'gold', hi: 'sunehri', css: '#ffb84d' },
};

export const initialCar: CarState = {
  scene: 'live',
  climate: { on: true, temp: 22, fan: 3, auto: false, recirc: false, defrost: false },
  media: { playing: false, radio: false, freq: 93.5, genre: 'lofi', track: 0, volume: 12, muted: false },
  ambient: { on: true, color: 'blue', color2: 'purple', hue: null, brightness: 1, mode: 'static' },
  wipers: 'off',
  windows: { driver: 0, passenger: 0 },
  sunroof: false,
  seats: { driver: 0, passenger: 0 },
  profile: 'default',
  nav: null,
  phone: null,
  driveMode: 'normal',
  headlights: false,
  hazard: false,
  ignition: 'off',
  gear: 'P',
  indicator: 'off',
  cabinLight: false,
  locked: false,
  autoHold: false,
  screen: 'home',
  cluster: 'drive',
  adas: { lka: true, cruise: null },
  fuel: 62,
  range: 478,
  tyres: [35, 35, 34, 35],
};

export const engineOn = (s: CarState) => s.ignition === 'on';
export const powered = (s: CarState) => s.ignition !== 'off';

export function getTimeGreeting(): { en: string; hi: string } {
  const hr = new Date().getHours();
  if (hr >= 4 && hr < 12) return { en: 'Good morning', hi: 'Good morning' };
  if (hr >= 12 && hr < 17) return { en: 'Good afternoon', hi: 'Good afternoon' };
  return { en: 'Good evening', hi: 'Good evening' };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmt = (t: number) => `${t.toFixed(1).replace(/\.0$/, '')}°C`;

export function currentTrack(m: CarState['media']) {
  const list = TRACKS[m.genre];
  return list[((m.track % list.length) + list.length) % list.length];
}

function hash(s: string) {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const r = (en: string, hi: string, toast?: Reply['toast']): Reply => ({ en, hi, toast });

/** Live readings from the vehicle model that some intents depend on. */
export interface Env { speed: number }

/** Applies one intent; returns the new state plus what the car says back. */
export function applyIntent(s: CarState, it: Intent, env: Env = { speed: 0 }): { state: CarState; reply: Reply } {
  const c = s.climate;
  switch (it.type) {
    case 'climate.setTemp': {
      const v = clamp(Math.round(it.value * 2) / 2, TEMP_MIN, TEMP_MAX);
      const note = v !== it.value ? (v === TEMP_MIN ? ' (that is the minimum)' : ' (that is the maximum)') : '';
      return {
        state: { ...s, climate: { ...c, on: true, auto: false, temp: v } },
        reply: r(`Setting the temperature to ${fmt(v)}.${note}`, `Theek hai, AC ${fmt(v)} pe set kar diya.`,
          { icon: 'climate', label: 'Temperature', value: fmt(v) }),
      };
    }
    case 'climate.adjustTemp': {
      const base = c.temp;
      const v = clamp(base + it.delta, TEMP_MIN, TEMP_MAX);
      const climate = { ...c, on: true, auto: false, temp: v };
      // Feeling hot with a weak blower: push more air too.
      if (it.feeling === 'hot' && climate.fan < 4) climate.fan = Math.min(FAN_MAX, climate.fan + 1);
      const state = { ...s, climate };
      const toast = { icon: 'climate' as const, label: 'Temperature', value: fmt(v) };
      if (v === base && c.on) {
        return { state, reply: r(
          `Already at the ${it.delta < 0 ? 'minimum' : 'maximum'}, ${fmt(v)}.`,
          `AC pehle se ${it.delta < 0 ? 'minimum' : 'maximum'} ${fmt(v)} pe hai.`, toast) };
      }
      if (it.feeling === 'hot') return { state, reply: r(`Cooling the cabin down to ${fmt(v)}.`, `Garmi kam karte hain. Temperature ${fmt(v)} kar diya.`, toast) };
      if (it.feeling === 'cold') return { state, reply: r(`Warming the cabin up to ${fmt(v)}.`, `Thoda garam kar raha hoon. Ab ${fmt(v)}.`, toast) };
      return { state, reply: r(`Temperature ${it.delta < 0 ? 'lowered' : 'raised'} to ${fmt(v)}.`, `Temperature ${fmt(v)} kar diya.`, toast) };
    }
    case 'climate.power': {
      const state = { ...s, climate: { ...c, on: it.on, fan: it.on && c.fan === 0 ? 3 : c.fan } };
      if (it.on === c.on) return { state, reply: r(`The AC is already ${it.on ? 'on' : 'off'}.`, `AC pehle se ${it.on ? 'chalu' : 'band'} hai.`) };
      return { state, reply: it.on
        ? r('AC is on.', 'AC chalu kar diya.', { icon: 'climate', label: 'AC', value: 'On' })
        : r('AC turned off.', 'AC band kar diya.', { icon: 'climate', label: 'AC', value: 'Off' }) };
    }
    case 'climate.fan': {
      const v = clamp(it.value ?? c.fan + (it.delta ?? 0), 0, FAN_MAX);
      if (v === 0) return applyIntent(s, { type: 'climate.power', on: false });
      return {
        state: { ...s, climate: { ...c, on: true, auto: false, fan: v } },
        reply: r(`Fan speed ${v}.`, `Fan speed ${v} kar di.`, { icon: 'fan', label: 'Fan speed', value: `${v} / ${FAN_MAX}` }),
      };
    }
    case 'climate.recirc': {
      const on = it.on ?? !c.recirc;
      return {
        state: { ...s, climate: { ...c, recirc: on } },
        reply: on
          ? r('Recirculation on. Keeping outside air out.', 'Recirculation chalu, bahar ki hawa band.', { icon: 'fan', label: 'Recirculation', value: 'On' })
          : r('Fresh air mode on.', 'Bahar ki taazi hawa aane di.', { icon: 'fan', label: 'Recirculation', value: 'Off' }),
      };
    }
    case 'climate.defrost': {
      const on = it.on ?? !c.defrost;
      return {
        state: { ...s, climate: { ...c, on: on || c.on, defrost: on, fan: on ? Math.max(c.fan, 5) : c.fan } },
        reply: on
          ? r('Front defrost on. Clearing the windshield.', 'Sheesha saaf kar raha hoon, defrost on.', { icon: 'climate', label: 'Defrost', value: 'On' })
          : r('Defrost off.', 'Defrost band.', { icon: 'climate', label: 'Defrost', value: 'Off' }),
      };
    }
    case 'climate.auto':
      return {
        state: { ...s, climate: { ...c, on: true, auto: true, fan: 4 } },
        reply: r('Climate set to Auto.', 'AC auto mode pe kar diya.', { icon: 'climate', label: 'Climate', value: 'AUTO' }),
      };

    case 'media.play': {
      const genre = it.genre ?? s.media.genre;
      const changed = genre !== s.media.genre;
      const media = { ...s.media, playing: true, muted: false, radio: !!it.radio,
        freq: it.freq ?? s.media.freq, genre, track: changed ? 0 : s.media.track };
      const state = { ...s, media, screen: 'media' as const };
      if (media.radio) {
        return { state, reply: r(`Tuning to FM ${media.freq.toFixed(1)}.`, `FM ${media.freq.toFixed(1)} laga diya.`) };
      }
      const t = currentTrack(media);
      const g = GENRE_LABEL[genre];
      return { state, reply: it.genre
        ? r(`Playing ${g.en} music: ${t.title}.`, `${g.hi} gaane chala raha hoon: ${t.title}.`)
        : r(`Playing ${t.title}.`, `Gaana chalu: ${t.title}.`) };
    }
    case 'media.pause':
      return {
        state: { ...s, media: { ...s.media, playing: false } },
        reply: s.media.playing ? r('Music paused.', 'Music band kar diya.') : r('Nothing is playing right now.', 'Abhi koi gaana nahi chal raha.'),
      };
    case 'media.skip': {
      const media = { ...s.media, playing: true, radio: false, track: s.media.track + it.dir };
      const t = currentTrack(media);
      return {
        state: { ...s, media, screen: 'media' },
        reply: it.dir > 0 ? r(`Next track: ${t.title}.`, `Agla gaana: ${t.title}.`) : r(`Previous track: ${t.title}.`, `Pichla gaana: ${t.title}.`),
      };
    }
    case 'media.volume': {
      if (it.mute !== undefined) {
        return {
          state: { ...s, media: { ...s.media, muted: it.mute } },
          reply: it.mute
            ? r('Muted.', 'Awaaz mute kar di.', { icon: 'volume', label: 'Volume', value: 'Muted' })
            : r(`Unmuted. Volume ${s.media.volume}.`, `Awaaz wapas chalu. Volume ${s.media.volume}.`, { icon: 'volume', label: 'Volume', value: `${s.media.volume}` }),
        };
      }
      const v = clamp(it.value ?? s.media.volume + (it.delta ?? 0), 0, VOLUME_MAX);
      return {
        state: { ...s, media: { ...s.media, volume: v, muted: false } },
        reply: r(`Volume ${v}.`, `Volume ${v} kar diya.`, { icon: 'volume', label: 'Volume', value: `${v}` }),
      };
    }

    case 'ambient.color': {
      const l = COLOR_LABEL[it.color];
      return {
        state: { ...s, ambient: { ...s.ambient, on: true, color: it.color, hue: null,
          mode: s.ambient.mode === 'rainbow' || s.ambient.mode === 'music' ? 'static' : s.ambient.mode } },
        reply: r(`Ambient lighting set to ${l.en}.`, `Ambient light ${l.hi} kar di.`, { icon: 'light', label: 'Ambient light', value: l.en }),
      };
    }
    case 'ambient.power':
      return {
        state: { ...s, ambient: { ...s.ambient, on: it.on } },
        reply: it.on
          ? r('Ambient lighting on.', 'Ambient light chalu kar di.', { icon: 'light', label: 'Ambient light', value: 'On' })
          : r('Ambient lighting off.', 'Ambient light band kar di.', { icon: 'light', label: 'Ambient light', value: 'Off' }),
      };
    case 'ambient.brightness': {
      const b = clamp(Math.round((s.ambient.brightness + it.delta) * 10) / 10, 0.3, 1.5);
      return {
        state: { ...s, ambient: { ...s.ambient, on: true, brightness: b } },
        reply: r(`Ambient brightness ${Math.round(b * 100 / 1.5)}%.`, `Roshni ${it.delta > 0 ? 'badha' : 'kam kar'} di.`, { icon: 'light', label: 'Brightness', value: `${Math.round(b * 100 / 1.5)}%` }),
      };
    }
    case 'ambient.mode': {
      const m = AMBIENT_MODES.find((x) => x.id === it.mode)!;
      const color2 = it.color2 ?? (s.ambient.color2 === s.ambient.color ? 'purple' : s.ambient.color2);
      const toast = { icon: 'light' as const, label: 'Light effect', value: m.en };
      const state = { ...s, ambient: { ...s.ambient, on: true, mode: it.mode, color2 } };
      if (it.mode === 'music' && !s.media.playing) {
        return { state, reply: r('Music sync on. The lights will pulse once something plays.', 'Music sync on. Gaana chalega toh lights saath mein naachengi.', toast) };
      }
      if (it.mode === 'dual') {
        const [a, b] = [COLOR_LABEL[s.ambient.color], COLOR_LABEL[color2]];
        return { state, reply: r(`Dual tone: ${a.en} on the dash, ${b.en} on the doors.`, `Dashboard ${a.hi} aur darwaze ${b.hi}.`, toast) };
      }
      return { state, reply: r(`Ambient light effect: ${m.en}.`, `Ambient light ab ${m.hi}.`, toast) };
    }
    case 'ambient.hue': {
      const hue = ((Math.round(it.hue) % HUE_STEPS) + HUE_STEPS) % HUE_STEPS;
      return {
        state: { ...s, ambient: { ...s.ambient, on: true, hue, mode: s.ambient.mode === 'rainbow' ? 'static' : s.ambient.mode } },
        reply: r(`Custom colour ${hue + 1} of ${HUE_STEPS}.`, `Rang number ${hue + 1} set kar diya.`, { icon: 'light', label: 'Ambient colour', value: `${hue + 1} / ${HUE_STEPS}` }),
      };
    }

    case 'mood': {
      if (it.mood === 'party') {
        return {
          state: { ...s, ambient: { ...s.ambient, on: true, mode: 'music', brightness: 1.3 },
            media: { ...s.media, playing: true, radio: false, muted: false, genre: 'party', track: 0, volume: Math.max(s.media.volume, 18) },
            screen: 'media' },
          reply: r('Party mode! The lights now dance to the music.', 'Party mode on! Lights music ke saath naachengi.'),
        };
      }
      if (it.mood === 'relax') {
        return {
          state: { ...s, ambient: { ...s.ambient, on: true, color: 'blue', hue: null, brightness: 0.6, mode: 'breathe' },
            media: { ...s.media, playing: true, radio: false, muted: false, genre: 'lofi', track: 0, volume: Math.min(s.media.volume, 10) },
            climate: { ...c, on: true, temp: 23, fan: 2, auto: false },
            seats: { driver: Math.max(1, s.seats.driver), passenger: s.seats.passenger } },
          reply: r('Relax mode: slow breathing blue light, calm music, 23°C and a cool seat.', 'Aaram se. Dheere saans leti neeli roshni, shaant music, 23°C aur seat thandi.'),
        };
      }
      if (it.mood === 'romantic') {
        return {
          state: { ...s, ambient: { ...s.ambient, on: true, color: 'pink', color2: 'purple', hue: null, brightness: 0.8, mode: 'dual' },
            media: { ...s.media, playing: true, radio: false, muted: false, genre: 'romantic', track: 0 } },
          reply: r('Romantic mode: a pink and purple glow and soft songs.', 'Romantic mood set: gulabi-baingani roshni aur romantic gaane.'),
        };
      }
      if (it.mood === 'energy') {
        return {
          state: { ...s, ambient: { ...s.ambient, on: true, color: 'orange', hue: null, brightness: 1.3, mode: 'flow' },
            media: { ...s.media, playing: true, radio: false, muted: false, genre: 'retro', track: 0, volume: Math.max(s.media.volume, 14) },
            climate: { ...c, on: true, temp: 21, fan: Math.max(c.fan, 4), auto: false } },
          reply: r('Energy mode: flowing orange light, upbeat classics and a cooler 21°C.', 'Energy mode: behti narangi roshni, josh wale gaane aur 21°C.'),
        };
      }
      if (it.mood === 'cozy') {
        return {
          state: { ...s, ambient: { ...s.ambient, on: true, color: 'gold', hue: null, brightness: 0.45, mode: 'static' },
            media: { ...s.media, playing: true, radio: false, muted: false, genre: 'lofi', track: 0, volume: Math.min(s.media.volume, 8) },
            climate: { ...c, on: true, temp: 25, fan: 2, auto: false } },
          reply: r('Cozy mode: dim golden light, soft lo-fi and a warm 25°C.', 'Cozy mode: halki sunehri roshni, dheema lo-fi aur 25°C.'),
        };
      }
      return {
        state: { ...s, ambient: { ...s.ambient, on: true, color: 'white', hue: null, brightness: 0.7, mode: 'static' },
          media: { ...s.media, playing: false }, climate: { ...c, on: true, temp: 22 } },
        reply: r('Focus mode: music off, clean white light, 22°C.', 'Focus mode: music band, safed roshni, 22°C.'),
      };
    }

    case 'wipers': {
      const state = { ...s, wipers: it.mode };
      if (it.mode === 'off') return { state, reply: r('Wipers off.', 'Wiper band kar diye.', { icon: 'wiper', label: 'Wipers', value: 'Off' }) };
      if (it.rain) return { state, reply: r('Looks like rain. Wipers on.', 'Baarish hai, toh wiper chalu kar diye.', { icon: 'wiper', label: 'Wipers', value: it.mode === 'fast' ? 'High' : 'Low' }) };
      return { state, reply: it.mode === 'fast'
        ? r('Wipers on high.', 'Wiper tez kar diye.', { icon: 'wiper', label: 'Wipers', value: 'High' })
        : r('Wipers on.', 'Wiper chalu kar diye.', { icon: 'wiper', label: 'Wipers', value: 'Low' }) };
    }
    case 'window': {
      const windows = {
        driver: it.target === 'passenger' ? s.windows.driver : it.open,
        passenger: it.target === 'driver' ? s.windows.passenger : it.open,
      };
      const who = it.target === 'both' ? 'all windows' : `the ${it.target} window`;
      const whoHi = it.target === 'both' ? 'saari windows' : `${it.target} window`;
      const verb = it.open === 0 ? ['Closing', 'band kar di'] : it.open < 100 ? ['Opening a little:', 'thodi khol di'] : ['Opening', 'khol di'];
      return {
        state: { ...s, windows },
        reply: r(`${verb[0]} ${who}.`, `${whoHi[0].toUpperCase()}${whoHi.slice(1)} ${verb[1]}.`,
          { icon: 'window', label: it.target === 'both' ? 'Windows' : `${it.target[0].toUpperCase()}${it.target.slice(1)} window`, value: it.open === 0 ? 'Closed' : `${it.open}% open` }),
      };
    }
    case 'sunroof':
      return {
        state: { ...s, sunroof: it.open },
        reply: it.open
          ? it.fresh
            ? r('Letting in some fresh air. Sunroof open.', 'Taazi hawa ke liye sunroof khol diya.', { icon: 'window', label: 'Sunroof', value: 'Open' })
            : r('Opening the sunroof.', 'Sunroof khol diya.', { icon: 'window', label: 'Sunroof', value: 'Open' })
          : r('Closing the sunroof.', 'Sunroof band kar diya.', { icon: 'window', label: 'Sunroof', value: 'Closed' }),
      };
    case 'seat.vent': {
      const set = (cur: number) => clamp(it.level ?? cur + (it.delta ?? 0), 0, 3);
      const seats = {
        driver: it.target === 'passenger' ? s.seats.driver : set(s.seats.driver),
        passenger: it.target === 'driver' ? s.seats.passenger : set(s.seats.passenger),
      };
      const lvl = it.target === 'passenger' ? seats.passenger : seats.driver;
      const who = it.target === 'both' ? 'Front seat' : it.target === 'driver' ? 'Driver seat' : 'Passenger seat';
      return {
        state: { ...s, seats },
        reply: lvl === 0
          ? r(`${who} ventilation off.`, `${who} ki ventilation band.`, { icon: 'seat', label: who, value: 'Off' })
          : r(`${who} ventilation at level ${lvl}.`, `${who} ki ventilation level ${lvl} pe.`, { icon: 'seat', label: `${who} cooling`, value: `Level ${lvl}` }),
      };
    }

    case 'profile': {
      const id = it.id ?? PROFILE_IDS[(PROFILE_IDS.indexOf(s.profile) + 1) % PROFILE_IDS.length];
      const p = PROFILES[id];
      if (id === s.profile && it.id) return { state: s, reply: r(`${p.name}'s profile is already active.`, `${p.name} ka profile pehle se laga hai.`) };
      // Memory seats only move at a standstill: a seat sliding under a moving driver is a hazard.
      if (env.speed > 5) return { state: s, reply: r(`Please stop first: the seat can't move while driving.`, `Pehle gaadi rokiye, chalte waqt seat nahi hil sakti.`) };
      const f = fitFor(p);
      const col = COLOR_LABEL[p.prefs.ambient];
      const isDefault = id === 'default';
      const enText = isDefault
        ? `Switched to Default profile. Seat and steering in standard position. AC ${fmt(p.prefs.temp)}, ${col.en} lights, ${p.prefs.driveMode} mode.`
        : `Welcome, ${p.name}. Seat ${f.liftMm} mm up and ${f.slideMm} mm back, steering set for ${p.heightCm} cm. AC ${fmt(p.prefs.temp)}, ${col.en} lights, ${p.prefs.driveMode} mode.`;
      const hiText = isDefault
        ? `Default profile set kar diya hai. Seat aur steering standard position pe. AC ${fmt(p.prefs.temp)}, ${col.hi} light, ${p.prefs.driveMode} mode.`
        : `Namaste ${p.name}! Seat aur steering aapki height (${p.heightCm} cm) ke hisaab se set. AC ${fmt(p.prefs.temp)}, ${col.hi} light, ${p.prefs.driveMode} mode.`;
      return {
        state: { ...s, profile: id, climate: { ...c, temp: p.prefs.temp }, ambient: { ...s.ambient, color: p.prefs.ambient, hue: null },
          driveMode: p.prefs.driveMode },
        reply: r(enText, hiText, { icon: 'seat', label: 'Driver profile', value: p.name }),
      };
    }

    case 'nav.start': {
      const h = hash(it.destination);
      const known: Record<string, [number, number]> = { Home: [24, 11.2], Office: [32, 15.8], Airport: [46, 27.4] };
      const [minutes, km] = known[it.destination] ?? [8 + (h % 40), Math.round((3 + (h % 250) / 10) * 10) / 10];
      return {
        state: { ...s, nav: { destination: it.destination, minutes, km, startedAt: Date.now() }, screen: 'nav' },
        reply: r(`Starting navigation to ${it.destination}. About ${minutes} minutes.`, `${it.destination} ke liye navigation shuru. Lagbhag ${minutes} minute lagenge.`),
      };
    }
    case 'nav.stop':
      return {
        state: { ...s, nav: null, screen: s.screen === 'nav' ? 'home' : s.screen },
        reply: r('Navigation ended.', 'Navigation band kar diya.'),
      };
    case 'phone.call':
      return {
        state: { ...s, phone: { contact: it.contact, startedAt: Date.now() }, screen: 'phone' },
        reply: r(`Calling ${it.contact}.`, `${it.contact} ko call kar raha hoon.`),
      };
    case 'phone.end':
      return {
        state: { ...s, phone: null, screen: s.screen === 'phone' ? 'home' : s.screen },
        reply: s.phone ? r('Call ended.', 'Call kaat diya.') : r('There is no active call.', 'Abhi koi call nahi chal rahi.'),
      };

    case 'drive.mode': {
      const label = { eco: ['Eco', 'Eco mode on. Petrol bachega.', 'Eco mode on. Saving fuel.'], normal: ['Normal', 'Normal mode on.', 'Normal mode on.'], sport: ['Sport', 'Sport mode on. Enjoy the drive!', 'Sport mode on. Enjoy the drive!'] }[it.mode];
      return {
        state: { ...s, driveMode: it.mode },
        reply: r(label[2], label[1], { icon: 'drive', label: 'Drive mode', value: label[0] }),
      };
    }
    case 'lights.head':
      return {
        state: { ...s, headlights: it.on },
        reply: it.on ? r('Headlights on.', 'Headlights jala di.') : r('Headlights off.', 'Headlights band kar di.'),
      };
    case 'lights.hazard':
      return {
        state: { ...s, hazard: it.on },
        reply: it.on ? r('Hazard lights on.', 'Hazard lights chalu.') : r('Hazard lights off.', 'Hazard lights band.'),
      };
    case 'scene':
      return {
        state: { ...s, scene: it.scene },
        reply: {
          live: r('Switching to the live cockpit.', 'Live cockpit view on.'),
          night: r('Switching to the night photo.', 'Night photo view on.'),
          day: r('Switching to the day photo.', 'Day photo view on.'),
        }[it.scene],
      };
    case 'ignition': {
      const from = s.ignition;
      const to = it.mode;
      if (from === to) {
        return { state: s, reply: {
          on: r('The engine is already running.', 'Gaadi pehle se start hai.'),
          acc: r('Accessory mode is already on.', 'ACC mode pehle se on hai.'),
          off: r('The car is already off.', 'Gaadi pehle se band hai.'),
        }[to] };
      }
      const off = to === 'off';
      const state: CarState = {
        ...s,
        ignition: to,
        gear: 'P',
        media: off ? { ...s.media, playing: false } : s.media,
        phone: off ? null : s.phone,
        indicator: off ? 'off' : s.indicator,
        adas: { ...s.adas, cruise: to === 'on' ? s.adas.cruise : null },
      };
      const toast = { icon: 'power' as const, label: 'Ignition', value: to.toUpperCase() };
      if (to === 'on') {

        const g = getTimeGreeting();

        return {

          state,

          reply: r(

            `${g.en}! Engine started.`,

            `${g.hi}! Engine start ho gaya.`,

            toast,

          ),

        };

      }
      if (to === 'acc') {
        return { state, reply: from === 'on'
          ? r('Engine off. Accessories stay on.', 'Engine band, accessories chalu hain.', toast)
          : r('Accessory mode: electronics on, engine off.', 'ACC mode: engine band, baaki sab chalu.', toast) };
      }
      return { state, reply: r('Car switched off.', 'Gaadi poori tarah band kar di.', toast) };
    }
    case 'rev':
      return {
        state: s,
        reply: engineOn(s) ? r('Vroom! Revving the engine.', 'Vroom! Engine rev kar raha hoon.') : r('Start the engine first.', 'Pehle gaadi start kijiye.'),
      };
    case 'gear': {
      if (!engineOn(s) && it.gear !== 'P') {
        return { state: s, reply: r('Start the engine first.', 'Pehle gaadi start kijiye.') };
      }
      // The gearbox refuses P, or a change of direction, while the car is still rolling.
      const reversing = (s.gear === 'R') !== (it.gear === 'R') && it.gear !== 'N';
      if (env.speed > 5 && it.gear !== s.gear && (it.gear === 'P' || reversing)) {
        return { state: s, reply: r(`Please stop first. We are doing ${Math.round(env.speed)} km/h.`, `Pehle gaadi rokiye, abhi ${Math.round(env.speed)} km/h pe hain.`) };
      }
      const text = {
        P: ['Gear in Park.', 'Gear P mein, gaadi park hai.'],
        R: ['Reverse. Please check behind you.', 'Reverse mein daal diya, peeche dekh lijiye.'],
        N: ['Gear in Neutral.', 'Neutral mein daal diya.'],
        D: ['Gear in Drive.', 'Gear D mein daal diya.'],
      }[it.gear];
      const adas = it.gear === 'D' ? s.adas : { ...s.adas, cruise: null };
      return { state: { ...s, gear: it.gear, adas }, reply: r(text[0], text[1], { icon: 'drive', label: 'Gear', value: it.gear }) };
    }
    case 'indicator': {
      const state = { ...s, indicator: it.dir };
      if (it.dir === 'off') return { state, reply: r('Indicator off.', 'Indicator band.') };
      return { state, reply: it.dir === 'left' ? r('Left indicator on.', 'Left indicator chalu.') : r('Right indicator on.', 'Right indicator chalu.') };
    }
    case 'lights.cabin':
      return {
        state: { ...s, cabinLight: it.on },
        reply: it.on ? r('Cabin light on.', 'Andar ki light jala di.', { icon: 'light', label: 'Cabin light', value: 'On' })
          : r('Cabin light off.', 'Andar ki light band kar di.', { icon: 'light', label: 'Cabin light', value: 'Off' }),
      };
    case 'doors.lock':
      return {
        state: { ...s, locked: it.locked },
        reply: it.locked ? r('Doors locked.', 'Darwaze lock kar diye.', { icon: 'lock', label: 'Doors', value: 'Locked' })
          : r('Doors unlocked.', 'Darwaze unlock kar diye.', { icon: 'lock', label: 'Doors', value: 'Unlocked' }),
      };
    case 'autohold': {
      const on = it.on ?? !s.autoHold;
      return {
        state: { ...s, autoHold: on },
        reply: on ? r('Auto Hold on.', 'Auto Hold chalu.', { icon: 'drive', label: 'Auto Hold', value: 'On' })
          : r('Auto Hold off.', 'Auto Hold band.', { icon: 'drive', label: 'Auto Hold', value: 'Off' }),
      };
    }
    case 'screen': {
      const name = { home: 'Home', nav: 'Navigation', media: 'Media', climate: 'Climate', lights: 'Lighting', phone: 'Phone', vehicle: 'Vehicle' }[it.page];
      return { state: { ...s, screen: it.page }, reply: r(`Opening ${name}.`, `${name} screen khol di.`) };
    }
    case 'cluster.view': {
      const i = CLUSTER_VIEWS.indexOf(s.cluster);
      const view = it.view ?? CLUSTER_VIEWS[(i + (it.dir ?? 1) + CLUSTER_VIEWS.length) % CLUSTER_VIEWS.length];
      const name = { drive: ['Driving assist', 'driving assist'], trip: ['Trip computer', 'trip info'], tyres: ['Tyre pressure', 'tyre pressure'] }[view];
      return { state: { ...s, cluster: view }, reply: r(`Cluster: ${name[0]}.`, `Cluster mein ${name[1]} dikha raha hoon.`) };
    }
    case 'adas.lka':
      return {
        state: { ...s, adas: { ...s.adas, lka: it.on } },
        reply: it.on
          ? r('Lane Keeping Assist on.', 'Lane Keeping Assist chalu.', { icon: 'drive', label: 'Lane Keeping', value: 'On' })
          : r('Lane Keeping Assist off.', 'Lane Keeping Assist band.', { icon: 'drive', label: 'Lane Keeping', value: 'Off' }),
      };
    case 'cruise': {
      if (!it.on) {
        return {
          state: { ...s, adas: { ...s.adas, cruise: null } },
          reply: s.adas.cruise === null ? r('Cruise control is already off.', 'Cruise control pehle se band hai.')
            : r('Cruise control cancelled.', 'Cruise control band kar diya.', { icon: 'drive', label: 'Smart Cruise', value: 'Off' }),
        };
      }
      if (!engineOn(s) || s.gear !== 'D') {
        return { state: s, reply: r('Cruise control needs the engine running and the gear in D.', 'Cruise ke liye gaadi start karke gear D mein daaliye.') };
      }
      const base = s.adas.cruise ?? Math.max(CRUISE_MIN, Math.round(env.speed / 5) * 5);
      const v = clamp(Math.round((it.speed ?? base + (it.delta ?? 0)) / 5) * 5, CRUISE_MIN, CRUISE_MAX);
      return {
        state: { ...s, adas: { ...s.adas, cruise: v } },
        reply: r(`Smart Cruise set to ${v} km/h.`, `Cruise ${v} km/h pe set kar diya.`, { icon: 'drive', label: 'Smart Cruise', value: `${v} km/h` }),
      };
    }

    case 'query': {
      if (it.topic === 'temp') {
        return { state: s, reply: c.on
          ? r(`The cabin is set to ${fmt(c.temp)}, fan speed ${c.fan}.`, `AC abhi ${fmt(c.temp)} pe hai, fan speed ${c.fan}.`)
          : r('The AC is off right now.', 'AC abhi band hai.') };
      }
      if (it.topic === 'fuel') {
        return { state: s, reply: r(`Fuel is at ${s.fuel}%, about ${s.range} km of range.`, `Petrol ${s.fuel}% hai, lagbhag ${s.range} km chal jayegi.`) };
      }
      if (it.topic === 'music') {
        const t = currentTrack(s.media);
        return { state: s, reply: s.media.playing
          ? r(`Now playing ${t.title} by ${t.artist}.`, `Abhi ${t.title} chal raha hai.`)
          : r('Nothing is playing right now.', 'Abhi koi gaana nahi chal raha.') };
      }
      if (it.topic === 'speed') {
        const v = Math.round(env.speed);
        return { state: s, reply: v === 0 ? r('We are standing still.', 'Gaadi abhi ruki hui hai.')
          : r(`We are doing ${v} km/h.`, `Abhi ${v} km/h ki speed hai.`) };
      }
      if (it.topic === 'tyres') {
        const [fl, fr, rl, rr] = s.tyres;
        return { state: { ...s, cluster: 'tyres' }, reply: r(
          `Tyre pressures: front ${fl} and ${fr}, rear ${rl} and ${rr} psi. All normal.`,
          `Tyre pressure: aage ${fl} aur ${fr}, peeche ${rl} aur ${rr} psi. Sab theek hai.`) };
      }
      const time = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      return { state: s, reply: r(`It's ${time}.`, `Abhi ${time} ho rahe hain.`) };
    }
    case 'greet':
      return { state: s, reply: r('Hello! Ask me for the AC, music, lights, navigation or calls.', 'Namaste! Boliye, kya karun? AC, music, lights, navigation, sab kuch.') };
    case 'help':
      return { state: s, reply: r(
        'Try: "set AC to 22", "I\'m feeling hot", "play romantic songs", "ambient light red", "take me home" or "open the sunroof".',
        'Boliye: "AC 22 pe karo", "garmi lag rahi hai", "romantic gaane chalao", "light laal kar do", "ghar le chalo" ya "sunroof kholo".') };
    case 'thanks':
      return { state: s, reply: r('Anytime!', 'Koi baat nahi!') };
  }
}

const NEEDS_POWER = new Set<Intent['type']>([
  'climate.setTemp', 'climate.adjustTemp', 'climate.power', 'climate.fan', 'climate.auto', 'climate.recirc', 'climate.defrost',
  'media.play', 'media.skip', 'media.volume', 'ambient.color', 'ambient.power', 'ambient.brightness', 'ambient.mode', 'ambient.hue',
  'mood', 'nav.start', 'phone.call', 'screen', 'seat.vent', 'cluster.view',
]);


export function formatReplyLang(rep: Reply, lang: Lang): string {
  if (rep[lang]) return rep[lang]!;
  if (lang === 'hi') return rep.hi;
  if (lang === 'en') return rep.en;

  const en = rep.en || '';

  if (lang === 'ta') {
    if (/Setting the temperature to/i.test(en)) return en.replace(/Setting the temperature to ([\d.]+°C)\.?/i, 'AC temperature $1-ku set pannitten.');
    if (/Temperature (?:lowered|raised|adjusted) to/i.test(en)) return en.replace(/Temperature (?:lowered|raised|adjusted) to ([\d.]+°C)\.?/i, 'Temperature $1-ku change pannitten.');
    if (/Cooling the cabin down to/i.test(en)) return en.replace(/Cooling the cabin down to ([\d.]+°C)\.?/i, 'Veyil kammi panren. Temperature $1 pannitten.');
    if (/Warming the cabin up to/i.test(en)) return en.replace(/Warming the cabin up to ([\d.]+°C)\.?/i, 'Kulir kammi panren. Temperature $1 pannitten.');
    if (/AC is on/i.test(en) || /Climate on/i.test(en)) return 'AC on pannitten.';
    if (/AC turned off/i.test(en) || /Climate off/i.test(en)) return 'AC off pannitten.';
    if (/Fan speed (\d+)/i.test(en)) return en.replace(/Fan speed (\d+)\.?/i, 'Fan speed $1-ku set pannitten.');
    if (/Music paused/i.test(en)) return 'Music pause pannitten.';
    if (/Playing/i.test(en)) return en.replace(/Playing (.+)\.?/i, 'Paatu play aaguthu: $1.');
    if (/Next track/i.test(en)) return en.replace(/Next track:? (.+)\.?/i, 'Next track $1 play aaguthu.');
    if (/Previous track/i.test(en)) return 'Previous track play aaguthu.';
    if (/Muted/i.test(en)) return 'Volume mute pannitten.';
    if (/Volume (\d+)/i.test(en)) return en.replace(/Volume (\d+)\.?/i, 'Volume $1-ku set pannitten.');
    if (/Sunroof/i.test(en)) return /Open/i.test(en) ? 'Sunroof open pannitten.' : 'Sunroof close pannitten.';
    if (/Window/i.test(en) || /windshield/i.test(en)) return /Roll|Open/i.test(en) ? 'Window open pannitten.' : 'Window close pannitten.';
    if (/Engine started/i.test(en)) return 'Engine start aayiduchu.';
    if (/Engine off/i.test(en) || /switched off/i.test(en)) return 'Engine off pannitten.';
    if (/Hello/i.test(en) || /Namaste/i.test(en)) return 'Vanakkam! Sollunga, AC, music, navigation eathavathu seiyyanuma?';
    if (/Anytime/i.test(en)) return 'Paravaille!';
    return rep.hi || rep.en;
  }

  if (lang === 'bn') {
    if (/Setting the temperature to/i.test(en)) return en.replace(/Setting the temperature to ([\d.]+°C)\.?/i, 'AC temperature $1-e set kore dilam.');
    if (/Temperature (?:lowered|raised|adjusted) to/i.test(en)) return en.replace(/Temperature (?:lowered|raised|adjusted) to ([\d.]+°C)\.?/i, 'Temperature $1 kore dilam.');
    if (/Cooling the cabin down to/i.test(en)) return en.replace(/Cooling the cabin down to ([\d.]+°C)\.?/i, 'Gorom kam korchhi. Temperature $1 kore dilam.');
    if (/Warming the cabin up to/i.test(en)) return en.replace(/Warming the cabin up to ([\d.]+°C)\.?/i, 'Thanda kam korchhi. Temperature $1 kore dilam.');
    if (/AC is on/i.test(en) || /Climate on/i.test(en)) return 'AC chalu kore dilam.';
    if (/AC turned off/i.test(en) || /Climate off/i.test(en)) return 'AC bondho kore dilam.';
    if (/Fan speed (\d+)/i.test(en)) return en.replace(/Fan speed (\d+)\.?/i, 'Fan speed $1 kore dilam.');
    if (/Music paused/i.test(en)) return 'Gaan bondho kore dilam.';
    if (/Playing/i.test(en)) return en.replace(/Playing (.+)\.?/i, 'Gaan chalu kore dilam: $1.');
    if (/Next track/i.test(en)) return en.replace(/Next track:? (.+)\.?/i, 'Next track $1 chalu korlam.');
    if (/Previous track/i.test(en)) return 'Aager track chalu korlam.';
    if (/Muted/i.test(en)) return 'Awaaz mute kore dilam.';
    if (/Volume (\d+)/i.test(en)) return en.replace(/Volume (\d+)\.?/i, 'Volume $1 kore dilam.');
    if (/Sunroof/i.test(en)) return /Open/i.test(en) ? 'Sunroof khule dilam.' : 'Sunroof bondho kore dilam.';
    if (/Window/i.test(en) || /windshield/i.test(en)) return /Roll|Open/i.test(en) ? 'Janla khule dilam.' : 'Janla bondho kore dilam.';
    if (/Engine started/i.test(en)) return 'Engine start hoye gechhe.';
    if (/Engine off/i.test(en) || /switched off/i.test(en)) return 'Engine bondho kore dilam.';
    if (/Hello/i.test(en) || /Namaste/i.test(en)) return 'Nomoshkar! Bolun, ki korte hobe? AC, gaan, navigation shob kichhu.';
    if (/Anytime/i.test(en)) return 'Shagotom!';
    return rep.hi || rep.en;
  }

  return rep.en;
}

export function runIntents(state: CarState, intents: Intent[], lang: Lang, env: Env = { speed: 0 }) {
  let s = state;
  const replies: Reply[] = [];
  for (const it of intents) {
    // Electronics need power: wake the car into ACC rather than ignoring the request.
    const turningSomethingOff = (it.type === 'climate.power' || it.type === 'ambient.power') && !it.on;
    if (s.ignition === 'off' && NEEDS_POWER.has(it.type) && !turningSomethingOff) {
      const wake = applyIntent(s, { type: 'ignition', mode: 'acc' });
      s = wake.state;
      replies.push(wake.reply);
    }
    const out = applyIntent(s, it, env);
    s = out.state;
    replies.push(out.reply);
  }
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const text = replies.length
    ? replies.map((rep) => cap(formatReplyLang(rep, lang))).join(' ')
    : lang === 'hi'
      ? 'Maaf kijiye, samajh nahi aaya. Boliye "AC 22 pe karo" ya "gaana chalao".'
      : lang === 'ta'
        ? "Mannikkanum, puriyala. 'AC 22-ku set pannu' illa 'paatu podu' nu sollunga."
        : lang === 'bn'
          ? "Dukkhito, bujhte parini. 'AC 22 koro' ba 'gaan chalu koro' bolun."
          : 'Sorry, I didn\'t catch that. Try "set AC to 22" or "play some music".';
  const toast = [...replies].reverse().find((rep) => rep.toast)?.toast;
  return { state: s, text, toast: toast as Omit<Toast, 'id'> | undefined, understood: replies.length > 0 };
}
