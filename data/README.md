# library.json field reference

All weights are lb per dumbbell. Validate any edit with `python tools/check_library.py` from `app/`.

## Top-level keys

- `schema_version`: integer, currently 1
- `units`: always `"lb"`
- `default_equipment`: starting equipment profile. `adjustable` {present, min_lb, max_lb, step_lb}, `fixed_pairs_lb` (list), `bench` {present, incline}, `pull_up_bar`, `bands`. The app lets the user edit this, so code must read limits from the profile, never assume them
- `timing`: seconds used by the duration estimate. `transition_sec` (between movements in a round), `rest_between_rounds_sec` per block, `between_blocks_sec`, `warm_up_sec` (both warm-up rounds)
- `roles`: slot roles {id, label}. A role names the job a movement can do in a session
- `movements`: the 58-movement library (fields below)
- `slot_templates`: session shapes. Each has `id`, `day_type` (push, hinge, pull), `source` (draft workout ids it came from), `finisher` (whether the day gets one), and `blocks` A, B, C with `rounds` 4, 4, 3 and three `slots` of accepted `roles`. When a day type has two templates, the generator alternates them
- `finishers`: A to E. `rounds`, `rest_sec`, `movements` (display strings), `load`, `est_seconds`, `day_types`, plus rule fields: `excluded_when_session_has` (patterns that rule the finisher out), `no_equipment_alternate` (fallback only, never a default pick), `requires_adjustable` (needs the adjustable pair; its `load.uses_session_adjustable` means it reuses the session setting)
- `warm_up`: `rounds` and display `movements`

## Movement fields

- `id`: kebab-case slug, stable key for logs. `name`: display name
- `patterns`: 1 or 2 of squat, lunge, hinge, push, pull, carry, accessory, core. Step-ups are lunge; combos list both parts
- `roles`: role ids this movement can fill
- `in_draft_rotation`: true for movements in the six drafted workouts, false for swaps
- `target`: `unit` (reps or seconds), `default`, `min`, `max`, `per_side`. Reps given as a total across sides use `per_side: false` with the total
- `load.dumbbells`: dumbbells moved through each counted rep; this is the number in the volume formula. A dumbbell that stays still during the rep is not counted (the support hand in Renegade Row and Gorilla Row, the overhead hold in Weighted Dead Bug)
- `load.default_source`: adjustable, fixed, or bodyweight. `load.default_weight_lb`: starting weight, null for bodyweight
- `load.fixed_only`: the movement puts weight on the dumbbells under the hands, so it must use a fixed pair, never the adjustable
- `progression`: `load` (add 5 lb or reps by the reps-in-tank rule), `light` (build to about 20 reps at 10 lb before moving up), `bodyweight` (reps only), `timed` (seconds)
- `equipment.bench`: none, flat, or incline. Any bench use counts (lying, chest support, foot elevation, step-ups, seated)
- `seconds_per_round`: working time for one round at the default target, both sides included, excluding transition and rest
- `equivalents`: ids that share at least one role; used for swaps. Every bench movement lists at least one no-bench equivalent
- `harder_variation`: `{id}` for a library movement, `{name, how}` for one outside the library, or null. Never slower lowering, pauses, or tempo. Required for every `load` movement that can fill a Block A role
- `cues`: 2 to 4 short imperative form cues
- `video_url`: YouTube search for the movement's form

## Eligibility rule

A movement can fill a slot under an equipment profile when all of these hold:

1. It has at least one of the slot's roles
2. Its bench need is met: `flat` needs `bench.present`; `incline` needs `bench.present` and `bench.incline`
3. If it uses a dumbbell (`dumbbells > 0` or `default_source` is not bodyweight), the profile has the adjustable pair or at least one fixed pair
4. If `fixed_only`, the profile has at least one fixed pair

Generator-level rules on top of eligibility: at most one adjustable setting per block; no movement twice in a session; every session has a squat or lunge, a hinge, a push, a pull, an accessory, and a core movement (each template guarantees these by having, for each requirement, a slot whose every eligible movement carries that pattern).

## Volume formula

Per movement: `weight_lb_per_dumbbell x dumbbells x reps x (2 if per_side) x rounds`. Bodyweight and timed movements count 0. Session volume is the sum over Blocks A to C; warm-up and finisher are excluded.

## Duration formula

```
warm_up_sec
+ for each block: rounds x (sum of seconds_per_round + 2 x transition_sec)
                  + (rounds - 1) x rest_between_rounds_sec[block]
+ between_blocks_sec x (blocks - 1, plus 1 if there is a finisher)
+ finisher est_seconds
```
