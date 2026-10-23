// Rule-based understanding for English, Hindi (Devanagari) and romanised Hinglish.
// Runs fully offline. Swap `parseCommand` for an LLM call later; the Intent
// contract in types.ts stays the same.

import type { AmbientColor, AmbientMode, Genre, Intent, Lang, Mood, Page, ProfileId, Zone } from '../types';

import { getProfiles, type Profile } from '../lib/profiles';

type Domain = 'climate' | 'fan' | 'volume' | 'media' | 'ambient' | 'seat';

export interface NluContext {
  domain?: Domain;
  lastAdjust?: Intent;
}

export interface ParseResult {
  intents: Intent[];
  lang: Lang;
  context: NluContext;
  /** Clauses (of two or more words) that yielded no command, or only a default reading ("light" -> light on):
   *  the sentence was only partly understood. */
  unparsed: string[];
  /** Clauses the sentence was split into ("AC 22 kar do aur light neeli karo" -> 2). */
  clauses: number;
}

// ---------------------------------------------------------------- vocab
// Entries containing a space match as phrases; entries ending in '*' match as prefixes.

const W = {
  climate: ['ac', 'aircon', 'air conditioner', 'air conditioning', 'climate', 'temperature', 'temp', 'temprature', 'tapman', 'cooling', 'heater', 'heating', 'degree', 'degrees', 'एसी', 'तापमान', 'टेम्परेचर', 'क्लाइमेट', 'कूलिंग', 'डिग्री'],
  tempWord: ['temperature', 'temp', 'temprature', 'tapman', 'degree', 'degrees', 'तापमान', 'टेम्परेचर', 'डिग्री'],
  fan: ['fan', 'blower', 'pankha', 'pankhe', 'hawa', 'airflow', 'air flow', 'फैन', 'पंखा', 'हवा', 'ब्लोअर'],
  feelHot: ['garmi', 'garmee', 'sweating', 'pasina', 'paseena', 'ubal', 'गर्मी', 'गरमी', 'पसीना', 'उबल'],
  feelCold: ['thand', 'thandi lag', 'sardi', 'freezing', 'chilly', 'kaanp', 'ठंड', 'ठण्ड', 'सर्दी', 'ठंडी लग'],
  makeCool: ['thanda', 'thandaa', 'cool', 'cooler', 'colder', 'chill', 'ठंडा', 'ठंडक', 'thandak'],
  makeWarm: ['garam', 'garm', 'warmer', 'warm', 'heat', 'गरम', 'गर्म'],
  cold: ['cold'],
  causative: ['make', 'set', 'karo', 'kar', 'kardo', 'kar do', 'kijiye', 'karna', 'want', 'chahiye', 'करो', 'कर', 'कीजिए', 'blow', 'air'],
  feeling: ['lag', 'lagi', 'laga', 'lagra', 'lagraha', 'lagrahi', 'feel', 'feeling', 'its', 'im', 'i am', 'is', 'too', 'very', 'bahut', 'hai', 'लग', 'है'],
  on: ['on', 'start', 'chalu', 'chaalu', 'chalao', 'chala', 'chalaao', 'chalado', 'laga', 'lagao', 'jalao', 'jala', 'shuru', 'enable', 'activate', 'turn on', 'switch on', 'play', 'bajao', 'baja', 'चालू', 'चलाओ', 'चला', 'शुरू', 'लगाओ', 'जलाओ', 'बजाओ', 'ऑन', 'resume'],
  off: ['off', 'band', 'bandh', 'bnd', 'stop', 'roko', 'rok', 'ruko', 'bujhao', 'bujha', 'disable', 'deactivate', 'turn off', 'switch off', 'hatao', 'hata', 'बंद', 'रोको', 'बुझाओ', 'ऑफ', 'हटाओ', 'pause'],
  up: ['increase', 'up', 'raise', 'badh*', 'zyada', 'jyada', 'zada', 'tez', 'tej', 'louder', 'more', 'high', 'higher', 'upar', 'max', 'maximum', 'full', 'बढ़*', 'बढ*', 'ज़्यादा', 'ज्यादा', 'तेज़', 'तेज', 'ऊपर', 'brighter'],
  down: ['decrease', 'down', 'lower', 'reduce', 'kam', 'kum', 'ghata*', 'less', 'low', 'dheere', 'dheema', 'dheemi', 'slow', 'slower', 'quieter', 'soft', 'neeche', 'min', 'minimum', 'dim', 'कम', 'घटा*', 'धीमा', 'धीमी', 'धीरे', 'नीचे'],
  open: ['open', 'khol*', 'खोल*'],
  close: ['close', 'shut', 'band', 'bandh', 'बंद', 'chadha*'],
  small: ['thoda', 'thodi', 'thora', 'little', 'bit', 'slightly', 'zara', 'jara', 'थोड़ा', 'थोड़ी', 'थोडा', 'ज़रा'],
  big: ['bahut', 'bohot', 'bahot', 'very', 'much', 'kaafi', 'lot', 'बहुत', 'काफी', 'extremely'],
  media: ['music', 'song', 'songs', 'gaana', 'gana', 'gaane', 'gane', 'geet', 'sangeet', 'track', 'playlist', 'radio', 'fm', 'media', 'audio', 'गाना', 'गाने', 'संगीत', 'म्यूज़िक', 'म्यूजिक', 'रेडियो', 'गीत'],
  radio: ['radio', 'fm', 'रेडियो'],
  volume: ['volume', 'awaaz', 'awaz', 'aawaz', 'aawaaz', 'sound', 'आवाज़', 'आवाज', 'वॉल्यूम'],
  mute: ['mute', 'chup', 'silent', 'silence', 'म्यूट', 'चुप'],
  unmute: ['unmute', 'अनम्यूट'],
  next: ['next', 'agla', 'agle', 'skip', 'change', 'badlo', 'badal', 'doosra', 'dusra', 'अगला', 'बदलो', 'दूसरा'],
  prev: ['previous', 'prev', 'pichla', 'pichhla', 'pichle', 'last song', 'पिछला'],
  ambient: ['ambient', 'ambience', 'mood light', 'mood lighting', 'light', 'lights', 'lighting', 'roshni', 'raushni', 'led', 'leds', 'रोशनी', 'लाइट', 'लाइटें', 'एंबिएंट'],
  wiper: ['wiper', 'wipers', 'वाइपर'],
  rain: ['baarish', 'barish', 'rain', 'raining', 'बारिश', 'paani gir'],
  heavy: ['tez', 'tej', 'fast', 'heavy', 'zor', 'zyada', 'high', 'तेज़', 'तेज'],
  window: ['window', 'windows', 'khidki', 'khidkiyan', 'sheesha', 'sheese', 'sheeshe', 'glass', 'खिड़की', 'खिडकी', 'शीशा', 'शीशे', 'विंडो'],
  sunroof: ['sunroof', 'sun roof', 'moonroof', 'roof', 'सनरूफ'],
  freshAir: ['fresh air', 'taazi hawa', 'tazi hawa', 'taaza hawa', 'taza hawa', 'ताज़ी हवा', 'ताजी हवा'],
  seat: ['seat', 'seats', 'सीट', 'ventilation', 'ventilated'],
  navTrigger: ['navigate', 'navigation', 'take me', 'le chalo', 'le chal', 'chalo', 'jaana hai', 'jana hai', 'route', 'rasta', 'raasta', 'directions', 'drive to', 'go to', 'how to reach', 'ले चलो', 'चलो', 'जाना है', 'रास्ता', 'नेविगेट', 'nearest', 'paas'],
  callTrigger: ['call', 'phone', 'dial', 'ring', 'फोन', 'कॉल', 'baat karao'],
  hangup: ['kaat*', 'kato', 'cut', 'end', 'hang', 'rakh', 'disconnect', 'काट*', 'रख'],
  drive: ['sport', 'sports', 'eco', 'normal', 'comfort', 'स्पोर्ट', 'इको', 'नॉर्मल', 'drive mode', 'driving mode'],
  saveFuel: ['mileage', 'fuel bachao', 'petrol bachao', 'save fuel', 'economy'],
  race: ['race', 'racing', 'speed chahiye', 'tez chalana'],
  head: ['headlight', 'headlights', 'head light', 'head lights', 'हेडलाइट', 'high beam', 'dipper'],
  dark: ['andhera', 'andhere', 'अंधेरा'],
  hazard: ['hazard', 'hazards', 'emergency light', 'emergency lights', 'parking light', 'parking lights', 'हैज़र्ड', 'हैजर्ड'],
  night: ['night', 'raat', 'रात'],
  day: ['day', 'din', 'daylight', 'दिन'],
  viewWord: ['mode', 'view', 'scene', 'karo', 'kar', 'theme', 'मोड'],
  show: ['dikhao', 'dikha', 'show', 'screen', 'display', 'दिखाओ', 'दिखा'],
  question: ['kitna', 'kitne', 'kitni', 'what', 'whats', 'how much', 'kya hai', 'batao', 'tell me', 'konsa', 'kaunsa', 'kaun sa', 'which', 'कितना', 'कितने', 'कितनी', 'क्या है', 'बताओ', 'कौन सा'],
  fuel: ['fuel', 'petrol', 'diesel', 'tank', 'range', 'टंकी', 'पेट्रोल'],
  time: ['time', 'samay', 'baje', 'टाइम', 'समय', 'बजे'],
  greet: ['hello', 'hi', 'hey', 'hii', 'hey car', 'hey verna', 'hey gaadi', 'namaste', 'namaskar', 'नमस्ते', 'नमस्कार', 'good morning', 'good evening', 'good afternoon'],
  help: ['help', 'kya kar sakte', 'what can you do', 'madad', 'मदद', 'commands'],
  thanks: ['thanks', 'thank you', 'thank', 'shukriya', 'dhanyavaad', 'dhanyawad', 'धन्यवाद', 'शुक्रिया'],
  repeat: ['aur', 'more', 'again', 'phir se', 'fir se', 'ek baar aur', 'once more', 'और'],
  driver: ['driver', 'meri side', 'my side', 'mera', 'meri', 'my', 'ड्राइवर'],
  passenger: ['passenger', 'co-driver', 'codriver', 'saath wal*', 'bagal', 'left side', 'पैसेंजर'],
  both: ['dono', 'both', 'sab', 'saari', 'saare', 'sabhi', 'all', 'दोनों', 'सब', 'सारी'],
  auto: ['auto', 'automatic', 'ऑटो'],
  modeWord: ['mode', 'mood', 'vibe', 'maahol', 'mahaul', 'माहौल', 'मोड'],
  photo: ['photo', 'picture', 'real', 'image', 'फोटो'],
  cabinLight: ['cabin light', 'andar ki light', 'andar light', 'interior light', 'dome light', 'reading light', 'roof light', 'अंदर की लाइट'],
  engine: ['engine', 'ignition', 'इंजन'],
  acc: ['acc', 'accessory', 'accessories', 'electronics'],
  vehicle: ['gaadi', 'gadi', 'car', 'vehicle', 'गाड़ी', 'गाडी'],
  start: ['start', 'स्टार्ट'],
  gear: ['gear', 'गियर'],
  gearVerb: ['mein', 'daalo', 'dalo', 'daal', 'shift', 'put', 'lagao', 'में', 'डालो'],
  indicator: ['indicator', 'indicators', 'blinker', 'blinkers', 'turn signal', 'signal', 'इंडिकेटर'],
  left: ['left', 'baayein', 'baayen', 'bayen', 'baaye', 'baye', 'बाएं', 'बायां', 'बाएँ'],
  right: ['right', 'daayein', 'daayen', 'dayen', 'daaye', 'daye', 'दाएं', 'दायां', 'दाएँ'],
  turnWord: ['turn', 'mudna', 'mudo', 'mud', 'mudenge', 'lena', 'मुड़ना', 'मुड़'],
  door: ['door', 'doors', 'darwaza', 'darwaze', 'darwaaza', 'darwaaze', 'दरवाज़ा', 'दरवाजा', 'दरवाज़े', 'दरवाजे'],
  lock: ['lock', 'लॉक'],
  unlock: ['unlock', 'अनलॉक'],
  defrost: ['defrost', 'defog', 'demist', 'dhundh', 'dhund', 'fog', 'sheesha saaf', 'shisha saaf', 'glass saaf', 'धुंध'],
  recirc: ['recirculation', 'recirc', 'recirculate', 'pollution', 'dhool', 'dhul', 'dust', 'smell', 'badbu', 'smoke', 'dhuan', 'धूल', 'प्रदूषण'],
  autoHold: ['auto hold', 'autohold'],
  rev: ['rev', 'revv', 'vroom', 'accelerate', 'accelerator', 'race do', 'race karo', 'throttle', 'raftaar', 'रेव'],
  speed: ['speed', 'raftaar', 'raftar', 'how fast', 'kitni tez', 'स्पीड', 'रफ़्तार', 'रफ्तार'],
  cruise: ['cruise', 'cruise control', 'smart cruise', 'scc', 'क्रूज़', 'क्रूज'],
  lane: ['lane keep', 'lane keeping', 'lane assist', 'lane keeping assist', 'lka', 'lane', 'लेन'],
  tyre: ['tyre', 'tyres', 'tire', 'tires', 'tpms', 'tyre pressure', 'टायर'],
  trip: ['trip', 'trip meter', 'trip computer', 'odometer', 'odo', 'average', 'avg', 'ट्रिप'],
  cluster: ['cluster', 'meter', 'speedometer', 'instrument', 'मीटर'],
  colourWord: ['colour', 'color', 'rang', 'shade', 'रंग'],
} satisfies Record<string, string[]>;

