"""Training data for the cockpit command LLM: a driver's sentence -> JSON list of cockpit commands.

  python -m bhashadrive.training.command_llm_data      # writes data/command_llm/{train,val,test}.jsonl

The output format is the cockpit's own `Intent` union (frontend/src/types.ts), so whatever the model says
runs unchanged. Three sources, all SYNTHETIC text:
  1. the V2 NLU set (data/nlu_v2), mapped onto cockpit commands (climate, fan, media, volume, navigation;
     unsupported chit-chat -> []);
  2. hand-written phrasings for every cockpit command, direct and indirect ("ubal raha hoon"), with slots;
  3. multi-command sentences joined from (1)+(2) ("AC 22 kar do aur light neeli karo" -> two commands).
Splits are by phrasing, so `test` holds wordings the model never saw in training.
"""
from __future__ import annotations

import json
import random
import re
from pathlib import Path

from ..nlu.cockpit_commands import canonical, valid

ROOT = Path(__file__).resolve().parents[2]
NLU = ROOT / "data" / "nlu_v2"
OUT = ROOT / "data" / "command_llm"

# ---------------------------------------------------------------- slot values: (spoken form, value)
COLORS = {
    "blue": ["blue", "neela", "neeli", "nili", "navy blue", "dark blue", "नीली"],
    "red": ["red", "laal", "lal", "maroon", "लाल"],
    "green": ["green", "hara", "hari", "emerald", "हरी"],
    "purple": ["purple", "violet", "baingani", "jamuni", "lavender"],
    "pink": ["pink", "gulabi", "gulaabi", "magenta", "rose", "गुलाबी"],
    "orange": ["orange", "narangi", "kesariya", "bhagwa", "saffron"],
    "white": ["white", "safed", "safaid", "सफेद"],
    "yellow": ["yellow", "peela", "peeli", "basanti"],
    "cyan": ["cyan", "sky blue", "aasmani", "firozi", "turquoise", "teal"],
    "gold": ["gold", "golden", "sunehri", "sunehra", "warm white"],
}
SLOTS: dict[str, list[tuple[str, object]]] = {
    "color": [(s, k) for k, v in COLORS.items() for s in v],
    "temp": [(f"{n}", n) for n in range(16, 31)] + [(f"{n} degree", n) for n in range(17, 29)]
    + [("bees", 20), ("ikkis", 21), ("bais", 22), ("teis", 23), ("chaubis", 24), ("pachees", 25), ("chhabbis", 26),
       ("twenty two", 22), ("twenty four", 24), ("eighteen", 18), ("twenty", 20), ("बाईस", 22)],
    "fanlvl": [(str(n), n) for n in range(1, 8)],
    "vol": [(str(n), n) for n in (0, 5, 8, 10, 12, 15, 18, 20, 25, 30)],
    "dest": [("ghar", "Home"), ("home", "Home"), ("office", "Office"), ("daftar", "Office"),
             ("India Gate", "India Gate"), ("Connaught Place", "Connaught Place"), ("airport", "Airport"),
             ("Juhu beach", "Juhu Beach"), ("Saket", "Saket"), ("Phoenix Mall", "Phoenix Mall"),
             ("railway station", "Railway Station"), ("Cyber Hub", "Cyber Hub"), ("Lajpat Nagar", "Lajpat Nagar"),
             ("Koramangala", "Koramangala"), ("Marine Drive", "Marine Drive"), ("nearest petrol pump", "Nearest Petrol Pump"),
             ("hospital", "Hospital"), ("Hauz Khas", "Hauz Khas")],
    "contact": [("Mummy", "Mummy"), ("Papa", "Papa"), ("mom", "Mom"), ("Rahul", "Rahul"), ("Priya", "Priya"),
                ("Neha", "Neha"), ("Amit", "Amit"), ("Didi", "Didi"), ("Bhaiya", "Bhaiya"), ("Sharma ji", "Sharma Ji"),
                ("boss", "Boss"), ("Ankit", "Ankit"), ("Pooja", "Pooja")],
    "speed": [(str(n), n) for n in range(40, 130, 10)],
    "freq": [(f, float(f)) for f in ("91.1", "93.5", "94.3", "98.3", "100.1", "104.8", "106.4")],
    "hue": [(str(n), n - 1) for n in (3, 8, 12, 20, 33, 41, 50, 64)],
    "seatlvl": [("1", 1), ("2", 2), ("3", 3)],
}
GENRES = {"romantic": "romantic|pyaar wale|love|romance", "party": "party|dance|naach|dj|bhangra",
          "devotional": "bhajan|bhakti|devotional|aarti|bhagwan wale", "retro": "purane|old|retro|evergreen|kishore kumar",
          "lofi": "lofi|lo-fi|chill|calm|soft"}

