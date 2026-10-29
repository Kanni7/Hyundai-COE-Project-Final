import type { Intent, ProfileId } from '../types';

export interface CustomShortcut {
  trigger: string;
  triggerNorm: string;
  actions: Intent[];
  createdAt: number;
}

const STORAGE_PREFIX = 'myra_custom_shortcuts_';

export function normalizeTrigger(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getShortcuts(profileId: ProfileId = 'default'): CustomShortcut[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${profileId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveShortcut(profileId: ProfileId = 'default', trigger: string, actions: Intent[]): CustomShortcut {
  const norm = normalizeTrigger(trigger);
  const existing = getShortcuts(profileId).filter((s) => s.triggerNorm !== norm);
  const shortcut: CustomShortcut = {
    trigger: trigger.trim(),
    triggerNorm: norm,
    actions,
    createdAt: Date.now(),
  };
  existing.unshift(shortcut);
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${profileId}`, JSON.stringify(existing));
  } catch (e) {
    console.warn('Failed to save shortcut to localStorage:', e);
  }
  return shortcut;
}

export function deleteShortcut(profileId: ProfileId = 'default', trigger: string): boolean {
  const norm = normalizeTrigger(trigger);
  const existing = getShortcuts(profileId);
  const filtered = existing.filter((s) => s.triggerNorm !== norm && !norm.includes(s.triggerNorm));
  const changed = filtered.length !== existing.length;
  if (changed) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${profileId}`, JSON.stringify(filtered));
    } catch (e) {
      console.warn('Failed to update shortcuts in localStorage:', e);
    }
  }
  return changed;
}

export function matchShortcut(profileId: ProfileId = 'default', text: string): CustomShortcut | null {
  const norm = normalizeTrigger(text);
  if (!norm) return null;
  const shortcuts = getShortcuts(profileId);
  // 1. Exact match
  for (const s of shortcuts) {
    if (norm === s.triggerNorm) return s;
  }
  // 2. Phrase matching (e.g. "turn on chill mode", "chill mode please", "activate chill mode", "chill mode chala do", "start chill mode")
  for (const s of shortcuts) {
    if (!s.triggerNorm) continue;
    const escaped = s.triggerNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\b)${escaped}(\\b|$)`, 'i');
    if (re.test(norm)) return s;
  }
  return null;
}

export function parseTeachUtterance(text: string): { trigger: string; actionText: string } | null {
  const t = text.trim();
  // English: "Whenever I say chill mode, set the AC to 20 degrees and set the ambient light to blue"
  const m1 = t.match(/^\s*(?:when(?:ever)?|if)\s+i\s+say\s+["'“‘]?([^"',;:]+?)["'”’]?\s*(?:[,;:]\s*|\s+then\s+|\s+to\s+)(?:then\s+|please\s+|you\s+should\s+|just\s+)?(.+)$/i);
  if (m1) {
    return { trigger: m1[1].trim(), actionText: m1[2].trim() };
  }
  // Hinglish: "Jab bhi main chill mode bolun, AC 20 pe kar do aur light blue kar do"
  const m2 = t.match(/^\s*jab(?:\s+bhi)?\s+(?:main|mai|me|mein|hum)\s+["'“‘]?([^"',;:]+?)["'”’]?\s+(?:bolun|bolu|boloon|bolunga|bolungi|bolta hoon|bolti hoon|kahun|kahu|kahoon)\s*[,;:]?\s*(?:to|toh|tab)?\s*(.+)$/i);
  if (m2) {
    return { trigger: m2[1].trim(), actionText: m2[2].trim() };
  }
  // Direct command: "Teach shortcut chill mode: set AC to 20 and ambient light blue"
  const m3 = t.match(/^\s*(?:teach|save|create|set)\s+(?:shortcut|command|custom command)\s+["'“‘]?([^"',;:]+?)["'”’]?\s*(?:[:=]|to|\bas\b)\s*(.+)$/i);
  if (m3) {
    return { trigger: m3[1].trim(), actionText: m3[2].trim() };
  }
  return null;
}

export function describeActions(actions: Intent[], lang: 'en' | 'hi' = 'en'): string {
  const parts: string[] = [];
  for (const a of actions) {
    if (a.type === 'climate.setTemp') parts.push(lang === 'hi' ? `AC ${a.value}°C` : `AC to ${a.value}°C`);
    else if (a.type === 'climate.power') parts.push(a.on ? (lang === 'hi' ? 'AC chalu' : 'AC on') : (lang === 'hi' ? 'AC band' : 'AC off'));
    else if (a.type === 'ambient.color') parts.push(lang === 'hi' ? `ambient light ${a.color}` : `ambient light to ${a.color}`);
    else if (a.type === 'ambient.power') parts.push(a.on ? (lang === 'hi' ? 'ambient light on' : 'ambient light on') : (lang === 'hi' ? 'ambient light off' : 'ambient light off'));
    else if (a.type === 'media.play') parts.push(a.genre ? (lang === 'hi' ? `${a.genre} music` : `${a.genre} music`) : (lang === 'hi' ? 'music play' : 'play music'));
    else if (a.type === 'media.pause') parts.push(lang === 'hi' ? 'music pause' : 'pause music');
    else if (a.type === 'sunroof') parts.push(a.open ? (lang === 'hi' ? 'sunroof kholna' : 'open sunroof') : (lang === 'hi' ? 'sunroof band' : 'close sunroof'));
    else if (a.type === 'drive.mode') parts.push(lang === 'hi' ? `${a.mode} mode` : `${a.mode} mode`);
    else if (a.type === 'wipers') parts.push(lang === 'hi' ? `wiper ${a.mode}` : `wipers ${a.mode}`);
    else if (a.type === 'window') parts.push(lang === 'hi' ? `window ${a.open}%` : `window ${a.open}%`);
    else parts.push(a.type);
  }
  return parts.join(lang === 'hi' ? ' aur ' : ' and ') || 'actions';
}