/**
 * Colour names, mapped onto the ten preset ambient colours. Romanised Hindi has no fixed spelling, so each
 * word appears in the spellings speech recognition writes (neeli / nili / neele, gulabi / gulaabi). Multi-word
 * names ("sky blue") win over the single words inside them (see colorsIn).
 */
const COLORS: Record<AmbientColor, string[]> = {
  red: ['red', 'laal', 'lal', 'laali', 'lali', 'maroon', 'crimson', 'scarlet', 'cherry', 'wine', 'blood red',
    'लाल', 'मैरून'],
  blue: ['blue', 'neela', 'neeli', 'neele', 'nila', 'nili', 'nile', 'neelaa', 'neel', 'navy', 'navy blue',
    'dark blue', 'royal blue', 'indigo', 'नीला', 'नीली', 'नीले', 'नील'],
  green: ['green', 'hara', 'hari', 'hare', 'haraa', 'haree', 'lime', 'emerald', 'olive', 'dhani', 'dhaani',
    'हरा', 'हरी', 'हरे', 'धानी'],
  purple: ['purple', 'violet', 'lavender', 'lilac', 'mauve', 'baingani', 'baingni', 'bengani', 'bainganee',
    'jamuni', 'jamni', 'jaamuni', 'बैंगनी', 'जामुनी'],
  pink: ['pink', 'hot pink', 'gulabi', 'gulaabi', 'gulabee', 'gulaabee', 'magenta', 'fuchsia', 'rose',
    'rani pink', 'गुलाबी'],
  orange: ['orange', 'narangi', 'naarangi', 'narangee', 'santri', 'santra', 'kesari', 'kesariya', 'keshariya',
    'kesaria', 'bhagwa', 'saffron', 'amber', 'नारंगी', 'केसरिया', 'भगवा', 'संतरी'],
  white: ['white', 'cool white', 'safed', 'safaid', 'sufaid', 'shwet', 'सफ़ेद', 'सफेद', 'श्वेत'],
  yellow: ['yellow', 'peela', 'peeli', 'peele', 'pila', 'pili', 'peelaa', 'lemon', 'basanti', 'पीला',
    'पीली', 'पीले', 'बसंती'],
  cyan: ['cyan', 'teal', 'aqua', 'turquoise', 'sky blue', 'light blue', 'aasmani', 'asmani', 'aasmaani',
    'firozi', 'phirozi', 'feroza', 'आसमानी', 'फ़िरोज़ी', 'फिरोजी'],
  gold: ['gold', 'golden', 'sunehra', 'sunehri', 'sunehre', 'sunahra', 'sunahri', 'champagne', 'warm white',
    'सुनहरा', 'सुनहरी', 'सुनहरे'],
};

