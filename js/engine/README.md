# Workout engine

Pure ES modules: no DOM, fetch, storage, `Date.now()`, or `Math.random()`. The caller passes the
library (`data/library.json`), the equipment profile, completed sessions (chronological), `now`,
and `seed`. Import everything from `js/engine/index.js`. Targets iPhone Safari 15.4+.

## Public functions

```
generateSession({ library, equipment, sessions, lengthMin, seed, now, dayType?, autoPickSwaps = true }) -> Session
reroll({ library, equipment, sessions, session, scope, now }) -> Session
    scope: {type:"slot", block, slot} | {type:"block", block} | {type:"session"}
nextDayType(sessions, library) -> "push" | "hinge" | "pull"
pickTemplate(library, sessions, dayType) -> slot template
validateSession({ library, equipment, sessions, session }) -> [] | [{ rule, message }]
slotAlternatives({ library, equipment, session, blockIndex, slotIndex, exclude?, inRotationOnly? }) -> [movement_id]
recommend({ library, equipment, sessions, movementId | movement }) -> recommendation
lastPerformance(sessions, movementId) -> null | { date, weight_lb_per_dumbbell, target_value, values_by_round, effort, day_type, session_id }
sessionVolume(session) -> { volume_lb, bodyweight_reps, timed_sec, blocks: [{ block, volume_lb, ..., items: [...] }] }
itemVolume(item, plannedRounds) / blockVolume(block)
compareVolume(session, sessions, count = 3) -> null | { volume_lb, average_lb, sessions_compared, delta_lb, delta_pct }
estimateSec(library, session) / estimateMin(library, session)
trimToLength(library, session, lengthMin) -> Session (trims re-applied from planned rounds)
finisherOptions(library, equipment, session) -> [{ id, ok, reason, weight, basis }]
isEligible(movement, roles, equipment), availableWeights(movement, equipment), weightSource(weight, equipment),
nextWeight / previousWeight / mapToAvailable(movement, equipment, weight), stepDistance(...)
makeRng(seed), hashString(str), toSeed(seed)
```

`sessions` is always the completed history before the session in question. `now` is an ISO
string, a Date, or epoch ms; it is stored as ISO. The same inputs and seed give a deep-equal
session; `reroll` derives its seed from `session.seed`, the reroll count, and the scope.

## Session

```
{ id, seed, day_type, template_id, length_min, created_at, completed_at: null|ISO, auto_pick_swaps,
  blocks: [ { block: "A"|"B"|"C", rounds, planned_rounds, rest_sec, adjustable_setting_lb: number|null, removed,
    items: [ { movement_id, slot: 0|1|2,
               target: { unit: "reps"|"seconds", value, per_side },
               load: { source: "adjustable"|"fixed"|"bodyweight", weight_lb_per_dumbbell: number|null, dumbbells },
               recommendation: { basis, weight_lb_per_dumbbell, target_value, suggest_variation: null|object,
                                 last: null|{ date, weight_lb_per_dumbbell, values_by_round, effort, ... },
                                 remapped_from_lb? },
               adjusted: null|{ reason: "block_setting"|"fixed_pair", recommended_weight_lb, rep_shift },
               forced_repeat, off_target, swap, reroll_excluded: [movement_id],
               logged: null|{ rounds: [ { value, weight_lb_per_dumbbell } ], effort: "two_plus_left"|"hard_clean"|"barely"|null } } ] } ],
  finisher: null|{ id, name, weight_lb_per_dumbbell: number|null, setting_basis, done: null|bool },
  estimate_sec, trims: [ { step, block, from_rounds, to_rounds, estimate_sec_before, estimate_sec_after } ],
  over_length_sec: 0|number,
  rerolls: { count, history: [ { at, scope, changes: [ { block, slot, from, to } ], finisher: { from, to } } ] } }
```

- A trimmed-away Block C stays in `blocks` with `rounds: 0` and `removed: true`; skip it in the UI.
  `planned_rounds` keeps the template's 4/4/3. Trim order: `block_c_2_rounds`, `block_b_3_rounds`,
  `block_b_2_rounds`, `block_c_removed`.
- `forced_repeat` marks a movement from the last session of the same day type, used only because
  no other movement could fill the slot. `off_target` marks the last-resort load (nearest fixed
  pair below the recommendation at the max target), used only for gaps of more than one step.
- `adjusted` items run one step from their recommended weight with the target moved by 2
  (heavier: fewer); `rep_shift` is the shift after clamping. `reason: "block_setting"` runs at
  the block's adjustable setting; `reason: "fixed_pair"` runs on a fixed pair one step away, used
  only when no movement or setting works (before off_target).
- `reroll_excluded` lists movements the user rerolled out of that slot; the validator does not
  count them as alternatives.
- Logging writes `logged` on each item and `completed_at` on the session. A logged session can
  be rerolled, but rerolling re-trims from planned rounds.

## Recommendation basis values

`first_time`, `step_down`, `short_repeat` (short but nothing lighter), `weight_up`,
`top_weight_reps`, `top_weight_variation`, `top_weight_hold` (no harder variation),
`add_reps`, `add_time`, `hold_max`, `max_variation`, `max_hold`, `repeat`.

## Validator rules

`day_type_order`, `structure`, `estimate`, `trims`, `finisher_presence`, `role_eligibility`,
`patterns`, `duplicate`, `repeat`, `swaps`, `per_side`, `adjustable_setting`,
`weight_available`, `weight_fidelity`, `finisher_rules`.

## Tests

`python tools/run_tests.py` from `app/` runs `tests/index.html` in headless Edge.