# ---------------------------------------------------------------- hand-written phrasings
# (phrasings, commands). "{slot}" in a phrasing is filled from SLOTS and the same value lands in the command.
# Indirect phrasings teach meaning, not keywords.
A = [
    (["AC {temp} pe kar do", "temperature {temp} kar do", "set the cabin to {temp} degrees", "{temp} degree pe AC chalao",
      "make it {temp} inside", "tapman {temp} rakho", "AC ko {temp} pe set karo", "climate {temp} karo yaar",
      "mujhe {temp} degree chahiye", "keep the temperature at {temp}", "andar {temp} degree kar do"],
     [{"type": "climate.setTemp", "value": "{temp}"}]),
    (["ubal raha hoon yaar", "andar oven jaisa lag raha hai", "bahut ummas hai", "pasina aa raha hai", "it's boiling in here",
      "I'm sweating", "garmi se haalat kharab hai", "it's way too hot in the car", "gala sookh raha hai garmi se",
      "car bhatti ban gayi hai", "itni garmi kyun hai andar"],
     [{"type": "climate.adjustTemp", "delta": -2, "feeling": "hot"}]),
    (["thand se kaanp raha hoon", "haath jam rahe hain", "it's freezing in here", "bahut sardi lag rahi hai",
      "I'm shivering", "andar fridge jaisa hai", "it's too cold", "mujhe thand lag rahi hai"],
     [{"type": "climate.adjustTemp", "delta": 2, "feeling": "cold"}]),
    (["thoda thanda karo", "cool it down a little", "temperature thoda kam karo", "ek degree kam karo",
      "make it slightly cooler", "thodi aur thandak chahiye"], [{"type": "climate.adjustTemp", "delta": -1}]),
    (["thoda garam karo", "warm it up a bit", "temperature thoda badhao", "ek degree badhao", "make it slightly warmer"],
     [{"type": "climate.adjustTemp", "delta": 1}]),
    (["AC chalu karo", "turn on the AC", "AC on kar do", "climate on karo", "cooling start karo", "AC laga do",
      "switch the air conditioning on"], [{"type": "climate.power", "on": True}]),
    (["AC band karo", "turn off the AC", "AC bandh kar do", "cooling rok do", "switch off the climate",
      "AC ki zaroorat nahi ab"], [{"type": "climate.power", "on": False}]),
    (["fan speed {fanlvl} karo", "blower {fanlvl} pe rakho", "set the fan to {fanlvl}", "pankha {fanlvl} pe kar do",
      "hawa level {fanlvl}"], [{"type": "climate.fan", "value": "{fanlvl}"}]),
    (["hawa tez karo", "fan badhao", "blow more air", "hawa kam aa rahi hai", "increase the blower", "pankha tez kar do",
      "zyada hawa chahiye"], [{"type": "climate.fan", "delta": 1}]),
    (["hawa kam karo", "fan dheema karo", "too much air", "blower slow karo", "itni hawa mat do", "reduce the fan"],
     [{"type": "climate.fan", "delta": -1}]),
    (["auto climate on karo", "climate ko auto pe rakho", "AC automatic kar do", "set climate to auto"],
     [{"type": "climate.auto"}]),
    (["recirculation on karo", "bahar ki hawa band karo", "bahar se dhool aa rahi hai", "smell aa rahi hai bahar se",
      "close the outside air", "andar ki hawa ghumao", "pollution bahut hai bahar"], [{"type": "climate.recirc", "on": True}]),
    (["bahar ki hawa andar aane do", "fresh air chahiye", "recirculation band karo", "let outside air in",
      "taazi hawa aane do"], [{"type": "climate.recirc", "on": False}]),
    (["sheesha saaf karo", "windshield pe fog hai", "defrost on karo", "aage kuch dikh nahi raha bhaap se", "clear the fog",
      "demist the windscreen", "shishe pe dhundh jam gayi"], [{"type": "climate.defrost", "on": True}]),
    (["defrost band karo", "turn off the demister", "fog wala band kar do"], [{"type": "climate.defrost", "on": False}]),
    (["romantic gaane chalao", "kuch pyaar wale gaane sunao", "play some love songs", "romance wala music lagao",
      "date pe hain kuch romantic bajao"], [{"type": "media.play", "genre": "romantic", "radio": False}]),
    (["party songs chalao", "kuch dhamakedaar bajao", "play dance music", "dj wale gaane lagao", "naachne wala music"],
     [{"type": "media.play", "genre": "party", "radio": False}]),
    (["bhajan chalao", "kuch bhakti wale gaane", "play devotional songs", "aarti lagao", "subah ke bhajan sunao"],
     [{"type": "media.play", "genre": "devotional", "radio": False}]),
    (["purane gaane bajao", "kishore kumar wale gaane", "play some old classics", "retro music lagao",
      "evergreen songs chalao"], [{"type": "media.play", "genre": "retro", "radio": False}]),
    (["lofi chalao", "kuch chill music", "play something calm", "soft music lagao", "padhai wala lofi bajao"],
     [{"type": "media.play", "genre": "lofi", "radio": False}]),
    (["gaana chalao", "music on karo", "play some music", "kuch sunao", "resume the song", "gaana wapas chalu karo"],
     [{"type": "media.play", "radio": False}]),
    (["radio {freq} lagao", "tune to {freq} FM", "FM {freq} chalao", "play radio {freq}"],
     [{"type": "media.play", "radio": True, "freq": "{freq}"}]),
    (["music band karo", "gaana roko", "pause the music", "chup karao isko", "stop the song", "thodi der gaana rok do"],
     [{"type": "media.pause"}]),
    (["agla gaana", "next song", "yeh gaana pasand nahi", "skip this track", "doosra gaana lagao", "change the song"],
     [{"type": "media.skip", "dir": 1}]),
    (["pichla gaana", "previous song", "wo pehle wala gaana wapas lagao", "go back a track", "last song phir se"],
     [{"type": "media.skip", "dir": -1}]),
    (["volume {vol} kar do", "set volume to {vol}", "awaaz {vol} pe rakho", "volume level {vol}"],
     [{"type": "media.volume", "value": "{vol}"}]),
    (["awaaz badhao", "kuch sunai nahi de raha", "louder please", "volume upar karo", "turn it up", "thoda tez bajao"],
     [{"type": "media.volume", "delta": 4}]),
    (["awaaz kam karo", "bahut shor hai", "too loud", "volume neeche karo", "turn it down", "dheere bajao"],
     [{"type": "media.volume", "delta": -4}]),
    (["mute karo", "awaaz bilkul band", "silence please", "mute the audio"], [{"type": "media.volume", "mute": True}]),
    (["unmute karo", "awaaz wapas lao", "unmute the sound"], [{"type": "media.volume", "mute": False}]),
    (["light {color} kar do", "ambient light {color} karo", "make the lights {color}", "change the light colour to {color}",
      "mood lighting {color} chahiye", "{color} light chalao", "andar ka rang {color} kar do", "lights ko {color} bana do",
      "interior ko {color} glow do", "set ambient colour to {color}", "mujhe {color} roshni chahiye"],
     [{"type": "ambient.color", "color": "{color}"}]),
    (["ambient light on karo", "andar roshni karo", "turn on the mood lights", "light jalao", "glow on karo"],
     [{"type": "ambient.power", "on": True}]),
    (["ambient light band karo", "mood lights off", "light bujha do", "roshni band karo", "turn off the ambient lighting"],
     [{"type": "ambient.power", "on": False}]),
    (["light thodi tez karo", "make the lights brighter", "roshni badhao", "glow zyada karo"],
     [{"type": "ambient.brightness", "delta": 0.2}]),
    (["light dim karo", "lights bahut chamak rahi hain", "make the lights dimmer", "roshni kam karo", "aankh mein chubh rahi hai light"],
     [{"type": "ambient.brightness", "delta": -0.2}]),
    (["light breathing mode", "lights ko saans lene do", "pulsing lights chahiye", "light dhadakti hui karo"],
     [{"type": "ambient.mode", "mode": "breathe"}]),
    (["light ko music ke saath sync karo", "lights beat pe nachao", "sync the lights to the music"],
     [{"type": "ambient.mode", "mode": "music"}]),
    (["rainbow light chalao", "satrangi roshni", "disco lights on karo", "cycle through all colours"],
     [{"type": "ambient.mode", "mode": "rainbow"}]),
    (["light colour {hue} karo", "ambient shade {hue}", "set light colour number {hue}"],
     [{"type": "ambient.hue", "hue": "{hue}"}]),
    (["party mode on", "chalo party karte hain", "let's party", "mahaul party wala bana do"],
     [{"type": "mood", "mood": "party"}]),
    (["relax mode", "thoda sukoon chahiye", "I want to relax", "aaram wala mahaul banao"], [{"type": "mood", "mood": "relax"}]),
    (["romantic mood bana do", "andar ka mahaul romantic karo", "set a romantic mood", "date night mode"],
     [{"type": "mood", "mood": "romantic"}]),
    (["focus mode", "mujhe concentrate karna hai", "kaam pe dhyaan dena hai", "help me focus"],
     [{"type": "mood", "mood": "focus"}]),
    (["neend aa rahi hai", "I'm feeling sleepy", "jhapki aa rahi hai", "energy chahiye", "wake me up"],
     [{"type": "mood", "mood": "energy"}]),
    (["cozy mode", "garmahat wala mahaul", "make it cozy in here"], [{"type": "mood", "mood": "cozy"}]),
    (["wiper chalao", "wipers on karo", "turn on the wipers", "sheesha pochho"], [{"type": "wipers", "mode": "slow"}]),
    (["wiper tez karo", "wipers fast karo", "bahut tez baarish hai", "full speed wipers"], [{"type": "wipers", "mode": "fast"}]),
    (["wiper band karo", "baarish ruk gayi", "turn off the wipers", "wipers rok do"], [{"type": "wipers", "mode": "off"}]),
    (["baarish ho rahi hai", "it's raining", "boondein gir rahi hain", "pani gir raha hai sheeshe pe"],
     [{"type": "wipers", "mode": "slow", "rain": True}]),
    (["window kholo", "khidki khol do", "open my window", "thodi hawa aane do khidki se", "sheesha neeche karo"],
     [{"type": "window", "target": "driver", "open": 100}]),
    (["window band karo", "khidki band kar do", "close my window", "sheesha upar karo"],
     [{"type": "window", "target": "driver", "open": 0}]),
    (["window aadhi kholo", "khidki thodi si kholo", "open the window halfway", "window crack open karo"],
     [{"type": "window", "target": "driver", "open": 40}]),
    (["passenger window kholo", "bagal wali khidki kholo", "open the passenger window", "saath wali window neeche karo"],
     [{"type": "window", "target": "passenger", "open": 100}]),
    (["passenger window band karo", "bagal wali khidki band karo", "close the passenger window"],
     [{"type": "window", "target": "passenger", "open": 0}]),
    (["sab windows band karo", "saari khidkiyan band", "close all the windows", "dono sheeshe upar karo"],
     [{"type": "window", "target": "both", "open": 0}]),
    (["sab windows kholo", "saari khidkiyan khol do", "open all the windows", "dono sheeshe neeche karo"],
     [{"type": "window", "target": "both", "open": 100}]),
    (["sunroof kholo", "chhat khol do", "open the sunroof", "upar se aasmaan dikhao", "roof kholo"],
     [{"type": "sunroof", "open": True}]),
    (["sunroof band karo", "chhat band kar do", "close the sunroof", "upar se dhoop aa rahi hai"],
     [{"type": "sunroof", "open": False}]),
    (["seat thandi karo", "seat pe pasina aa raha hai", "cool my seat", "ventilated seat on karo", "peeth garam ho rahi hai"],
     [{"type": "seat.vent", "target": "driver", "delta": 1}]),
    (["passenger seat cooling {seatlvl} pe karo", "bagal wali seat thandi level {seatlvl}", "set passenger seat ventilation to {seatlvl}"],
     [{"type": "seat.vent", "target": "passenger", "level": "{seatlvl}"}]),
    (["seat cooling band karo", "seat ki hawa band", "turn off seat ventilation"],
     [{"type": "seat.vent", "target": "driver", "level": 0}]),
    (["{dest} le chalo", "navigate to {dest}", "{dest} ka rasta dikhao", "{dest} jaana hai", "take me to {dest}",
      "{dest} chalo", "mujhe {dest} pahunchna hai", "route to {dest}", "{dest} kaise jaayein"],
     [{"type": "nav.start", "destination": "{dest}"}]),
    (["navigation band karo", "rasta mat dikhao ab", "stop navigation", "cancel the route", "pahunch gaye, map band karo"],
     [{"type": "nav.stop"}]),
    (["{contact} ko call karo", "call {contact}", "{contact} se baat karao", "phone {contact}", "dial {contact}"],
     [{"type": "phone.call", "contact": "{contact}"}]),
    (["call kaat do", "phone rakh do", "end the call", "hang up", "baat khatam, call band karo"], [{"type": "phone.end"}]),
    (["sport mode on karo", "gaadi ko sporty bana do", "sport mode", "thoda power chahiye", "let's drive fast"],
     [{"type": "drive.mode", "mode": "sport"}]),
    (["eco mode", "petrol bachao", "mileage wala mode", "switch to eco"], [{"type": "drive.mode", "mode": "eco"}]),
    (["normal mode", "drive mode normal karo", "back to normal driving"], [{"type": "drive.mode", "mode": "normal"}]),
    (["headlight on karo", "bahut andhera hai", "turn on the headlights", "aage kuch nahi dikh raha andhere mein", "lights on karo bahar ki"],
     [{"type": "lights.head", "on": True}]),
    (["headlight band karo", "turn off the headlights", "ujaala ho gaya, headlight band"], [{"type": "lights.head", "on": False}]),
    (["hazard on karo", "parking lights jalao", "turn on the hazards", "emergency lights on", "gaadi kharab hai, hazard do"],
     [{"type": "lights.hazard", "on": True}]),
    (["hazard band karo", "turn off the hazards"], [{"type": "lights.hazard", "on": False}]),
    (["gaadi start karo", "engine chalu karo", "start the car", "chalo nikalte hain, start karo", "ignition on"],
     [{"type": "ignition", "mode": "on"}]),
    (["engine band karo", "gaadi band kar do", "turn off the engine", "switch off the car"], [{"type": "ignition", "mode": "acc"}]),
    (["gear D mein daalo", "drive mein daalo", "put it in drive", "aage chalne ke liye gear lagao"], [{"type": "gear", "gear": "D"}]),
    (["reverse gear lagao", "peeche lo gaadi", "put it in reverse", "back karna hai"], [{"type": "gear", "gear": "R"}]),
    (["park mein daalo", "gear P karo", "put it in park"], [{"type": "gear", "gear": "P"}]),
    (["neutral mein daalo", "gear N karo", "shift to neutral"], [{"type": "gear", "gear": "N"}]),
    (["left indicator do", "baayein mudna hai", "turn on the left blinker", "left signal do"], [{"type": "indicator", "dir": "left"}]),
    (["right indicator do", "daayein mudna hai", "right signal do", "turn on the right blinker"], [{"type": "indicator", "dir": "right"}]),
    (["indicator band karo", "blinker off", "signal band kar do"], [{"type": "indicator", "dir": "off"}]),
    (["andar ki light on karo", "dome light on", "reading light jalao", "kuch dhoondhna hai andar light karo"],
     [{"type": "lights.cabin", "on": True}]),
    (["andar ki light band karo", "dome light off", "reading light bujhao"], [{"type": "lights.cabin", "on": False}]),
    (["darwaze lock karo", "lock the doors", "gaadi lock kar do", "sab darwaze band aur lock"], [{"type": "doors.lock", "locked": True}]),
    (["unlock karo", "darwaze khol do", "unlock the doors", "lock hatao"], [{"type": "doors.lock", "locked": False}]),
    (["auto hold on karo", "enable auto hold", "brake hold on"], [{"type": "autohold", "on": True}]),
    (["lane assist on karo", "lane keeping chalu karo", "keep me in my lane"], [{"type": "adas.lka", "on": True}]),
    (["lane assist band karo", "turn off lane keeping"], [{"type": "adas.lka", "on": False}]),
    (["cruise {speed} pe set karo", "set cruise control to {speed}", "{speed} ki speed pe cruise lagao", "cruise at {speed}"],
     [{"type": "cruise", "on": True, "speed": "{speed}"}]),
    (["cruise band karo", "cancel cruise control", "cruise hatao"], [{"type": "cruise", "on": False}]),
    (["climate screen dikhao", "show the climate page", "AC wali screen kholo"], [{"type": "screen", "page": "climate"}]),
    (["map dikhao", "navigation screen kholo", "show the map"], [{"type": "screen", "page": "nav"}]),
    (["trip meter dikhao", "kitna chale aaj", "show trip details"], [{"type": "cluster.view", "view": "trip"}]),
    (["petrol kitna hai", "tank mein kitna bacha hai", "how much fuel is left", "kitni door chal sakte hain"],
     [{"type": "query", "topic": "fuel"}]),
    (["time kya hua hai", "kitne baje hain", "what time is it", "abhi time kya hai"], [{"type": "query", "topic": "time"}]),
    (["tyre pressure kitna hai", "tyres theek hain kya", "check tyre pressure"], [{"type": "query", "topic": "tyres"}]),
    (["andar temperature kitna hai", "AC kitne pe hai", "what's the cabin temperature"], [{"type": "query", "topic": "temp"}]),
    (["kaunsa gaana chal raha hai", "what song is this", "yeh kiska gaana hai"], [{"type": "query", "topic": "music"}]),
    (["kitni speed pe hain", "how fast are we going", "speed kya hai abhi"], [{"type": "query", "topic": "speed"}]),
    (["namaste Verna", "hello", "hi there", "suprabhat Verna", "kaise ho"], [{"type": "greet"}]),
    (["tum kya kar sakti ho", "what can you do", "help karo", "mujhe batao kya kya kar sakti ho"], [{"type": "help"}]),
    (["thank you", "shukriya", "thanks Verna", "bahut badhiya, dhanyavaad"], [{"type": "thanks"}]),
    (["rev karo", "engine ki awaaz sunao", "vroom vroom", "rev the engine"], [{"type": "rev"}]),
    # Out of scope: no command at all. Near-misses (car features this car's assistant does not control) matter
    # most: without them the model maps "traction control" to a gear or "autopilot" to auto hold.
    (["boot kholo", "dikki khol do", "seat aage karo", "seat peeche karo", "mirror adjust karo", "side mirror band karo",
      "turn off traction control", "traction control band karo", "autopilot pe daal do", "self driving on karo",
      "parking camera dikhao", "bonnet kholo", "child lock lagao", "steering garam karo", "fuel cap kholo",
      "tyre change karo", "horn bajao zor se", "ESP off karo", "massage seat chalao", "boot ka darwaza band karo"], []),
    (["aaj ki news sunao", "tell me the latest news", "aaj mausam kaisa hai", "what's the weather today", "will it rain tomorrow",
      "aaj cricket match kaun jeeta", "stock market kaisa hai", "what's the capital of France", "mera horoscope batao",
      "dollar ka rate kya hai", "who is the prime minister", "London mein kitne baje hain", "ek joke sunao",
      "ek kahani sunao", "tum kaun ho", "what is the meaning of life"], []),
    (["pizza order karo", "khana order karna hai", "flight book karo", "email bhejo", "whatsapp pe message bhejo",
      "alarm laga do subah 6 baje", "kal ka meeting reminder set karo", "cab book karo", "movie ticket book karo",
      "bijli ka bill bharo", "Amazon se order karo", "photo khicho"], []),
    # Vague: something should change but nothing says what. The answer is no command, so the car asks.
    (["thoda up kar do", "isko kam karo", "kuch karo yaar", "ac ka kuch karo", "isko badal do", "change that",
      "can you fix the setting", "thoda adjust kar do", "wo wala chalao", "zara dekhna", "badal do", "isko up karo"], []),
]

