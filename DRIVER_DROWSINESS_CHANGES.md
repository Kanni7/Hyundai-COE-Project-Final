# Driver Drowsiness: Response System Changes

Tracks the upgrade of the existing Driver Monitor from **"detect and warn"** to **"detect and respond"**.
Each item says whether it was approved, and ticks off as it gets built.

---

## Before vs after

| | Before (what we had) | After (what we're building) |
|---|---|---|
| Detection | Camera says **alert / tired / drowsy** | Same detection, kept as is |
| When tired | Spoken hint "consider a break" (max every 2 min) | **Level 1:** cabin reacts: AC cooler, vents to driver, cool light, fresh air |
| Still tired | Nothing more | **Level 2:** MYRA asks "Thak gaye? Rukein?" and can navigate to a dhaba |
| When drowsy | Alarm + "Wake up!" every 6 s | **Level 3:** urgent alarm, "stop safely", hazard lights with animation and sound |
| Camera covered | Shows "Driver not visible" | Says "camera blocked"; never raises a drowsy alarm |
| What the audience sees | Only the camera panel | Every step shown on screen, plus a timeline of events |

---

## Approved: building these

| # | Change | Notes from review |
|---|---|---|
| 1 | **Level 1, cabin wake-up**: AC −1.5 °C, vents aim at driver, cool ambient light | Every action must be **visible on screen**: AC number going down, vents turning to the driver, light colour changing, plus a small caption saying what is happening |
| 2 | **Level 2, MYRA talks**: if tired persists for 1 min, MYRA asks to stop; "yes" starts navigation to a dhaba | **Demo timing:** the wait is really **10 s** but the screen shows it as **1 minute** (time runs ×6 in demo mode) |
| 3 | **Level 3, emergency**: urgent alarm, "stop safely", hazard lights | Needs a **good hazard animation** (both indicators flashing on cluster and car) and the **real hazard "tick-tock" sound** |
| 4 | **Camera blocked ≠ drowsy**: covered camera or hidden face gives "camera blocked", never a drowsy alarm | Shown on screen |
| 5 | **Jump straight to Level 3** in an emergency | Threshold changed from 2 s to **5 s** of closed eyes |
| 7 | **Time of day and trip length make the system more sensitive** (never trigger on their own) | How it works is explained below |
| 9 | **Fresh air at Level 1**: recirculation off | Shown on screen |
| 10 | **Restore the cabin** after the driver recovers (AC, fan, vents, lights back to before) | Driver's own manual changes during the episode are kept |
| 11 | **"No" = snooze**: MYRA won't ask again for 10 min; Level 3 can still fire | |
| 13 | **Presenter buttons**: trigger Level 1 / 2 / 3 instantly, plus context controls | So the demo doesn't need anyone to fake sleep |
| 14 | **Event timeline** in the Driver Monitor panel: what fired and why | e.g. `Level 1: eyes closed 18% → AC 20.5 °C, light cyan` |
| 16 | **One central controller** (internal) | Needed so one brain can drive the AC, lights, voice, map and hazards together. No visible change |

## Not doing (for now)

| # | Change | Why |
|---|---|---|
| 15 | MYRA speaks the Level 2 question in the driver's chosen language | Deferred. Level 2 speaks Hinglish for now |

## Not decided yet: default used until you say otherwise

| # | Change | Default while building |
|---|---|---|
| 6 | No made-up distance ("dhaba 4 km aage") | MYRA says **"Paas mein dhaba hai, rukein?"** with no invented number. A real distance needs a nearby-places lookup in the backend |
| 8 | Break reminder after 2 h of driving, even if the driver looks fine | **Not built.** Long trips still count as a context factor in #7 |
| 12 | Hazards only if the driver doesn't respond within ~5 s of the Level 3 alarm | **Hazards turn on immediately at Level 3**, as in the original spec |

---

## How #7 (context) works

Two context factors are tracked:

- **Night driving:** clock time between **00:00 and 05:00**, the hours when fatigue crashes peak.
- **Long trip:** **2 hours or more** of continuous driving since the engine started.

They set a **context risk** level, which only changes *how quickly* the system escalates:

| Context risk | When | Tired → Level 2 wait | Eyes closed → Level 3 |
|---|---|---|---|
| **Normal** | neither factor | 60 s | 5 s |
| **Elevated** | one factor | 40 s | 4 s |
| **High** | both factors | 20 s | 3 s |

Rules:
- Context **never** triggers any level by itself. A rested driver at 2 a.m. gets no warning.
- The current context is shown on screen as a chip, e.g. `Night drive · 2 h 10 m → faster escalation`.
- Demo time ×6 applies to the waits above as well (60 s → 10 s real).
- The presenter panel can **fake** the time of day and trip length, because the demo will run in daytime with a short trip.

---

## Build progress

All items are built. Type check, lint and all 54 frontend tests pass (15 new tests for the escalation logic).
**Still to do: a click-through in the browser.** The Chrome extension wasn't connected, so nothing has been checked by eye yet.

- [x] Central controller + escalation logic (#16, #5, #7, #11) with tests
- [x] Level 1 visuals: AC, vents, ambient, fresh air, caption (#1, #9)
- [x] Restore cabin after recovery (#10)
- [x] Level 2 voice question + yes/no + dhaba navigation (#2)
- [x] Level 3 alarm + hazard animation + hazard sound (#3)
- [x] Camera-blocked detection (#4)
- [x] Presenter buttons + context controls + demo time ×6 (#13)
- [x] Event timeline (#14)

---

## How the levels trigger (as built)

| Trigger | Result |
|---|---|
| Camera says **tired** (slow blinking, yawns, microsleeps) | **Level 1** |
| Still tired after the wait (1:00 normal; 10 s real in demo timing) | **Level 2**: MYRA asks |
| First sign of **drowsy** (e.g. eyes closed 2 s) | **Level 2** straight away, skipping the wait |
| Drowsy **again** after MYRA asked, or after the driver said "no" | **Level 3** |
| Eyes closed **5 s** (4 s / 3 s with context risk) | **Level 3** from any level |
| Eyes open again during Level 3 | Alarm stops, back to Level 2; hazards stay on |
| Alert for 0:30 (5 s real in demo timing) | Episode ends, cabin restored |
| Camera blocked / face not visible | Level held, all timers paused, never escalates |
| Engine off or Driver Monitor closed | Episode ends, cabin restored |

## What you see on screen

- **HUD card (top centre)**: level badge, reason, context chip, a live checklist of each action as it happens, and the "Tired for 0:42 / 1:00 → Level 2" countdown.
- **Rings on the cabin**: around the climate panel ("AC 20.5 °C ▼ · fresh air"), the vents ("Air → driver"), and the hazard switch ("Hazards ON").
- **The cabin itself**: the AC number ticks down in 0.5° steps, the vent tabs and air stream swing to the driver, the ambient light turns cyan, and the recirculation LED goes off.
- **Level 2**: the question shows in the HUD with **Haan / Nahi** buttons, and the mic opens for a spoken answer.
- **Level 3**: the whole screen pulses red; the HUD shows "STOP SAFELY" with a top-view car whose 4 indicators flash.
- **Hazards (any time they're on)**: both screen edges flash amber with the existing tick-tock relay sound, alongside the cluster arrows, switch glow and screen icon.
- **Driver Monitor panel**: new **Timeline** and **Presenter** tabs.

## Choices I made while building (please check)

| Choice | Why | Easy to change? |
|---|---|---|
| Level 1 also raises the **blower to at least 5/8** | So the air stream to the driver is clearly visible | Yes (`L1_FAN`) |
| Level 3 turns the ambient light **pulsing red** | Makes the emergency obvious on screen. It returns to cyan when Level 3 clears | Yes |
| Level 3 repeats **"Please stop the car safely…" every 8 s** | Replaces the old "Wake up!" every 6 s | Yes |
| "Haan" → navigation to **"Nearest dhaba"** | Uses the app's existing navigation, so the ETA on screen is the simulated estimate. A real nearby-dhaba lookup is #6(a) | Needs backend work |
| Hazards turn **off on recovery**, but only if the system turned them on | Clean reset for the demo. Hazards the driver switched on stay on | Yes |
| The system only runs **while the engine is on** | Real systems only act while driving. The Presenter tab has a "Start the engine" button | Yes |
| Demo timing is **on by default** | Built for the demo; untick it in the Presenter tab for real-time behaviour | Yes |
| The old "WAKE UP!" banner and the alarm inside the camera panel were **removed** | The new system owns all alarms, so they don't double up | No (would conflict) |

## Demo script (about 90 seconds)

1. Start the engine, then open **Driver Monitor** and go to the **Presenter** tab.
2. Optional: tick **Night drive** to show context ("Elevated → faster escalation").
3. Press **Tired**: Level 1 plays out (AC ticks down, vents swing, light turns cyan, fresh air), and the countdown shows "1:00".
4. After about 10 s, Level 2: MYRA asks "Thak gaye? …". Answer **Nahi** to show the snooze, or **Haan** to show navigation.
5. Press **Eyes closed**: about 5 s later, Level 3 (alarm, red pulse, hazards with sound and animation).
6. Press **Alert**: the alarm stops; after about 5 s the cabin is restored.
7. Press **Blocked** to show that a covered camera is not treated as drowsiness.
8. Open the **Timeline** tab to show the full record of what happened and why.

## Files

| File | What |
|---|---|
| `frontend/src/lib/fatigue.ts` | Escalation logic (levels, context, snooze, recovery). No UI, fully tested |
| `frontend/src/lib/fatigue.test.ts` | 15 tests for the above |
| `frontend/src/lib/useFatigueGuard.ts` | Carries out each level on the cabin, voice, nav and hazards; restore; presenter |
| `frontend/src/components/FatigueHud.tsx` | On-screen HUD, red emergency pulse, amber hazard edges |
| `frontend/src/components/FatiguePanel.tsx` | Timeline and Presenter tabs |
| `frontend/src/components/DriverMonitor.tsx` | Tabs, camera-blocked detection; old alarm removed |
| `frontend/src/lib/ventAim.ts`, `drawn/VentModule.tsx` | Vents can now be swung by the car (animated) |
| `frontend/src/components/Cockpit.tsx` | Spotlight rings on the cabin |
| `frontend/src/App.tsx` | Wiring; "Haan/Nahi" answers routed to the check-in |
