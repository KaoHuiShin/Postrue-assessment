# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page web app ("演奏者智能照護系統" / Performer Intelligent Care System) for musicians (violin/cello) to record posture during playing and run standard movement diagnostics (uneven shoulders, forward head posture, arm raise). No build system, no package manager, no test suite — this is plain HTML/CSS/JS served as static files, with Firebase (Auth + Firestore) as the backend.

> **Naming note (updated):** The system was previously named "演奏者健康動作評估系統" / "Performer Health Assessment System", and the static assessment page was referred to as "靜態動作評估". These have been renamed to "演奏者智能照護系統" / "Performer Intelligent Care System" and "標準動作辨識" / "Standard Movement Recognition" respectively. **This document reflects the new naming, but the actual codebase still needs to be updated to match — see task below. This includes both user-facing UI strings AND code identifiers (function/variable/id names) that reference the old "static" terminology, since the codebase will be read in full for academic review and should be internally consistent rather than having UI text and code names diverge.**

## Running the app

There is no build/lint/test tooling. To develop, serve the directory with any static file server and open `login.html` (unauthenticated users are redirected here), e.g.:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000/login.html`. All dependencies (Firebase, Chart.js, Lucide Icons, MediaPipe Pose/Camera/Drawing Utils) are loaded from CDNs in the `<head>` of `index.html` / `login.html` — there is no `node_modules` and no npm scripts.

There are no automated tests. Verify changes by exercising the UI directly in a browser (see the `run` skill).

## File map

- `login.html` — standalone login/signup page (own copy of Firebase init, i18n, and theme CSS vars). Redirects to `index.html` on successful auth.
- `index.html` — the SPA shell: sidebar nav + 5 `<section>`s (dashboard, profile, playing assessment, standard movement recognition, history), all toggled via `switchSection()`. Almost all interactivity is wired through inline `onclick="..."` handlers calling functions defined in `app.js`.
- `app.js` — all application logic (~3300 lines), single file, numbered comment sections (see Architecture below).
- `styles.css` / `login.css` — theming via CSS custom properties defined in `:root` (`--bg-*`, `--text-*`, `--color-*`).

## Architecture

`app.js` is organized into numbered sections (search for `// N.` comments to jump around):

1. **i18n** (`APP_I18N` dict at top) — all UI strings live in a `{ zh: {...}, en: {...} }` object keyed by string id. `data-i18n` / `data-i18n-ph` attributes in the HTML are populated by `setLang()`. When adding UI text, add the key to *both* `zh` and `en` blocks and reference it via `data-i18n="key"` (or `tApp('key')` from JS) rather than hardcoding strings. **Pending task: update the system name and the standard movement recognition page name/labels in this dict to match the new naming (see note above).**
2. **Firebase init & auth guard** — `firebaseConfig` + `checkAuth()` (redirects to `login.html` if no user). Every page load awaits `checkAuth()` before rendering data.
3. **SPA routing** — `switchSection(sectionId)` toggles `.active` on `<section>` elements; no router/URL state.
4. **Profile management** — `currentProfile`, persisted to Firestore (`users/{uid}`) with `localStorage` (`musician_profile`) as a fallback/cache.
5. **Canvas posture simulator** — `drawPlayingSkeleton()` / `drawStaticSkeleton()` draw an animated fake skeleton on `<canvas>` as a stand-in visualization when no live camera feed is active.
6. **CVA (Cervical Vertebra Angle) detection module** — the real computer-vision path, built on MediaPipe Pose. This is a JS port of Python scripts (`fhp_monitor.py` + `process_fhp_data.py` + `visualize_fhp.py`, not present in this repo — see comments at `app.js:987`). Key pieces: `calcCVA()`, `calcShoulderTilt()`, `calcElbowAngle()`, `calcAllParams()`, `initCvaPose()`, `openCamera()` → `runCalibration()` → `toggleRecording()` → `closeCamera()`. Recording flow per stage (`relax`/`prepare`/`playing`) is: open webcam → calibrate baseline angle → record frames with live CVA delta overlay → stop.
7. **Capturing/mock data generation** — `captureState()` / `generateMockPoseData()`, kept only as the fallback path for the "載入模擬示範數據" (load sample data) button.
8. **Chart rendering** — Chart.js instances for the dashboard trend, playing-state radar/line charts, shoulder symmetry, and the per-frame CVA trend chart. Chart refs are module-level globals (`dashboardTrendChartRef`, `playingRadarChartRef`, etc.) that get destroyed/recreated on re-render.
9. **Standard movement recognition (formerly "static diagnosis" / 靜態動作評估)** — `selectDiag()`, `startStaticDiagnosis()`, `renderStaticDiagnosticResult()` for the three standard movement tests (uneven shoulders, forward head, arm raise). *Function/variable/id names currently use the old "static" naming (`startStaticDiagnosis`, `section-static`, `staticCanvas`, `renderStaticDiagnosticResult`, etc.). Per project decision, these should be renamed to match the new "standard movement" terminology (e.g. `startStandardMovementDiagnosis`, `section-standard-movement`, `standardMovementCanvas`) rather than left inconsistent with the UI text — see Pending rename task below. When renaming, grep for every call site (inline `onclick="..."` handlers in `index.html`, CSS selectors in `styles.css` targeting the old id/class names, and any references elsewhere in `app.js`) so nothing is left half-renamed.*
10. **Data persistence & history** — records are saved to Firestore under `users/{uid}/records/{id}` via `addRecordToFirestore()`/`deleteRecordFromFirestore()`, with `localStorage` (`musician_records`) as a fallback when Firestore is unavailable. `getHistoryFromStorage()` / `saveHistoryToStorage()` abstract over the two. History table supports search/filter, multi-select + comparison modal, and JSON import/export (`exportHistoryData()` / `importHistoryData()`).
11. **Detail view modal** and **dashboard stats/trend chart** round out the file.