_MAGNITUDE_SMALL = re.compile(r"\b(thoda|thodi|thode|little|bit|slightly|halka|zara|ek degree)\b", re.I)
_MAGNITUDE_LARGE = re.compile(r"\b(bahut|zyada|jyada|a lot|lot|much|full|max|ekdum|bilkul)\b", re.I)
STEP = {"temp": (1, 2, 3), "fan": (1, 1, 3), "volume": (2, 4, 8)}
# Cockpit abilities the V2 NLU calls "unsupported": its rows naming them must not teach the model to refuse.
_COCKPIT_WORDS = re.compile(r"\b(window|khidki|door|darwaz|lock|call|phone|light|wiper|sunroof|seat|gear|indicator|"
                            r"headlight|hazard|cruise|mode|start|engine|horn|signal|blinker|lane|defrost|fog|map|screen)"
                            r"|खिड़की|खिडकी|विंडो|दरवाज|लॉक|कॉल|फ़ोन|फोन|लाइट|रोशनी|वाइपर|सनरूफ|सीट|गियर|इंडिकेटर|हेडलाइट|"
                            r"हैज़र्ड|क्रूज़|मोड|स्टार्ट|इंजन|हॉर्न", re.I)


def _step(kind: str, text: str) -> int:
    small, normal, large = STEP[kind]
    return small if _MAGNITUDE_SMALL.search(text) else large if _MAGNITUDE_LARGE.search(text) else normal


