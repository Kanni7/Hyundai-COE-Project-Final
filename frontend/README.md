# Verna Smart Cockpit

Hackathon prototype for the Hyundai Center of Excellence. It shows a Hyundai Verna interior that you control by talking to it in English, Hindi or Hinglish.

> "AC 20 pe kar do" · "Garmi lag rahi hai" · "Music band kar do" · "Light gulabi kar do" · "Ghar le chalo"

If a command needs power while the car is OFF (music, AC, navigation and so on), the car wakes into ACC first.

Everything runs locally in the browser. You need no backend, API key or internet connection.

The default **Live view** is a cockpit drawn entirely in code (SVG), traced from the night photo. Every switch, knob and lever in it works. The photo only shows through the glass, as the scenery outside. Two photo views are kept for comparison.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

Use Chrome or Edge for voice input, because they support the Web Speech API. Other browsers still accept typed commands.

## Using it

| Control | What it does |
| --- | --- |
| Mic button or <kbd>Space</kbd> | Push to talk. `EN` / `हिं` picks the speech recogniser language. |
| Text box or <kbd>/</kbd> | Type any command, in Hindi script or in Roman letters. |
| Suggestion chips | One-click sample commands. |
| **Demo** | Plays a scripted conversation, which is useful on stage. |
| **Screen** or <kbd>Z</kbd> (or double-click the display) | Moves the camera closer to the infotainment screen. |
| **View** (layers icon) | Cycles through Live view (drawn cockpit), Night photo and Day photo. |
| Speaker icon | Turns spoken replies on or off. |
| Settings → Wind suppression | Turns the server-side filter on/off, adjusts strength and maximum reduction, controls browser capture suppression/AGC, and runs a clean-vs-synthetic-wind ASR comparison. |
| Dashboard hotspots | Click the hazard button or the horn. Scroll on or click the climate temperatures. |

### Physical controls in the Live view

| Control | Where | What it does |
| --- | --- | --- |
| Steering wheel | Drag the rim | Steers (it springs back when released). Click the centre pad (with the Hyundai badge) for the horn. |
| Accelerator | Driver footwell, or hold <kbd>↑</kbd> / <kbd>W</kbd> | In P or N, hold to rev: the pedal travels, the tachometer needle climbs to the rev limiter and the engine note rises. Lift off at high revs for exhaust pops. In D or R the car drives: speed builds through a 7-speed automatic that shifts earlier in Eco and later in Sport. Needs the ignition in ON. |
| Brake | Driver footwell, or hold <kbd>↓</kbd> / <kbd>S</kbd> | Slows the car and cancels Smart Cruise. With Auto Hold on, braking to a stop holds the car until you press the accelerator. |
| Left spoke keys | Steering wheel | Play/pause, mute, volume, previous/next track. |
| Right spoke keys | Steering wheel | Voice assistant (starts the mic), phone, temperature up/down. The ◀ ▶ keys page through the cluster centre: driving assist, trip computer, tyre pressures. |
| Left stalk | Behind the wheel | Wipers: off, low, high. |
| Right stalk | Behind the wheel | Indicators: top half for right, bottom half for left. |
| ENGINE START STOP | Right of the wheel | Cycles the ignition **OFF → ACC → ON**. ACC powers the screen, music, lights and climate with the engine off; ON cranks and starts the engine. Hold the brake pedal while pressing to start the engine straight away. OFF darkens everything. |
| Climate panel | Below the vents | AUTO, A/C, front and rear defrost, recirculation, fan, OFF. Click or scroll the temperature and fan displays. |
| Hazard switch | Between the vents | Hazard lights (the switch and cluster arrows blink). |
| Gear lever | Centre console | Drag up or down through P-R-N-D, click to toggle P/D, or click a letter in the lit column. |
| Console button strip | Left of the gear lever | Drive mode, Auto Hold, parking sensors, door lock. |
| Seat ventilation | Right of the gear lever | Driver and passenger seat cooling: each press steps off, 1, 2, 3. |
| Door switches | Passenger armrest | Passenger window (the glass slides down), driver window, all windows, door lock. |
| Roof console | Under the mirror | Cabin light. |