### Data flow pattern

The consistent pattern throughout is: **Firestore is the source of truth when authenticated; `localStorage` is a fallback/offline cache.** Reads try Firestore first and catch into `localStorage`; writes go to both. When touching persistence code, preserve this dual-write/fallback-read behavior rather than assuming Firestore is always available.

### Styling

All colors/spacing come from CSS custom properties in `styles.css:4` (`:root`). Reuse existing `--bg-*`, `--text-*`, `--color-*`, and `--border-radius-*` variables instead of hardcoding new colors — `login.css` mirrors the same palette for the standalone login page.

## Pending rename task

The following renames were decided outside this repo and need to be applied to **both UI-facing strings and code identifiers** — the two should stay consistent, especially since the codebase will be read in full for academic review.

| Old (zh) | New (zh) | Old (en) | New (en) |
|---|---|---|---|
| 演奏者健康動作評估系統 | 演奏者智能照護系統 | Performer Health Assessment System | Performer Intelligent Care System |
| 靜態動作評估 | 標準動作辨識 | Static Assessment / static posture diagnostics | Standard Movement Recognition |

**UI strings** — search for every occurrence of the old strings across `index.html`, `login.html`, and `app.js` (including the `APP_I18N` dict's `zh` and `en` blocks, `<title>` tags, and any comments referencing the old name) — don't rely on renaming just the dictionary keys, since some old text may be hardcoded outside `data-i18n` attributes.

**Code identifiers** — rename every function, variable, DOM id, and CSS class/selector that currently uses "static" to mean this page (e.g. `startStaticDiagnosis` → `startStandardMovementDiagnosis`, `renderStaticDiagnosticResult` → `renderStandardMovementResult`, `section-static` → `section-standard-movement`, `staticCanvas` → `standardMovementCanvas`, `drawStaticSkeleton` → `drawStandardMovementSkeleton`). Before renaming, grep across all four files (`app.js`, `index.html`, `styles.css`, `login.css` if referenced) to find every call site and selector — inline `onclick="..."` handlers in the HTML and CSS id/class selectors are easy to miss and will silently break if left pointing at the old name. Do this as one atomic pass (not partial) so the codebase never sits in a half-renamed state, and manually test the standard movement recognition page afterward (camera open → calibration → recording → result render) since this is exactly the kind of rename that breaks silently if a single string reference is missed.