def from_nlu_row(r: dict) -> list[dict] | None:
    """A V2 NLU row as cockpit commands; None drops the row (dialog turns, unsupported cockpit abilities)."""
    it, p, text = r["intent"], r["parameters"], r["text"]
    if it in ("dialog_confirm", "dialog_cancel"):
        return None  # answered by the backend dialog, never sent to the LLM
    if r["negated"] or it == "ambiguous":
        return []
    if it == "unsupported":
        return None if _COCKPIT_WORDS.search(text) else []
    implicit = r["speech_act"] == "implicit_request"
    if it in ("climate_temperature_up", "climate_temperature_down"):
        sign = 1 if it.endswith("up") else -1
        cmd = {"type": "climate.adjustTemp", "delta": sign * (2 if implicit else _step("temp", text))}
        if implicit:
            cmd["feeling"] = "cold" if sign > 0 else "hot"
        return [cmd]
    if it == "climate_temperature_set":
        # Out of range ("40 degree"): no command; the backend's policy explains the limit.
        cmd = {"type": "climate.setTemp", "value": p["target_temperature_celsius"]}
        return [cmd] if valid(cmd) else []
    if it in ("climate_fan_speed_up", "climate_fan_speed_down"):
        return [{"type": "climate.fan", "delta": (1 if it.endswith("up") else -1) * _step("fan", text)}]
    if it in ("climate_on", "climate_off"):
        return [{"type": "climate.power", "on": it == "climate_on"}]
    if it in ("volume_up", "volume_down"):
        return [{"type": "media.volume", "delta": (1 if it == "volume_up" else -1) * _step("volume", text)}]
    if it == "media_play":
        genre = next((g for g, pat in GENRES.items() if re.search(rf"\b({pat})", text, re.I)), None)
        return [{"type": "media.play", **({"genre": genre} if genre else {}), "radio": False}]
    if it == "media_pause":
        return [{"type": "media.pause"}]
    if it in ("media_next", "media_previous"):
        return [{"type": "media.skip", "dir": 1 if it == "media_next" else -1}]
    if it == "navigation_destination_request":
        return [{"type": "nav.start", "destination": p["destination"].title()}] if p.get("destination") else []
    return None


