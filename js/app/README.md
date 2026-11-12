# App layer

Vanilla ES modules in `js/app/`, no framework, no build. `index.html` loads `js/app/main.js` and
renders into `#app`. The engine (`js/engine/`, see its README) supplies sessions; the app stores and
runs them. Screens are rebuilt from scratch on every render.

## Module map
```
main.js     boot: loads data/library.json, opens storage, builds ctx, routes, wake lock. No exports.
storage.js  IndexedDB document + migrations
  defaultDoc(library) -> doc;  migrate(doc, library, migrations?, target?) -> doc
  openStorage(dbName, { onPending(n, err), onError(e) }) -> Promise<{ db, load(library), save(doc), flush(), pending(), close() }>
  readRaw(db), writeRaw(db, doc), deleteDatabase(dbName), requestPersistence(); consts SCHEMA_VERSION, DB_NAME, STORE, DOC_KEY, DEFAULT_LENGTH_MIN
flow.js     pure session operations; each returns a new session, input untouched
  clone(v); createSession({ library, doc, seed, now }) / rerollSession({ library, doc, scope, now }) / changeLength({ library, doc, lengthMin }) -> { session, violations }
  swapOptions({ library, doc, block, slot }) -> [{ movementId, item }]; swapMovement({ library, doc, block, slot, movementId, now }) -> { session, violations } (block letter, slot index; engine swapCandidates / swapSlot on the unstarted current; throws when started or for a non-candidate)
  isStale(library, doc); isStarted(session); activeBlockIndexes(session); prefill(session, bi, ii); currentEntry(session); startWorkout(session, now); finishWarmup(session); setDraft(session, draft)
  confirmRound(session, entry?, now); canUndo(session); undoRound(session); restRemainingSec(session, now); endRest(session); addRest(session, sec, now); setEffort(session, ii, effort)
  effortsComplete(session); finishEffort(session, now); finishFinisher(session, done, now); completeSession(session, now, endedEarly?); endEarly(session, now); confirmedRounds(session)
format.js   pure text formatting, no DOM or clock
  formatNumber, formatWeight, unitWord, formatValue(value, unit, perSide), formatTarget, formatLoad(load, opts?), formatPlan(target, load), confirmLabel(entry, item), chipText(round, unit)
  formatDate(iso), formatClock(sec), formatDuration(sec), effortLabel, formatLast(last, target), basisLine(recommendation, movement), flagLines(item, library, dayType), estimateText(session)
  comparisonText(cmp, dayType), roundLabel(round, rounds), dayLabel(dayType); consts EFFORT_LABELS, EFFORT_ORDER, EFFORT_SHORT, BASIS_TEXT, BASIS_FIRST_TIME_BODYWEIGHT
dom.js      h(tag, attrs, ...children) (attrs.data keys are camelCase and become data-kebab); append(el, children); button(label, action, data?, extra?)
stats.js    pure history statistics, no DOM or clock (`now` is passed in); const DAY_TYPES; weekStart(date) -> local Monday 00:00 Date
  weeklyCounts(sessions, now, weeks = 8) -> [{ week_start: ISO of local Monday 00:00, count }] oldest first, exactly `weeks`, zero weeks included, by completed_at
  volumeByDayType(sessions) -> { push, hinge, pull }: [{ date, session_id, volume_lb (sessionVolume) }] chronological
  movementHistory(sessions, movementId) -> [{ date, session_id, weight_lb_per_dumbbell (heaviest round, null for bodyweight), values, best_value, unit, per_side, effort, load }] one per session with a logged round
  movementsWithHistory(sessions, library) -> [{ movement_id, name, last_date }] most recent first, ties by name; an id not in the library uses the id as its name
charts.js   inline SVG charts, no library. Pure: linearScale(d0, d1, r0, r1), paddedRange(values), barGeometry(values, { goal }), lineGeometry(values), seriesText(items) (Oxford comma)
  DOM: barChart(items, opts), lineChart(items, opts); items [{ value, label, data, current? }], opts { ariaLabel, goal?, goalLabel?, data?, className? }
  viewBox 320 wide at width 100%, role="img" with the numbers in aria-label, colors only through .chart-* classes, font 13 units (about 12.7 px at 375 px), points r 4, no animation
backup.js   pure backup file operations, no DOM or clock: buildBackup(doc, now) -> { app: "dumbbell-app", kind: "backup", exported_at, schema_version, doc }
  backupFileName(now) -> "dumbbell-backup-YYYY-MM-DD.json" (local date); parseBackup(text, library) -> { ok: true, doc, summary: { sessions, first_date, last_date, exported_at } } | { ok: false, error }
  applyReplace(doc, backupDoc) -> backup document whole; applyMerge(doc, backupDoc) -> this doc plus backup sessions with new ids, sorted by completed_at; consts BACKUP_APP, BACKUP_KIND
screens/    each exports render(ctx) -> { main, bar }, plus optional actions, inputs, mounted, unmount
  today.js    finisherWeight(library, finisher), finisherCard(library, finisher, opts?), render, actions
  workout.js  render, mounted(ctx, root), unmount, actions
  demo.js     demoSheet(library, movementId) -> DOM node | null; form cues sheet, no workout state (reusable)
  swap.js     swapSheet(ctx, { block, slot }) -> DOM node | null; Today's swap picker (same muscle group, valid swaps only), demo sheet styles
  summary.js  durationSec(session), finisherStatus(session), render, actions, inputs; shared with History: stat(label, value, data?),
              sessionFacts(session, history) -> { vol, cmp, dur, fin }, factsData(session, facts), statsCard(session, facts)
  settings.js render, mounted(ctx, root) (file input listener), actions; pure: equipmentControls(library, equipment), readEquipment(equipment, key), applyEquipmentChange(equipment, key, value)
              singleChanges(library, equipment), dayTypes(library), probeEquipment({ library, equipment, sessions, lengthMin, autoPickSwaps, now, seeds? }) -> { ok, runs, failures }
              unfilledSlots(library, equipment, dayType), probeMessage(library, equipment, probe), importSummaryText(summary, have), listText(items, conj?); const PROBE_SEEDS
  history.js  render (list, or the read-only detail when ctx.route.id is set), actions
  progress.js render, mounted (select change listener), inputs; consts GOAL_PER_WEEK (3), WEEKS (8), VOLUME_POINTS (12), MOVEMENT_POINTS (12), MOVEMENT_ENTRIES (6)
```