### Instrument cluster

The 10.25-inch digital cluster behind the wheel is laid out so the steering-wheel hub and spokes never hide anything important.

- **Speedometer** (0-240 km/h) and **tachometer** (0-8,000 rpm, redline from 6,500), each with a needle, a lit sweep and a digital readout. The needles sweep to full scale when the ignition comes on.
- **Gear selector** with the gearbox's current ratio in D (for example `D 4`).
- **Drive mode theme:** Eco green, Normal blue, Sport red.
- **Fuel gauge**, plus a **coolant temperature** gauge that warms up after a start.
- **Top row:** the clock (`ACC` with the engine off). Only lamps that mean something right now are lit. On the left: headlights, parking brake (engine running in P) and low tyre pressure. On the right: Auto Hold (green while holding), Lane Keeping Assist (green while steering, above 60 km/h) and Smart Cruise.
- **Centre pages**, cycled with the right spoke ◀ ▶ keys or by voice:
  - Driving assist: the lane view (dashes move with the road) and, with Smart Cruise on, the car ahead with distance bars.
  - Trip computer: trip, average and instant economy, and the odometer.
  - Tyre pressures for all four wheels.
- **Blind View Monitor:** while you indicate with the engine running, a camera view of that side replaces the dial on the same side.
- **Smart Cruise Control:** say `cruise 80 pe set karo` in D. The car accelerates to the set speed and holds it. A green marker shows the set speed on the speedometer. Braking cancels it.

### Ambient lighting

Open the **Lights** page on the screen, or use your voice.

- **Colours:** 10 named colours, plus the Verna's 64-colour palette on the colour strip.
- **Effects:**

  | Effect | What it does |
  | --- | --- |
  | Static | Steady light. |
  | Breathe | Slow fade in and out. |
  | Flow | Light pulses that run along the pipes. |
  | Music sync | Pulses with the bass and changes colour on each beat. |
  | Drive mode | The colour follows the drive mode (Eco green, Sport red), and the light brightens with engine revs. |
  | Rainbow | Cycles through every colour. |
  | Dual tone | One colour on the dash, another on the doors. |

- **Moods** set the light, music and climate together: Party, Relax, Romantic, Focus, Energy and Cozy.
- **Welcome sweep:** turning the lights on draws them along the pipes.

## What the car responds to

| Area | Example commands |
| --- | --- |
| Climate | `AC 20 pe kar do`, `garmi lag rahi hai`, `thand lag rahi hai`, `AC tez karo`, `fan speed 5`, `AC band karo`, `एसी बाईस पर कर दो` (single-zone: one cabin temperature) |
| Music | `romantic gaane chalao`, `bhajan lagao`, `agla gaana`, `volume thoda badhao`, `mute`, `FM 98.3 lagao`, `music band kar do` |
| Ambient light | `light laal kar do`, `ambient purple`, `light dim karo`, `lights off`, `light colour 40` (64-colour palette) |
| Light effects | `breathing light`, `flowing orange light`, `light ko music ke saath sync karo`, `light drive mode ke saath`, `rainbow lights`, `dual tone blue purple`, `static light` |
| Moods | `party mode on`, `thak gaya hoon` (relax), `romantic mood`, `focus mode`, `energy mode`, `cozy mood` |
| Comfort | `seat thandi karo`, `sunroof kholo`, `taazi hawa chahiye`, `windows neeche karo` |
| Driving | `sport mode on karo`, `petrol bachao` (eco), `headlights on`, `hazard lights on`, `baarish ho rahi hai` (wipers) |
| Driver assistance | `cruise 80 pe set karo`, `cruise thoda badhao`, `cruise band karo`, `lane keep assist band karo` |
| Cluster | `trip meter dikhao`, `tyre pressure kitna hai?`, `cluster next` |
| Car controls | `gaadi start karo`, `engine band karo` (ACC), `gaadi band karo` (OFF), `acc mode`, `rev karo`, `gear D mein daalo`, `reverse lagao`, `park karo`, `left indicator do`, `right turn lena hai`, `darwaze lock karo`, `andar ki light on karo`, `sheesha saaf karo` (defrost), `bahar dhool hai` (recirculation), `auto hold on` |
| Views | `night mode` (live view), `day mode`, `photo view` |
| Navigation and phone | `ghar le chalo`, `take me to the airport`, `India Gate ka rasta dikhao`, `mummy ko call karo`, `call kaat do` |
| Questions | `AC kitne pe hai?`, `kitna petrol hai?`, `konsa gaana chal raha hai?`, `speed kitni hai?` |