def _fill(phrase: str, commands: list[dict], rng: random.Random) -> tuple[str, list[dict]]:
    values = {}
    for slot in re.findall(r"\{(\w+)\}", phrase):
        values[slot] = rng.choice(SLOTS[slot])
        phrase = phrase.replace("{" + slot + "}", values[slot][0], 1)

    def sub(v):
        if isinstance(v, str) and v.startswith("{") and v.endswith("}"):
            return values[v[1:-1]][1]
        return v
    return phrase, [{k: sub(v) for k, v in c.items()} for c in commands]


def _style(text: str, rng: random.Random) -> str:
    """Speech-recogniser look: random case, optional filler, optional trailing full stop."""
    if rng.random() < 0.25:
        text = rng.choice(["bhai ", "yaar ", "please ", "Verna ", "arre ", "hey "]) + text
    if rng.random() < 0.15:
        text += rng.choice([" please", " yaar", " jaldi", " na"])
    text = text.lower() if rng.random() < 0.4 else text[0].upper() + text[1:]
    return text + ("." if rng.random() < 0.3 else "")


def _lower_first(t: str) -> str:
    """Lower-case a capitalised first word for mid-sentence use, leaving acronyms ("AC") alone."""
    return t[0].lower() + t[1:] if len(t) > 1 and t[1].islower() else t