## Stored document
IndexedDB database `dumbbell-app`, object store `app`, key `doc` (one value, out-of-line key).

```
{ schema_version: 1, equipment: <copy of library.default_equipment>,
  settings: { default_length_min: 50, auto_pick_swaps: true },
  sessions: [ completed Sessions, chronological ], current: null | Session }
```

`settings.last_export_at` (ISO) is optional: set by Settings only after a backup is delivered, absent
until then, and tolerated when missing, so it needs no schema bump or migration (`defaultDoc` leaves it out).

Fields the app adds to an engine Session: `started_at` (ISO, set by Start), `notes` (string, set on
Summary), `ended_early` (true only when ended early), and while a workout runs:

```
progress: { phase: "warmup"|"round"|"rest"|"effort"|"finisher", block: null|index into session.blocks,
            round: 0-based, item: 0-based, rest_ends_at: null|ISO, draft: null|{ value, weight: number|null } }
```

`progress` is deleted on completion. `completed_at` and `logged` are the engine's own fields.
`migrate` is keyed by the stored `schema_version`: `MIGRATIONS[v]` turns a version-v document into
v + 1, and a missing version counts as 0. A missing document gives `defaultDoc`, a newer version
throws, a missing step throws, and a step that does not raise the version throws. `load` writes the
document back when it was absent or migrated. `save` coalesces: one write in flight, latest doc wins.