/** Ambient light effects. Generic words like "flow" only count next to a light or colour word. */
const AMB_MODES: Record<AmbientMode, string[]> = {
  dual: ['dual', 'dual tone', 'two tone', 'do rang', 'dono rang', 'two colour', 'two color', 'दो रंग'],
  breathe: ['breathe', 'breathing', 'saans', 'pulse', 'pulsing', 'dhadakti', 'सांस', 'साँस'],
  flow: ['flow', 'flowing', 'wave', 'waves', 'chase', 'chasing', 'behti', 'lehar', 'लहर'],
  music: ['music sync', 'sync', 'beat', 'beats', 'rhythm', 'music ke saath', 'gaane ke saath', 'sound reactive', 'react'],
  drive: ['drive mode', 'driving mode', 'drive linked', 'link to drive', 'drive'],
  rainbow: ['rainbow', 'satrangi', 'colorful', 'colourful', 'rangeen', 'cycle', 'disco', 'सतरंगी', 'इंद्रधनुष'],
  static: ['static', 'steady', 'fixed', 'sthir', 'still', 'स्थिर'],
};

const GENRES: Record<Genre, string[]> = {
  romantic: ['romantic', 'romance', 'love', 'pyaar', 'pyar', 'ishq', 'arijit', 'रोमांटिक', 'प्यार'],
  party: ['party', 'dance', 'upbeat', 'dhamaka', 'energetic', 'punjabi', 'bhangra', 'badshah', 'diljit', 'पार्टी', 'डांस'],
  lofi: ['lofi', 'lo-fi', 'chill', 'relaxing', 'calm', 'sukoon', 'sukun', 'shaant', 'शांत', 'सुकून'],
  devotional: ['bhajan', 'devotional', 'bhakti', 'aarti', 'mantra', 'भजन', 'भक्ति', 'आरती'],
  retro: ['retro', 'old', 'purane', 'purana', 'classic', 'kishore', 'rafi', 'lata', 'पुराने', 'पुराना'],
};

const MOODS: Record<Mood, string[]> = {
  party: ['party', 'पार्टी'],
  relax: ['relax', 'relaxing', 'aaram', 'araam', 'calm', 'chill', 'आराम'],
  romantic: ['romantic', 'date', 'रोमांटिक'],
  focus: ['focus', 'concentrate', 'study', 'work', 'फोकस'],
  energy: ['energy', 'energise', 'energize', 'josh', 'जोश'],
  cozy: ['cozy', 'cosy', 'candle', 'candlelight', 'diya'],
};
const TIRED = ['thak', 'thaka', 'thaki', 'tired', 'stress', 'stressed', 'थक', 'थका', 'थकी'];

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  ek: 1, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15, solah: 16, satrah: 17, satra: 17,
  atharah: 18, athara: 18, unnis: 19, unees: 19, bees: 20, bis: 20, ikkis: 21, ikkees: 21,
  bais: 22, baais: 22, baees: 22, teis: 23, teyis: 23, tees: 30, chaubis: 24, chaubees: 24,
  pachis: 25, pachees: 25, chhabbis: 26, chhabbees: 26, sattais: 27, sattaees: 27,
  atthais: 28, attaees: 28, untis: 29, unatees: 29,
  'एक': 1, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19, 'बीस': 20, 'इक्कीस': 21, 'बाईस': 22, 'तेईस': 23,
  'चौबीस': 24, 'पच्चीस': 25, 'छब्बीस': 26, 'सत्ताईस': 27, 'अट्ठाईस': 28, 'उनतीस': 29, 'तीस': 30,
};

// Romanised Hindi number words are spelled every which way by speech recognition ("pachchis", "pachchees",
// "pachis", "pachees" all mean 25): compare a skeleton with long vowels shortened and doubled letters merged.
const skeleton = (w: string) => w.replace(/chh/g, 'ch').replace(/ee/g, 'i').replace(/aa/g, 'a').replace(/oo/g, 'u')
  .replace(/(.)\1+/g, '$1').replace(/chch/g, 'ch');
const NUM_SKELETONS: Record<string, number> = Object.fromEntries(
  Object.entries(NUM_WORDS).filter(([w]) => /^[a-z]+$/.test(w)).map(([w, v]) => [skeleton(w), v]));