def build(seed: int = 7, fills: int = 6, val_frac: float = 0.1, test_frac: float = 0.15, multi: int = 3500) -> dict[str, list]:
    rng = random.Random(seed)
    out: dict[str, list] = {"train": [], "val": [], "test": []}
    # 1. Hand-written phrasings, split by phrasing so test wordings are unseen.
    for g, (phrases, commands) in enumerate(A):
        order = list(range(len(phrases)))
        rng.shuffle(order)
        n_test = max(1, round(len(phrases) * test_frac))
        n_val = max(1, round(len(phrases) * val_frac)) if len(phrases) >= 6 else 0
        for rank, i in enumerate(order):
            split = "test" if rank < n_test else "val" if rank < n_test + n_val else "train"
            for _ in range(fills if "{" in phrases[i] or not commands else max(2, fills // 2)):
                text, cmds = _fill(phrases[i], commands, rng)
                out[split].append({"text": _style(text, rng), "intents": cmds, "source": f"handwritten:{g}"})
    # 2. The V2 NLU set keeps its own (template-group) splits.
    for split, files in (("train", ["train"]), ("val", ["val"]), ("test", ["test", "heldout_unseen"])):
        for f in files:
            for line in (NLU / f"{f}.jsonl").read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                cmds = from_nlu_row(row)
                if cmds is not None:
                    out[split].append({"text": row["text"], "intents": cmds, "source": f"nlu_v2:{f}"})
    # 3. Multi-command sentences, joined within a split from single commands of different kinds.
    joins = [" aur ", " and ", ", ", " and then ", " phir ", " saath hi ", " also ", " aur saath mein "]
    for split, n in (("train", multi), ("val", multi // 10), ("test", multi // 6)):
        singles = [r for r in out[split] if len(r["intents"]) == 1]
        for _ in range(n):
            k = 3 if rng.random() < 0.25 else 2
            parts = rng.sample(singles, k)
            if len({p["intents"][0]["type"] for p in parts}) < k:
                continue
            texts = [p["text"].rstrip(".") for p in parts]
            text = texts[0] + "".join(rng.choice(joins) + _lower_first(t) for t in texts[1:])
            out[split].append({"text": text, "intents": [c for p in parts for c in p["intents"]], "source": "multi"})
    for split in out:
        rng.shuffle(out[split])
    return out


def main() -> int:
    data = build()
    OUT.mkdir(parents=True, exist_ok=True)
    for split, rows in data.items():
        bad = [r for r in rows for c in r["intents"] if not valid(c)]
        if bad:
            raise ValueError(f"{len(bad)} {split} rows break the command schema, e.g. {bad[0]}")
        for r in rows:
            r["intents"] = [canonical(c) for c in r["intents"]]
        with (OUT / f"{split}.jsonl").open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        multi = sum(len(r["intents"]) > 1 for r in rows)
        empty = sum(not r["intents"] for r in rows)
        print(f"{split}: {len(rows)} rows ({multi} multi-command, {empty} no-command)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