## Workout flow
Phases, all in `current.progress`:
- `warmup`: Start puts a started session here. `warmup-done` goes to `round` at the first active block (rounds > 0 and not removed), or on to `finisher` when none.
- `round`: one movement at a time, items in order. `confirm` writes `logged.rounds[round]`, then: next item in the same round, else `rest` if more rounds remain, else `effort`. The draft holds edited value and weight; the prefill is the item target and load.
- `rest`: `rest_ends_at` is now plus `block.rest_sec`. Ends on `rest-skip` or when the 250 ms timer reaches 0 (both call `endRest`, back to `round` item 0). `rest-add` adds 15 sec.
- `effort`: one effort pick per item (`setEffort`). `effort-done` needs all picked, then goes to the next active block's `round`, else `finisher`, else completes the session.
- `finisher`: `finisher-done` or `finisher-skip` sets `finisher.done` true or false and completes.
- Completion pushes the session onto `doc.sessions`, sets `current` to null, and routes to `#/summary`.

End workout early asks for confirmation (`ctx.ui.confirm = 'end'`), then `endEarly` completes with `ended_early: true` and routes to Summary. Discard asks (`'discard'`), then sets `current` to null and routes to Today with nothing saved to history. Keep going clears the confirm.
Undo (shown only when `canUndo`) reverts the latest confirmed round in the current block, never an earlier block. It returns to that item and round with the logged value and weight as the draft. From rest it cancels the rest. From effort it also clears that block's efforts.
Unlogged items: on completion every item in an active block gets `logged = { rounds: [], effort: null }` if it had none (counts 0 volume). Items in removed blocks stay `logged: null`. An unreached finisher gets `done: false`. A missing `started_at` is set to now.