The parser also handles these cases:

- **Compound commands:** `AC band karo aur music chalao` produces two intents.
- **Follow-ups:** after `garmi lag rahi hai`, saying `aur thoda` cools the cabin further.
- **Local usage:** `AC tez karo` means more cooling, not a higher temperature.

## How it works

```
speech (Web Speech API) ─┐
typed text ──────────────┴─▶ parseCommand()  ──▶ Intent[] ──▶ applyIntent() ──▶ CarState ──▶ cockpit visuals
                              src/nlu/parser.ts               src/state/car.ts                 + spoken reply
```

- **`src/nlu/parser.ts`** is the offline rule-based parser for English, Devanagari and romanised Hinglish. It covers spelling variants, Hindi number words, clause splitting and conversation context. To use an LLM or a hosted NLU service later, replace `parseCommand`. The `Intent` contract in `src/types.ts` stays the same.
- **`src/state/car.ts`** is the pure state machine. It applies each intent and writes a reply in both English and Hinglish.
- **`src/scenes.ts`** holds the per-view calibration. Every overlay is placed in the photo's own pixel coordinates. The drawn Live view reuses the night photo's coordinates, so the whole drawing shares one coordinate system. The stage fills the window width and zooms at most 1.12× further to fill the height. Any side crop is taken around the steering wheel, so the wheel keeps its place on screen in every window shape, and a short window gives up sky so the console stays above the voice dock.
- **Drawn cockpit** (`src/drawn/`): the static body (`CabinBase`) is drawn once. Each moving part (cluster, climate panel, vents, gear lever, wheel, door glass, switches) is its own small SVG, so animating one part never repaints the rest. Ambient light pipes are a separate layer recoloured through CSS. Breathe, Flow and Rainbow are CSS animations. Music sync and Drive mode are driven every frame by `lib/ambientFx.ts`. Add `?compare=split`, `?compare=overlay` or `?compare=photo` to the URL to lay the source photo over the drawing.
- **Shared visuals** (`src/components/`):
  - The infotainment UI is real HTML. A homography (`lib/homography.ts`) maps it onto the photographed screen, so it stays clickable.
  - In the photo views, the ambient lighting is an SVG filter. It finds the blue LED strips in the photo and relights them in any colour.
  - There are animated airflow, rain and wiper effects, plus overlays for the climate LCD, the instrument cluster, the hazard light and headlights.
- **`src/lib/audio.ts`** synthesises royalty-free music live with Web Audio, so no audio files are needed. It also plays the horn and UI chimes. The engine note is a cross-plane V8 model: each camshaft cycle is built from eight exhaust pulses in firing order 1-8-7-2-6-5-4-3, whose uneven bank pattern gives the V8 burble. It adds combustion jitter, a load filter that opens with throttle, deep exhaust resonances, intake roar, overrun pops and a starter crank.
- **`src/lib/engine.ts`** is a small engine and vehicle model. It covers throttle, inertia, the rev limiter and idle, plus a 7-speed automatic with kickdown, creep, Auto Hold, Smart Cruise, the odometer, trip and fuel use. It runs outside React. Every frame, it drives the cluster, the engine sound and the drive-linked ambient light.

## Images

- `public/images/verna-interior-dashboard.avif` is the Verna showroom interior (day view).
- `public/images/hyundai-logo.webp` is the badge on the steering wheel (trimmed from `hyundai logo.png`).
- `public/images/verna-night.webp` is the night-drive cabin (from `verna int.png`). It is the Night photo view, and the Live view uses it for the scenery outside the glass.

To use a different photo, add an entry to `src/scenes.ts` and calibrate it: the screen corners, vents, windshield outline and LED clip region, all in image pixels.
