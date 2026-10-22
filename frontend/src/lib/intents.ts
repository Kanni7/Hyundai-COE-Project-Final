import type { Intent } from '../types';

const STARTERS = ['AC 20 pe kar do', 'Garmi lag rahi hai', 'Romantic gaane chalao', 'Ghar le chalo'];
const ANSWERS = ['Haan', 'Nahi'];
// Natural next steps after a command in each area (keyed by the intent type's prefix).
const FOLLOW_UPS: Record<string, string[]> = {
  climate: ['Thoda aur thanda karo', 'Fan speed badhao', 'AC band kar do'],
  seat: ['Seat thandi karo', 'AC 22 pe kar do', 'Fan speed kam karo'],
  media: ['Agla gaana lagao', 'Volume thoda badhao', 'Music band kar do'],
  nav: ['Music chalao', 'Navigation band karo', 'Volume thoda kam karo'],
  ambient: ['Light neeli kar do', 'Light ko music ke saath sync karo', 'Light band karo'],
  mood: ['Light neeli kar do', 'Agla gaana lagao', 'Party mode on'],
  phone: ['Call kaat do', 'Music chalao'],
  gear: ['Sport mode on karo', 'Cruise 60 pe set karo', 'Right indicator do'],
  ignition: ['AC 20 pe kar do', 'Gear D mein daalo', 'Music chalao'],
};

/** A few chips that fit the moment: answers to a yes/no question, follow-ups to the last command, or starters. */
export function suggestionsFor(lastIntents: Intent[], awaitingAnswer: boolean): string[] {
  if (awaitingAnswer) return ANSWERS;
  const area = lastIntents[0]?.type.split('.')[0];
  return (area && FOLLOW_UPS[area === 'drive' || area === 'cruise' ? 'gear' : area]) || STARTERS;
}

export function describeIntent(i: Intent): string {
  const { type, ...rest } = i;
  const args = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}: ${v}`))
    .join(', ');
  return args ? `${type}(${args})` : type;
}