## Routing and rendering
Hash routes in `main.js`: `#/today` (`today.js`), `#/workout` (`workout.js`), `#/summary` (`summary.js`). Unknown hashes go to today.
More routes: `#/history` (`history.js`), `#/history/<session id>` (History detail, same screen module), `#/progress` (`progress.js`), `#/settings` (`settings.js`). `resolve` sets `ctx.route = { name, id }`; `id` is set only for a History detail whose session exists, and an unknown id is replaced by `#/history`. The scroll key includes the id, so opening and leaving a detail scrolls to the top. Nav: `main.js` (not the screens) puts `nav#nav.tabs` above `main` on the four screens in `NAV` (Today, History, Progress, Settings): four equal-width `a.tab` links to `#/<name>`, the current one with `aria-current="page"`. No nav on Workout or Summary. `footer#bar` stays each screen's primary action; an empty bar is hidden (`.bar:empty`).
`#/workout` falls back to today unless `current` is started and has `progress`. `#/summary` falls back to today when `sessions` is empty. Summary shows the last session.
Today calls `ensureCurrent`: if `current` is null or stale (not started and its `day_type` differs from `nextDayType`), `createSession` generates one with a random seed. A generation failure or rule violations set `ctx.ui.genError`, shown with a `regenerate` button.
`render()` resolves the route, unmounts the old screen, rebuilds `main` and `footer#bar`, scrolls to top when screen, phase, block, or round changed, holds a screen wake lock only on workout, then calls `mounted`.
Click delegation on `#app` finds `[data-action]` and calls `screen.actions[name](ctx, dataset, el)`. Input delegation finds `[data-field]` and calls `screen.inputs[name](ctx, value)`.
Save pattern: `ctx.commit(fn, { render: false }?)` mutates `doc`, calls `storage.save(doc)` right away, then re-renders unless `render: false`. Every action saves immediately; there is no debounce. Notes save per keystroke without re-rendering. `ctx.go(name)` sets the hash (`ctx.go('history/' + id)` works too). `ctx.ui` (`flash`, `confirm`, `genError`, `demo`, `progressMovement`) is memory only. `ctx.ui.demo` is the movement id whose demo sheet is open, or null: opening and closing re-render only, never touch storage, `progress`, the draft, or the rest timer. It is cleared on leaving Workout, on completion, and in any phase other than round or rest. `html[data-pending-writes]`, `data-save-error`, `data-ready`, and `data-screen` mirror state.
Swaps: `ctx.ui.swap` is `{ block, slot, demo? }` or null, memory only, cleared on leaving Today, on Start, and whenever the session is started. Swap (shown on each Today row only while the session is not started, like Shuffle) opens the swap sheet: title `Swap <name>`, one row per `swapOptions` candidate with its plan (`formatPlan`) and last-time line, or `No other movement fits this slot with your equipment`. `Use` calls `swapMovement`, commits, closes the sheet, and flashes `Swapped to <name>`. `Form` sets `demo` and shows that movement's demo sheet; closing it returns to the swap sheet. Close and the backdrop close the sheet without touching storage.
Settings: equipment controls come from `equipmentControls` (a switch per on/off field, one per fixed pair listed in the library default or the profile, and a top-weight stepper over the adjustable's `min_lb` to the library `max_lb` in `step_lb`; `bench.incline` is disabled without a bench, the stepper without the adjustable). Before an equipment change is saved, `probeEquipment` generates and validates `PROBE_SEEDS` (5) sessions for each day type with the new equipment and the stored history (day order is not counted). Any throw or violation rejects the change: nothing is saved and `probeMessage` names the slots nothing can fill. After an accepted equipment or swap-switch change an unstarted `current` is replaced by a new `createSession` (null when three seeds fail, so Today rebuilds it); a started one stays and the line `Applies from your next session` shows. Default length writes `settings.default_length_min` and runs `changeLength` on an unstarted `current`. `ctx.ui.settingsNote` (`{ section, kind: "info"|"error", text }`) and `ctx.ui.backupImport` (a successful `parseBackup` waiting for a choice) are memory only and cleared on leaving Settings.
History: completed sessions newest first, each row a link to `#/history/<id>` with date, day type, duration, volume, finisher done or skipped, and an `Ended early` tag; `No workouts logged yet` when empty. The detail is read-only and reuses Summary's stats card with `compareVolume` against only the sessions before it, then each active block's movements with plan, logged round chips, and effort, and the notes as text. `Back` (bar) goes to `#/history`. The nav shows History as current on both.
Progress: `Log a workout to see progress` when empty. Sessions per week: `N of 3 this week` and 8 weekly bars from zero with a dashed `Goal 3` line, the current week filled. Volume by day type: Push, Hinge, and Pull lines over each type's last 12 sessions (padded min to max, min and max labelled, first and last dates), headline of the latest volume and the change from the previous session of that type (`+320 lb from Nov 2`), `First push session` for one, `No push sessions yet` for none. Exercise: a select of `movementsWithHistory`; the choice is `ctx.ui.progressMovement` (memory only, kept across tabs, not reloads) and defaults to the most recent; weight per dumbbell (left out for bodyweight) and best round charts over the last 12 entries, and the last 6 entries (date, `formatLoad`, rounds, effort).
Backup: Export builds the file and hands a `File` to `navigator.share` when `navigator.canShare({ files })` accepts it (the iPhone share sheet), else clicks an `<a download>` on a Blob URL; a share `AbortError` is a silent cancel. `settings.last_export_at` is written only after delivery. Import reads the chosen file, runs `parseBackup`, and on success shows a confirm in the bar (`Backup from <date>: N sessions (<first> to <last>). This phone has M sessions.`) with Replace everything (`applyReplace`), Add missing sessions (`applyMerge`, then a new unstarted `current` when sessions were added), and Cancel. One `ctx.commit`, then `Restored N sessions` or `Added K sessions`. A failed parse shows its error and changes nothing.

## DOM hooks
`data-action` by screen:
- today: `length` (with `data-length`), `reroll-slot` (`data-block`, `data-slot`), `reroll-block` (`data-block`), `reroll-session`, `start`, `resume`, `regenerate`
- today swaps: `swap-open` (`data-block`, `data-slot`; the Swap button on each row), `swap-close` (sheet Close button and backdrop), `swap-pick` and `swap-demo` (`data-movement-id`; Use and Form on each candidate), `demo-close` (the Form sheet, back to the swap sheet)
- workout round and rest: `demo` (`data-movement-id`; the `Form` button on the active card and on each circuit row), `demo-close` (sheet Close button and backdrop)
- workout, all phases: `end-early`, `discard`, `cancel-confirm`, `confirm-end`, `confirm-discard`, `undo`
- workout warmup: `warmup-done`. round: `value-up`, `value-down`, `weight-up`, `weight-down`, `confirm`. rest: `rest-add`, `rest-skip`. effort: `effort` (`data-item`, `data-effort`, `data-movement-id`), `effort-done`. finisher: `finisher-skip`, `finisher-done`
- summary: `summary-done`
- history detail: `history-back`. History rows are plain links (`href="#/history/<id>"`), not `data-action`
- progress: no actions; the movement select is `data-field="progress-movement"` (input delegation, plus a change listener in `mounted`)
- settings: `equipment-toggle` (switches, `data-equipment`), `equipment-down` and `equipment-up` (stepper buttons inside the `data-equipment` group), `default-length` (`data-length`), `swaps-toggle`, `export-backup`, `import-backup`, and in the import confirm `import-replace`, `import-merge`, `import-cancel`
- nav tabs carry `data-nav="today|history|progress|settings"`, not `data-action` (plain hash links)

Other attributes (names are the rendered kebab form):
- today: `data-screen`, `data-day-type`, `data-session-id`, `data-started`, `data-length-min`, `data-rerolls`, `data-estimate-sec`, `data-over-length-sec`, `data-flash`, `data-error`; per item `data-movement-id`, `data-block`, `data-slot`, `data-last-date`, `data-last-weight`, `data-last-values`, `data-last-effort`, `data-last`, `data-basis`; per block `data-block`, `data-rounds`, `data-setting`; `data-finisher-id`
- workout: `data-screen`, `data-phase`, `data-block-index`, `data-block`, `data-round`, `data-item`; active card `data-active-item`, `data-movement-id`, `data-value`, `data-weight`, `data-unit`; `data-entry-value`, `data-entry-weight`; circuit rows `data-movement-id`, `data-item`; chips `data-logged-round`, `data-value`, `data-weight`; effort cards `data-effort`; rest clock `data-rest-ends-at`; `data-finisher-id`
- demo sheet: root `data-demo-sheet` and `data-movement-id` (also `role="dialog"`, `aria-modal`), each cue `data-demo-cue`, video link `data-demo-video`
- swap sheet: root `data-swap-sheet`, `data-block`, `data-slot` (also `role="dialog"`, `aria-modal`, `aria-label`), candidate rows `data-swap-candidate` and `data-movement-id` (plan line `.swap-plan`, last-time line `data-last`), empty message `data-swap-empty`
- summary: `data-screen`, `data-session-id`, `data-day-type`, `data-volume-lb`, `data-bodyweight-reps`, `data-timed-sec`, `data-duration-sec`, `data-finisher`, `data-volume`, `data-compared`, `data-block-volume`, `data-block`; notes textarea `data-field="notes"`
- error screen: `data-screen="error"`
- settings: root `data-screen="settings"`, `data-started`, `data-length-min`, `data-auto-pick-swaps` (`1`/`0`); sections `data-section` (`equipment`, `length`, `swaps`, `backup`); each equipment control `data-equipment` = `adjustable.present`, `adjustable.max_lb` (stepper group, with `data-value`), `fixed_pairs_lb.<lb>`, `bench.present`, `bench.incline`, `pull_up_bar`, `bands` (switches are `role="switch"` buttons with `aria-checked` and `data-on`); swap switch `data-setting="auto_pick_swaps"`; status line `data-settings-note` (`info`/`error`); `data-last-export` (ISO or empty); file input `data-backup-file`; import confirm `data-import-confirm`, summary `data-import-summary`
- history list: root `data-screen="history"`, `data-sessions`; rows `data-history-row`, `data-session-id`, `data-day-type`, `data-volume-lb`, `data-ended-early` (`1`/`0`), tag `data-ended-early-tag`; empty message `data-history-empty`
- history detail: root `data-screen="history-detail"`, `data-session-id`, `data-day-type`, `data-volume-lb`, `data-bodyweight-reps`, `data-timed-sec`, `data-duration-sec`, `data-finisher`, `data-ended-early`; Summary's `data-volume`, `data-compared`, `data-block-volume`, `data-block`; per movement `data-history-item`, `data-movement-id`, `data-rounds`; chips `data-logged-round`, `data-value`, `data-weight`; effort `data-effort`; notes `data-notes`
- progress: root `data-screen="progress"`, `data-sessions`; empty message `data-progress-empty`; sections `data-section` (`weekly`, `volume`, `exercise`); headline `data-this-week`; chart wrappers `data-chart` = `weekly` (`data-weeks`, `data-goal`; bars `data-week-start`, `data-count`), `volume` (`data-day-type`, `data-points`, `data-sessions`; points `data-volume-lb`, `data-session-id`; `.chart-big` with `data-latest-lb`, `.chart-change` with `data-change-lb`; empty `data-volume-empty`), `movement-weight` and `movement-value` (`data-points`; points `data-value`, `data-session-id`); `.movement-detail` with `data-movement-id`, `data-entries`; entries `data-movement-entry`, `data-session-id`, `data-weight`, `data-values`, `data-effort`

## Tests
Both run from the app root: `python tools/run_tests.py` (headless Edge on `tests/index.html`, unit tests) and `python tools/run_e2e.py` (scripted run of `tests/e2e.html` and `tests/e2e.js` against the real UI and IndexedDB, relying on the `data-*` hooks above).
Coverage: `app_flow.test.js` covers `flow.js`; `app_storage.test.js` covers `storage.js`; `app_format.test.js` covers `format.js` plus `durationSec` and `finisherStatus` from `summary.js`; `e2e.js` covers `main.js`, `dom.js`, and the three screens end to end. `dom.js` has no unit test. The engine tests (`generator`, `recommend`, `validate`, `volume`, `duration`) cover `js/engine/`.
Nav, Settings, and backup: `app_backup.test.js` covers `backup.js` (round trip, every rejection, older-schema migration, merge, replace); `app_settings.test.js` covers the pure parts of `settings.js`, including a sweep of every single change from the default profile (each rejected by the guard or giving 30 valid chained sessions with every item `isEligible`, after an empty and a six-session history). The e2e `settings` phase (its own fresh profile, listed in `FRESH_PHASES` in `tools/run_e2e.py`) covers the tabs, Settings, export, and import. To add a phase on its own profile: add its timeout and name to `FRESH_PHASES`, and dispatch on `PHASE_NAME` in `main()` of `tests/e2e.js`.
History and Progress: `app_stats.test.js` covers `stats.js` (Monday boundary in local time, zero weeks, the window, volume equal to `sessionVolume`, movement history and order, ids missing from the library); `app_charts.test.js` covers the chart geometry (scale endpoints, bars from zero, the goal line, one point, all-equal values, empty input) and the SVG builders (role, aria-label, viewBox, class-only colors, text size). The e2e `history` phase (its own fresh profile, in `FRESH_PHASES`) checks the empty states, seeds eight sessions with the engine and `flow.js` at local dates over three weeks, and checks the list and detail against `sessionVolume` and `compareVolume`, Progress against `stats.js`, the memory-only movement choice, and the 375 px layout.
Swaps: `swap.test.js` covers `js/engine/swap.js` (63 chained sessions under `full`, `no_bench`, and `fixed_only`); `app_flow.test.js` covers `swapOptions` and `swapMovement`; the e2e `swap` phase (its own fresh Edge profile, run after phases 1 and 2) covers the Swap button and sheet on Today.