const numWord = (t: string | undefined): number | undefined =>
  t === undefined ? undefined : NUM_WORDS[t] ?? (/^[a-z]{3,}$/.test(t) ? NUM_SKELETONS[skeleton(t)] : undefined);

const HINDI_MARKERS = new Set([
  'karo', 'kar', 'kardo', 'hai', 'hain', 'ho', 'rahi', 'raha', 'lag', 'chalao', 'chala', 'bajao', 'band',
  'kam', 'badhao', 'zyada', 'jyada', 'thoda', 'thodi', 'aur', 'mujhe', 'mera', 'meri', 'ko', 'pe', 'par',
  'ke', 'ki', 'ka', 'se', 'chalo', 'garmi', 'thand', 'thanda', 'gaana', 'gaane', 'awaaz', 'bahut', 'yaar',
  'bhai', 'kya', 'kitna', 'kitne', 'nahi', 'mat', 'dena', 'dijiye', 'kijiye', 'karna', 'chahiye', 'lagao',
  'kholo', 'khol', 'roko', 'hatao', 'agla', 'pichla', 'laal', 'neela', 'ghar', 'daftar', 'jaana', 'dikhao',
  'wala', 'wali', 'abhi', 'zara', 'namaste', 'baarish', 'chalu', 'jalao', 'sardi', 'tez', 'dheere',
]);

const PLACES: [string[], string][] = [
  [['ghar', 'home', 'घर'], 'Home'],
  [['office', 'daftar', 'dafter', 'ऑफिस', 'दफ्तर'], 'Office'],
  [['airport', 'एयरपोर्ट'], 'Airport'],
  [['petrol', 'fuel station', 'petrol pump', 'पेट्रोल'], 'Nearest petrol pump'],
  [['hospital', 'अस्पताल'], 'Nearest hospital'],
  [['ev charger', 'charging', 'charger'], 'Nearest EV charger'],
];

/** Build profile-name lookup dynamically from the profile store. */
function getProfileNames(): Record<string, string[]> {
  const profiles = getProfiles();
  const names: Record<string, string[]> = {};
  for (const [id, p] of Object.entries(profiles) as [string, Profile][]) {
    if (id === 'default') continue; // default isn't switchable by name
    names[id] = [p.name.toLowerCase(), id];
  }
  return names;
}
const PROFILE_WORDS = ['profile', 'profiles', 'driver profile', 'user profile', 'प्रोफाइल', 'प्रोफ़ाइल'];
const I_AM = ['main', 'mai', 'i am', 'im', 'this is', 'मैं'];

const CONTACTS: [string[], string][] = [
  [['mummy', 'mumma', 'mom', 'mother', 'maa', 'मम्मी', 'माँ', 'मां'], 'Mummy'],
  [['papa', 'dad', 'daddy', 'father', 'पापा'], 'Papa'],
  [['bhaiya', 'bhai', 'brother', 'भैया'], 'Bhaiya'],
  [['didi', 'sister', 'दीदी'], 'Didi'],
];

const FILLER = new Set([
  'mujhe', 'muje', 'me', 'mein', 'please', 'plz', 'pls', 'to', 'the', 'ke', 'ka', 'ki', 'ko', 'par', 'pe',
  'tak', 'liye', 'for', 'a', 'an', 'towards', 'taraf', 'my', 'jaldi', 'abhi', 'zara', 'yaar', 'bhai',
  'karo', 'kar', 'kardo', 'do', 'de', 'dena', 'dijiye', 'kijiye', 'hai', 'hain', 'can', 'you', 'i', 'want',
  'need', 'lagao', 'milao', 'laga', 'now', 'जल्दी', 'मुझे', 'को', 'पर', 'के', 'की', 'का', 'करो', 'कर', 'दो',
  'है', 'से', 'se', 'wahan', 'jana', 'jaana', 'chalna',
]);

// ---------------------------------------------------------------- helpers

// Strip the nukta so "बढ़ाओ" and "बढाओ" (and their many Unicode spellings) compare equal.
const fold = (s: string) => s.normalize('NFD').replace(/\u093C/g, '').normalize('NFC');

function normalize(raw: string): string {
  return fold(raw)
    .toLowerCase()
    .replace(/^\s*(hey|hi|hello|ok|okay)\s+(hyundai|verna|car|gaadi)\b[\s,]*/, '')
    .replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)))
    .replace(/a\s*[./]\s*c\b\.?/g, 'ac')
    .replace(/[’'`"]/g, '')
    .replace(/(\d)\s*°\s*c?/g, '$1 degree ')
    .replace(/(\d+(?:\.\d+)?)(?=[a-zऀ-ॿ])/g, '$1 ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[?!।;:]+/g, ' ')
    .replace(/\s*,\s*/g, ' , ')
    .replace(/\s+/g, ' ')
    .trim();
}

class Clause {
  readonly text: string;
  readonly tokens: string[];
  constructor(text: string) {
    this.text = ` ${text.trim()} `;
    this.tokens = text.trim().split(' ').filter(Boolean);
  }
  has(list: readonly string[]): boolean {
    return list.some((w) => this.match(w));
  }
  match(raw: string): boolean {
    const w = fold(raw);
    if (w.endsWith('*')) {
      const stem = w.slice(0, -1);
      return this.tokens.some((t) => t.startsWith(stem));
    }
    return w.includes(' ') ? this.text.includes(` ${w} `) : this.tokens.includes(w);
  }
  find<K extends string>(map: Record<K, string[]>): K | undefined {
    return (Object.keys(map) as K[]).find((k) => this.has(map[k]));
  }
  number(min = 0, max = 200): number | undefined {
    // Speech recognition writes "twenty two" as "20 2": join a tens number and a following single digit.
    const spoken = this.text.replace(/\b([1-9]0) ([1-9])\b/g, (_, tens: string, unit: string) => String(+tens + +unit));
    const digits = spoken.match(/\d+(?:\.\d+)?/g);
    if (digits) {
      const n = digits.map(Number).find((v) => v >= min && v <= max);
      if (n !== undefined) return n;
    }
    for (let i = 0; i < this.tokens.length; i++) {
      let v = numWord(this.tokens[i]);
      if (v === undefined) continue;
      // "twenty two" / "twenty-two"
      const unit = numWord(this.tokens[i + 1]);
      if (v === 20 && unit !== undefined && unit < 10) v += unit;
      if (v >= min && v <= max) return v;
    }
    const hyphen = this.text.match(/twenty-(one|two|three|four|five|six|seven|eight|nine)/);
    if (hyphen) return 20 + NUM_WORDS[hyphen[1]];
    return undefined;
  }
  magnitude(): 'small' | 'big' | 'normal' {
    if (this.has(W.small)) return 'small';
    if (this.has(W.big)) return 'big';
    return 'normal';
  }
  zone(fallback: Zone = 'both'): Zone {
    if (this.has(W.passenger)) return 'passenger';
    if (this.has(W.both)) return 'both';
    if (this.has(W.driver)) return 'driver';
    return fallback;
  }
}

// Every colour name as tokens, longest first, so "sky blue" is claimed before "blue".
const COLOR_NAMES = (Object.keys(COLORS) as AmbientColor[])
  .flatMap((k) => COLORS[k].map((w) => ({ k, words: fold(w).split(' ') })))
  .sort((a, b) => b.words.length - a.words.length);

// Romanised colour stems whose endings speech recognition spells freely ("gulaabhi", "gulaabik",
// "gulaab bhi", "gulaabigaro"): a word starting with one names the colour.
const COLOR_STEMS: [string, AmbientColor][] = [
  ['gulaab', 'pink'], ['gulab', 'pink'], ['baingan', 'purple'], ['bengan', 'purple'], ['jaamun', 'purple'], ['jamun', 'purple'],
  ['naarang', 'orange'], ['narang', 'orange'], ['kesar', 'orange'], ['keshar', 'orange'], ['santr', 'orange'],
  ['suneh', 'gold'], ['sunah', 'gold'], ['aasman', 'cyan'], ['aasmaan', 'cyan'], ['asman', 'cyan'], ['firoz', 'cyan'],
  ['phiroz', 'cyan'], ['feroz', 'cyan'], ['basant', 'yellow'], ['safed', 'white'], ['safaid', 'white'], ['sufaid', 'white'],
];
// One-word colour names long enough for a one-letter slip ("neelli", "gren") to be safely the colour.
const FUZZY_COLORS = COLOR_NAMES.filter(({ words }) => words.length === 1 && words[0].length >= 5 && /^[a-z]+$/.test(words[0]));

function within1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * The colours a clause names, in the order they are spoken ("dual tone blue purple" -> blue, purple).
 * `loose` (the talk is about lights): also accept colour stems with any ending and one-letter slips,
 * which is how speech recognition spells Hindi colour names. Without it "gulaab jamun" would be a colour.
 */
function colorsIn(c: Clause, loose = false): AmbientColor[] {
  const taken = new Array<boolean>(c.tokens.length).fill(false);
  const found: { k: AmbientColor; at: number }[] = [];
  for (const { k, words } of COLOR_NAMES) {
    for (let i = 0; i + words.length <= c.tokens.length; i++) {
      if (words.every((w, j) => !taken[i + j] && c.tokens[i + j] === w)) {
        words.forEach((_, j) => { taken[i + j] = true; });
        found.push({ k, at: i });
      }
    }
  }
  if (loose) {
    c.tokens.forEach((t, i) => {
      if (taken[i] || t.length < 5) return;
      const k = COLOR_STEMS.find(([stem]) => t.startsWith(stem))?.[1]
        ?? FUZZY_COLORS.find(({ words }) => within1(t, words[0]))?.k;
      if (k) found.push({ k, at: i });
    });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.k);
}

const step = (c: Clause, small: number, normal: number, big: number) =>
  ({ small, normal, big })[c.magnitude()];

function titleCase(s: string) {
  return s.replace(/\b\p{L}/gu, (m) => m.toUpperCase());
}

function extractDestination(c: Clause): string | undefined {
  for (const [keys, label] of PLACES) if (c.has(keys)) return label;
  const trigger = new Set(W.navTrigger.flatMap((w) => w.split(' ')));
  const show = new Set(W.show);
  const words = c.tokens.filter((t) => !trigger.has(t) && !FILLER.has(t) && !show.has(t) && t !== ',');
  return words.length ? titleCase(words.join(' ')) : undefined;
}

function extractContact(c: Clause): string | undefined {
  for (const [keys, label] of CONTACTS) if (c.has(keys)) return label;
  const trigger = new Set([...W.callTrigger, 'karo', 'kar', 'lagao', 'milao', 'to', 'please', 'give', 'a']);
  const koAt = c.tokens.findIndex((t) => t === 'ko' || t === 'को');
  const pool = koAt > 0 ? c.tokens.slice(0, koAt) : c.tokens.slice(c.tokens.findIndex((t) => W.callTrigger.includes(t)) + 1);
  const words = pool.filter((t) => !trigger.has(t) && !FILLER.has(t));
  return words.length ? titleCase(words.join(' ')) : undefined;
}

function detectLang(text: string): Lang {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  const tokens = normalize(text).split(' ');
  return tokens.some((t) => HINDI_MARKERS.has(t)) ? 'hi' : 'en';
}

// ---------------------------------------------------------------- clause parser

// `weak`: a default reading ("light" -> light on, "degree" -> AC on) with no word that asked for it: the clause
// said something more specific the parser could not read ("isi ko pachchis degree"), so it is not understood.
function parseClause(c: Clause, ctx: NluContext): { intents: Intent[]; domain?: Domain; weak?: boolean } {
  const on = c.has(W.on);
  const off = c.has(W.off);
  const up = c.has(W.up);
  const down = c.has(W.down);
  const isQuestion = c.has(W.question) && !c.has(['karo', 'kar', 'kardo', 'करो', 'set']);

  // Questions about the car
  if (isQuestion) {
    if (c.has(W.fuel)) return { intents: [{ type: 'query', topic: 'fuel' }] };
    if (c.has(W.media)) return { intents: [{ type: 'query', topic: 'music' }] };
    if (c.has(W.climate)) return { intents: [{ type: 'query', topic: 'temp' }] };
    if (c.has(W.time)) return { intents: [{ type: 'query', topic: 'time' }] };
    if (c.has(W.speed) && !c.has(W.fan)) return { intents: [{ type: 'query', topic: 'speed' }] };
  }
  if (c.has(['how fast'])) return { intents: [{ type: 'query', topic: 'speed' }] };

  // Instrument cluster pages ("tyre pressure dikhao", "trip meter", "cluster next")
  if (c.has(W.tyre)) return { intents: [{ type: 'query', topic: 'tyres' }] };
  if (c.has(W.trip) && !c.has(W.navTrigger)) return { intents: [{ type: 'cluster.view', view: 'trip' }] };
  if (c.has(W.cluster) && !c.has(W.ambient)) {
    if (c.has(['adas', 'assist', 'lane'])) return { intents: [{ type: 'cluster.view', view: 'drive' }] };
    return { intents: [{ type: 'cluster.view', dir: c.has(W.prev) ? -1 : 1 }] };
  }

  // Mood presets
  const tired = c.has(TIRED);
  const mood = c.find(MOODS);
  if (tired || (mood && !c.has(W.media) && (c.has(W.modeWord) || (mood === 'party' && on)))) {
    return { intents: [{ type: 'mood', mood: tired ? 'relax' : mood! }] };
  }

  // Day / night view of the cabin
  if ((c.has(W.viewWord) || c.has(W.photo)) && !c.has(W.climate) && !c.has(W.drive)) {
    if (c.has(W.photo)) return { intents: [{ type: 'scene', scene: c.has(W.day) ? 'day' : 'night' }] };
    if (c.has(W.night) || c.has(['live', 'drawn'])) return { intents: [{ type: 'scene', scene: 'live' }] };
    if (c.has(W.day)) return { intents: [{ type: 'scene', scene: 'day' }] };
  }

  // Driver profile: "Priya ka profile lagao", "switch to Aarav's profile", "main Meera hoon", "profile badlo".
  // A name alone is not enough ("Priya ko call karo" is a call).
  if (!c.has(W.callTrigger)) {
    const pnames = getProfileNames();
    const who = (Object.keys(pnames) as ProfileId[]).find((id) => c.has(pnames[id]));
    if (c.has(PROFILE_WORDS) || (who && c.has(I_AM))) return { intents: [who ? { type: 'profile', id: who } : { type: 'profile' }] };
  }

  // Phone
  if (c.has(W.callTrigger) && c.has(W.hangup)) return { intents: [{ type: 'phone.end' }] };
  if (c.has(['hang up', 'hangup'])) return { intents: [{ type: 'phone.end' }] };
  if (c.has(W.callTrigger) && !c.has(W.media) && !c.has(W.show)) {
    const contact = extractContact(c);
    if (contact) return { intents: [{ type: 'phone.call', contact }] };
  }

  // Navigation
  if (c.has(['navigation', 'navigate', 'route', 'नेविगेशन']) && off) return { intents: [{ type: 'nav.stop' }] };
  const place = PLACES.some(([keys]) => c.has(keys));
  const otherDomain = c.has([...W.media, ...W.climate, ...W.ambient, ...W.volume]);
  if ((c.has(W.navTrigger) && !otherDomain) || (place && c.has([...W.navTrigger, 'jana', 'jaana', 'chalna', 'jaana hai']))) {
    const dest = extractDestination(c);
    if (dest) return { intents: [{ type: 'nav.start', destination: dest }] };
  }

  // Jump to a screen ("climate dikhao", "show the map")
  if (c.has(W.show) && !on && !off && !up && !down) {
    const pages: [Page, string[]][] = [
      ['nav', ['map', 'navigation', 'नक्शा']],
      ['media', ['music', 'media', 'gaana', 'गाना']],
      ['climate', W.climate],
      ['phone', ['phone', 'contacts', 'फोन']],
      ['vehicle', ['car', 'vehicle', 'gaadi', 'gadi', 'settings', 'गाड़ी']],
      ['lights', W.ambient],
      ['home', ['home', 'होम']],
    ];
    const hit = pages.find(([, keys]) => c.has(keys));
    if (hit) return { intents: [{ type: 'screen', page: hit[0] }] };
  }

  const busy = c.has([...W.climate, ...W.media, ...W.ambient, ...W.volume, ...W.window]);

  // Revving ("rev karo", "accelerator dabao")
  if (c.has(W.rev) && !c.has(W.drive)) return { intents: [{ type: 'rev' }] };

  // Smart Cruise Control ("cruise 80 pe set karo", "cruise thoda badhao", "cruise band")
  if (c.has(W.cruise)) {
    if (off) return { intents: [{ type: 'cruise', on: false }] };
    const kmh = c.number(30, 180);
    if (kmh !== undefined) return { intents: [{ type: 'cruise', on: true, speed: kmh }] };
    if (up || down) return { intents: [{ type: 'cruise', on: true, delta: step(c, 5, 10, 20) * (down ? -1 : 1) }] };
    return { intents: [{ type: 'cruise', on: true }] };
  }
  if (c.has(W.lane) && !c.has(W.indicator)) return { intents: [{ type: 'adas.lka', on: !off }] };

  // Engine ("gaadi start karo", "engine band karo")
  // "engine band" keeps the electronics on (ACC); "gaadi band" switches the whole car off.
  if (c.has(W.acc) && !busy) return { intents: [{ type: 'ignition', mode: 'acc' }] };
  if (!c.has(W.show) && !busy && (c.has(W.engine) || (c.has(W.vehicle) && (c.has(W.start) || off || on)))) {
    const start = c.has(W.start) || !off;
    return { intents: [{ type: 'ignition', mode: start ? 'on' : c.has(W.engine) ? 'acc' : 'off' }] };
  }

  // Indicators ("left indicator do", "right turn lena hai")
  if (c.has(W.indicator) || ((c.has(W.left) || c.has(W.right)) && c.has(W.turnWord) && !c.has(['turn on', 'turn off']))) {
    if (off) return { intents: [{ type: 'indicator', dir: 'off' }] };
    if (c.has(W.both)) return { intents: [{ type: 'lights.hazard', on: true }] };
    return { intents: [{ type: 'indicator', dir: c.has(W.right) ? 'right' : 'left' }] };
  }

  // Gear selector
  if (!busy && !c.has(W.hazard)) {
    if (c.has(['reverse', 'रिवर्स'])) return { intents: [{ type: 'gear', gear: 'R' }] };
    if (c.has(['neutral', 'न्यूट्रल'])) return { intents: [{ type: 'gear', gear: 'N' }] };
    if (c.has(['drive', 'ड्राइव']) && !c.has(['mode', 'मोड']) && (c.has(W.gear) || c.has(W.gearVerb))) return { intents: [{ type: 'gear', gear: 'D' }] };
    if (c.has(['park', 'पार्क']) && !c.has(['parking'])) return { intents: [{ type: 'gear', gear: 'P' }] };
    if (c.has(W.gear)) {
      const letter = (['p', 'r', 'n', 'd'] as const).find((g) => c.tokens.includes(g));
      if (letter) return { intents: [{ type: 'gear', gear: letter.toUpperCase() as 'P' | 'R' | 'N' | 'D' }] };
    }
  }

  // Cabin (dome) light, before ambient lighting claims the word "light". The dome light has no colour,
  // so a colour ("andar ki light neeli karo") means the ambient lighting.
  const colors = colorsIn(c, c.has(W.ambient) || c.has(W.colourWord) || ctx.domain === 'ambient');
  if (c.has(W.cabinLight) && !colors.length) return { intents: [{ type: 'lights.cabin', on: !off }] };

  // Ambient light effects ("breathing red light", "light music ke saath", "dual tone blue purple")
  const effect = c.find(AMB_MODES);
  if (effect && !off && (c.has(W.ambient) || colors.length || c.has(['rainbow', 'satrangi', 'disco', 'dual tone', 'सतरंगी']))) {
    const out: Intent[] = [];
    if (effect === 'dual') {
      if (colors.length > 1) out.push({ type: 'ambient.color', color: colors[0] });
      out.push({ type: 'ambient.mode', mode: 'dual', color2: colors[colors.length - 1] });
    } else {
      if (colors[0]) out.push({ type: 'ambient.color', color: colors[0] });
      out.push({ type: 'ambient.mode', mode: effect });
    }
    return { intents: out, domain: 'ambient' };
  }

  // Door locks
  if (c.has(W.unlock)) return { intents: [{ type: 'doors.lock', locked: false }] };
  if (c.has(W.lock)) return { intents: [{ type: 'doors.lock', locked: !c.has(W.open) }] };
  if (c.has(W.door) && !c.has(W.window)) return { intents: [{ type: 'doors.lock', locked: !c.has(W.open) }] };

  // Defrost and recirculation (before windows/fan claim "sheesha"/"hawa")
  if (c.has(W.defrost)) return { intents: [{ type: 'climate.defrost', on: !off }] };
  if (c.has(W.recirc)) return { intents: [{ type: 'climate.recirc', on: !off }] };
  if (c.has(W.autoHold)) return { intents: [{ type: 'autohold', on: off ? false : on ? true : undefined }] };

  // Exterior lights
  if (c.has(W.hazard)) return { intents: [{ type: 'lights.hazard', on: !off }] };
  if (c.has(W.head)) return { intents: [{ type: 'lights.head', on: !off }] };
  if (c.has(W.dark) && !c.has(W.ambient)) return { intents: [{ type: 'lights.head', on: true }] };

  // Wipers
  if (c.has(W.wiper)) {
    if (off) return { intents: [{ type: 'wipers', mode: 'off' }] };
    return { intents: [{ type: 'wipers', mode: c.has(W.heavy) ? 'fast' : 'slow' }] };
  }
  if (c.has(W.rain)) {
    if (c.has(['ruk', 'rukh', 'ruki', 'stopped', 'band'])) return { intents: [{ type: 'wipers', mode: 'off', rain: true }] };
    return { intents: [{ type: 'wipers', mode: c.has(W.heavy) ? 'fast' : 'slow', rain: true }] };
  }

  // Sunroof
  if (c.has(W.freshAir)) return { intents: [{ type: 'sunroof', open: true, fresh: true }] };
  if (c.has(W.sunroof)) return { intents: [{ type: 'sunroof', open: !c.has(W.close) }] };

  // Windows ("down" opens a window, "up" closes it)
  if (c.has(W.window)) {
    const target: Zone = c.has(W.both) || c.has(['windows', 'khidkiyan', 'शीशे']) ? 'both' : c.zone('driver');
    const closing = c.has(W.close) || c.has(['up', 'upar', 'ऊपर']);
    const partial = c.has(W.small) || c.has(['half', 'aadha', 'aadhi', 'आधा']);
    return { intents: [{ type: 'window', target, open: closing ? 0 : partial ? 40 : 100 }] };
  }

  // Seat ventilation
  if (c.has(W.seat)) {
    const target = c.zone('driver');
    if (off) return { intents: [{ type: 'seat.vent', target, level: 0 }] };
    const n = c.number(0, 3);
    if (n !== undefined) return { intents: [{ type: 'seat.vent', target, level: n }] };
    if (down) return { intents: [{ type: 'seat.vent', target, delta: -1 }], domain: 'seat' };
    if (c.has(['max', 'full', 'tez', 'tej'])) return { intents: [{ type: 'seat.vent', target, level: 3 }] };
    if (on && !up) return { intents: [{ type: 'seat.vent', target, level: 2 }] };
    return { intents: [{ type: 'seat.vent', target, delta: 1 }], domain: 'seat' };
  }

  // Drive mode
  if (c.has(W.saveFuel)) return { intents: [{ type: 'drive.mode', mode: 'eco' }] };
  if (c.has(W.race)) return { intents: [{ type: 'drive.mode', mode: 'sport' }] };
  if (c.has(W.drive) && !c.has(W.media) && !c.has(W.climate)) {
    const mode = c.has(['sport', 'sports', 'स्पोर्ट']) ? 'sport' : c.has(['eco', 'इको']) ? 'eco' : 'normal';
    return { intents: [{ type: 'drive.mode', mode }] };
  }

  // Volume
  if (c.has(W.unmute)) return { intents: [{ type: 'media.volume', mute: false }], domain: 'volume' };
  if (c.has(W.mute)) return { intents: [{ type: 'media.volume', mute: true }], domain: 'volume' };
  if (c.has(W.volume)) {
    const n = c.number(0, 30);
    if (n !== undefined) return { intents: [{ type: 'media.volume', value: n }], domain: 'volume' };
    if (c.has(['full', 'max', 'maximum', 'poora', 'pura'])) return { intents: [{ type: 'media.volume', value: 30 }], domain: 'volume' };
    if (up || down) {
      const d = step(c, 2, 4, 8) * (down ? -1 : 1);
      return { intents: [{ type: 'media.volume', delta: d }], domain: 'volume' };
    }
    if (off) return { intents: [{ type: 'media.volume', mute: true }], domain: 'volume' };
    return { intents: [], domain: 'volume' };
  }

  // Media
  const genre = c.find(GENRES);
  const color = colors[0];
  const skipWord = (c.has(W.next) || c.has(W.prev)) && !color && !c.has(W.ambient);
  if (c.has(W.media) || (genre && on) || skipWord || c.has(['play', 'bajao', 'बजाओ', 'resume', 'pause'])) {
    if (skipWord && c.has(W.prev)) return { intents: [{ type: 'media.skip', dir: -1 }], domain: 'media' };
    if (skipWord) return { intents: [{ type: 'media.skip', dir: 1 }], domain: 'media' };
    if (off) return { intents: [{ type: 'media.pause' }], domain: 'media' };
    if (up || down) {
      const d = step(c, 2, 4, 8) * (down ? -1 : 1);
      return { intents: [{ type: 'media.volume', delta: d }], domain: 'volume' };
    }
    const radio = c.has(W.radio);
    const freq = radio ? c.number(87.5, 108) : undefined;
    return { intents: [{ type: 'media.play', genre, radio, freq }], domain: 'media', weak: !on && !genre && !radio };
  }

  // Ambient lighting
  const shade = c.has(W.colourWord) ? c.number(1, 64) : undefined;
  if (c.has(W.ambient) || color || shade !== undefined) {
    if (shade !== undefined && !color) return { intents: [{ type: 'ambient.hue', hue: shade - 1 }], domain: 'ambient' };
    if (color && !off) return { intents: [{ type: 'ambient.color', color }], domain: 'ambient' };
    if (off) return { intents: [{ type: 'ambient.power', on: false }], domain: 'ambient' };
    if (up || down) {
      return { intents: [{ type: 'ambient.brightness', delta: step(c, 0.1, 0.2, 0.4) * (down ? -1 : 1) }], domain: 'ambient' };
    }
    return { intents: [{ type: 'ambient.power', on: true }], domain: 'ambient', weak: !on };
  }

  // Fan / blower
  if (c.has(W.fan) && !c.has(W.tempWord)) {
    const n = c.number(1, 8);
    if (off && n === undefined) return { intents: [{ type: 'climate.fan', value: 0 }], domain: 'fan' };
    if (n !== undefined) return { intents: [{ type: 'climate.fan', value: n }], domain: 'fan' };
    if (c.has(['max', 'full', 'maximum'])) return { intents: [{ type: 'climate.fan', value: 8 }], domain: 'fan' };
    if (up || down) return { intents: [{ type: 'climate.fan', delta: step(c, 1, 1, 3) * (down ? -1 : 1) }], domain: 'fan' };
    return { intents: [], domain: 'fan' };
  }

  // Climate
  const hasClimate = c.has(W.climate);
  const temp = c.number(16, 32);
  const causative = c.has(W.causative);
  const hot = c.has(['hot']);
  const feelHot = c.has(W.feelHot) || (hot && !causative) || (c.has(W.makeWarm) && c.has(W.feeling) && !causative);
  const feelCold = c.has(W.feelCold) || (c.has(W.cold) && !causative);
  const makeCool = c.has(W.makeCool) || (c.has(W.cold) && causative);
  const makeWarm = (c.has(W.makeWarm) || (hot && causative)) && !feelHot;

  if (hasClimate || feelHot || feelCold || makeCool || makeWarm || (temp !== undefined && ctx.domain === 'climate')) {
    if (temp !== undefined) return { intents: [{ type: 'climate.setTemp', value: temp }], domain: 'climate' };
    if (c.has(W.auto)) return { intents: [{ type: 'climate.auto' }], domain: 'climate' };
    if (feelHot) return { intents: [{ type: 'climate.adjustTemp', delta: -step(c, 1, 2, 3), feeling: 'hot' }], domain: 'climate' };
    if (feelCold) return { intents: [{ type: 'climate.adjustTemp', delta: step(c, 1, 2, 3), feeling: 'cold' }], domain: 'climate' };
    if (makeCool) return { intents: [{ type: 'climate.adjustTemp', delta: -step(c, 1, 2, 3) }], domain: 'climate' };
    if (makeWarm) return { intents: [{ type: 'climate.adjustTemp', delta: step(c, 1, 2, 3) }], domain: 'climate' };
    if (off && !up) return { intents: [{ type: 'climate.power', on: false }], domain: 'climate' };
    if (up || down) {
      // Indian usage: "AC tez karo" / "AC badhao" means more cooling, not a higher number.
      const literal = c.has(W.tempWord);
      const raise = literal ? up : down;
      const d = step(c, 1, 2, 3) * (raise ? 1 : -1);
      return { intents: [{ type: 'climate.adjustTemp', delta: d }], domain: 'climate' };
    }
    if (on || hasClimate) return { intents: [{ type: 'climate.power', on: true }], domain: 'climate', weak: !on };
  }

  // "driver side 20": the AC is single-zone, so any side sets the cabin temperature
  const n = c.number(0, 32);
  if (n !== undefined && n >= 16 && n <= 30 && c.has(['side', 'driver', 'passenger', 'ड्राइवर', 'पैसेंजर'])) {
    return { intents: [{ type: 'climate.setTemp', value: n }], domain: 'climate' };
  }

  // Bare number or bare action: inherit the domain from earlier in the conversation
  if (ctx.domain && (n !== undefined || up || down || on || off)) {
    const inherited = parseClause(new Clause(`${domainWord(ctx.domain)} ${c.text.trim()}`), { ...ctx, domain: undefined });
    if (inherited.intents.length) return inherited;
  }
  // A lone "22" most likely means the cabin temperature
  if (n !== undefined && n >= 16 && n <= 30 && c.tokens.length <= 6) {
    return { intents: [{ type: 'climate.setTemp', value: n }], domain: 'climate' };
  }

  // "aur" / "thoda aur" / "again" repeats the last adjustment
  if (ctx.lastAdjust && c.has([...W.repeat, ...W.small]) && c.tokens.length <= 4) {
    return { intents: [ctx.lastAdjust] };
  }

  if (c.has(W.thanks)) return { intents: [{ type: 'thanks' }] };
  if (c.has(W.help)) return { intents: [{ type: 'help' }] };
  if (c.has(W.greet)) return { intents: [{ type: 'greet' }] };
  return { intents: [] };
}

function domainWord(d: Domain): string {
  return { climate: 'ac', fan: 'fan', volume: 'volume', media: 'music', ambient: 'ambient', seat: 'seat' }[d];
}

const ADJUSTABLE = new Set<Intent['type']>(['climate.adjustTemp', 'climate.fan', 'media.volume', 'ambient.brightness', 'seat.vent']);

export function parseCommand(raw: string, ctx: NluContext = {}): ParseResult {
  const lang = detectLang(raw);
  const text = normalize(raw);
  const parts = text
    .split(/\s(?:aur|and|or|और|then|phir|fir|also|plus|तथा|फिर|saath hi)\s|\s,\s/) // "or": ASR's spelling of "aur"
    .map((s) => s.trim())
    .filter(Boolean);

  // Re-attach a leading "aur" ("aur thanda karo") that the splitter would otherwise eat.
  if (/^(aur|और)\s/.test(text) && parts.length) parts[0] = parts[0].replace(/^(aur|और)\s/, '');

  const intents: Intent[] = [];
  const context: NluContext = { ...ctx };
  const unparsed: string[] = [];
  let clauses = 0; // of two or more words: a lone "bhai," or "listen," is not a clause
  for (const part of parts.length ? parts : [text]) {
    const clause = new Clause(part);
    if (clause.tokens.length > 1) clauses++;
    const { intents: found, domain, weak } = parseClause(clause, context);
    if ((!found.length || weak) && clause.tokens.length > 1) unparsed.push(part);
    if (domain) context.domain = domain;
    for (const it of found) {
      intents.push(it);
      if (ADJUSTABLE.has(it.type) && 'delta' in it && it.delta !== undefined) {
        context.lastAdjust = it;
      }
      const d = intentDomain(it);
      if (d) context.domain = d;
    }
  }
  return { intents: tidy(intents, text), lang, context, unparsed, clauses: Math.max(1, clauses) };
}

function tidy(intents: Intent[], text: string): Intent[] {
  if (!text) return [{ type: 'greet' }];
  let out = intents;
  // Any real command makes the greeting redundant.
  if (out.some((i) => !['greet', 'thanks'].includes(i.type))) out = out.filter((i) => i.type !== 'greet');
  // Adjusting the AC implies switching it on; don't announce both.
  if (out.some((i) => i.type === 'climate.setTemp' || i.type === 'climate.adjustTemp' || i.type === 'climate.fan')) {
    out = out.filter((i) => !(i.type === 'climate.power' && i.on));
  }
  return out;
}

function intentDomain(it: Intent): Domain | undefined {
  if (it.type.startsWith('climate.')) return it.type === 'climate.fan' ? 'fan' : 'climate';
  if (it.type === 'media.volume') return 'volume';
  if (it.type.startsWith('media.')) return 'media';
  if (it.type.startsWith('ambient.')) return 'ambient';
  if (it.type === 'seat.vent') return 'seat';
  return undefined;
}
