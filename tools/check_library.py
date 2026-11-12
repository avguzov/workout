#!/usr/bin/env python3
"""Check app/data/library.json and the test fixtures.

Run from app/:
    python tools/check_library.py
    python tools/check_library.py --source "../program.json"

Standard library only. Prints one PASS/FAIL line per check (check 9 is
report-only and prints PASS or WARN), then a summary. Exits 0 only if every
hard check passes.
"""
import argparse
import itertools
import json
import os
import re
import sys
import urllib.parse

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBRARY_PATH = os.path.join(APP, "data", "library.json")
PROFILES_PATH = os.path.join(APP, "tests", "fixtures", "equipment_profiles.json")
DRAFTS_PATH = os.path.join(APP, "tests", "fixtures", "draft_workouts.json")

PATTERNS = {"squat", "lunge", "hinge", "push", "pull", "carry", "accessory", "core"}
REQUIREMENTS = [
    ("squat/lunge", {"squat", "lunge"}),
    ("hinge", {"hinge"}),
    ("push", {"push"}),
    ("pull", {"pull"}),
    ("accessory", {"accessory"}),
    ("core", {"core"}),
]
DAY_TYPES = {"push", "hinge", "pull"}
BLOCK_ROUNDS = {"A": 4, "B": 4, "C": 3}
UNITS = {"reps", "seconds"}
SOURCES = {"adjustable", "fixed", "bodyweight"}
PROGRESSIONS = {"load", "light", "bodyweight", "timed"}
BENCH = {"none", "flat", "incline"}
# Swap groups: a swap only offers movements with the same muscle_group (js/engine/swap.js).
MUSCLE_GROUPS = {"chest", "back", "shoulders", "biceps", "triceps", "quads_glutes",
                 "hamstrings_glutes", "core"}
FINISHER_IDS = ["A", "B", "C", "D", "E"]
DRAFT_IDS = ["w1d1", "w1d2", "w1d3", "w2d1", "w2d2", "w2d3"]
PROFILE_NAMES = ["full", "no_bench", "fixed_only"]
POOL_MIN = {"full": 3, "no_bench": 2, "fixed_only": 2}
VIDEO_PREFIX = "https://www.youtube.com/results?search_query="
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
ROLE_ID = re.compile(r"^[a-z][a-z0-9_]*$")
BANNED = re.compile(r"slow|pause|tempo|\d+-sec", re.I)
EXPECTED_MOVEMENTS = 63
EXPECTED_IN_ROTATION = 53
# In rotation by owner approval (2026-11-11) to deepen the no-bench pools; not in the drafts.
ADDED_IN_ROTATION = {"standing-db-shoulder-press", "standard-push-up", "close-grip-db-floor-press",
                     "floor-skull-crusher", "db-floor-fly"}
FINISHER_SEC = (300, 480)
DURATION_MIN = (35, 55)
DURATION_LONG = {"w2d1": (45, 55)}

TOP_KEYS = ["schema_version", "units", "default_equipment", "timing", "roles", "movements",
            "slot_templates", "finishers", "warm_up"]
MOVEMENT_KEYS = ["id", "name", "patterns", "roles", "muscle_group", "in_draft_rotation", "target", "load",
                 "progression", "equipment", "seconds_per_round", "equivalents",
                 "harder_variation", "cues", "video_url"]
FINISHER_KEYS = {"id", "name", "rounds", "rest_sec", "movements", "load", "est_seconds",
                 "day_types", "excluded_when_session_has", "no_equipment_alternate",
                 "requires_adjustable"}


# ----------------------------------------------------------------- helpers

def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_str(v):
    return isinstance(v, str) and v.strip() != ""


def str_list(v, allow_empty=False):
    return isinstance(v, list) and (allow_empty or v) and all(is_str(x) for x in v)


def weight_ok(source, weight, eq):
    """True if the equipment can produce this load."""
    if source == "bodyweight":
        return weight is None
    if not is_num(weight):
        return False
    if source == "fixed":
        return weight in eq["fixed_pairs_lb"]
    adj = eq["adjustable"]
    if not adj["present"]:
        return False
    return (adj["min_lb"] <= weight <= adj["max_lb"]
            and (weight - adj["min_lb"]) % adj["step_lb"] == 0)


def has_dumbbells(profile):
    return profile["adjustable"]["present"] or len(profile["fixed_pairs_lb"]) > 0


def eligible(mv, slot_roles, profile):
    """Eligibility rule shared with the generator (see data/README.md)."""
    if not set(mv["roles"]) & set(slot_roles):
        return False
    bench_need = mv["equipment"]["bench"]
    bench = profile["bench"]
    if bench_need in ("flat", "incline") and not bench["present"]:
        return False
    if bench_need == "incline" and not bench["incline"]:
        return False
    load = mv["load"]
    needs_db = load["dumbbells"] > 0 or load["default_source"] != "bodyweight"
    if needs_db and not has_dumbbells(profile):
        return False
    if load["fixed_only"] and not profile["fixed_pairs_lb"]:
        return False
    return True


def volume(entry, rounds):
    t, ld = entry["target"], entry["load"]
    if t["unit"] != "reps" or ld["source"] == "bodyweight":
        return 0
    return (ld["weight_lb_per_dumbbell"] * ld["dumbbells"] * t["value"]
            * (2 if t["per_side"] else 1) * rounds)


def needs_bench(mv):
    return mv["equipment"]["bench"] != "none"


# ----------------------------------------------------------------- check 1

def check_equipment(eq, where, errs):
    if not isinstance(eq, dict):
        errs.append(f"{where}: not an object")
        return False
    ok = True
    adj = eq.get("adjustable")
    if not isinstance(adj, dict) or not isinstance(adj.get("present"), bool):
        errs.append(f"{where}.adjustable: needs object with boolean 'present'")
        ok = False
    else:
        for k in ("min_lb", "max_lb", "step_lb"):
            if k not in adj:
                errs.append(f"{where}.adjustable.{k}: missing")
                ok = False
            elif adj["present"] and not (is_num(adj[k]) and adj[k] > 0):
                errs.append(f"{where}.adjustable.{k}: must be a positive number when present")
                ok = False
            elif not adj["present"] and adj[k] is not None and not is_num(adj[k]):
                errs.append(f"{where}.adjustable.{k}: must be a number or null")
                ok = False
        if ok and adj["present"] and adj["min_lb"] > adj["max_lb"]:
            errs.append(f"{where}.adjustable: min_lb above max_lb")
            ok = False
    fp = eq.get("fixed_pairs_lb")
    if not isinstance(fp, list) or not all(is_num(x) and x > 0 for x in fp):
        errs.append(f"{where}.fixed_pairs_lb: must be a list of positive numbers")
        ok = False
    bench = eq.get("bench")
    if (not isinstance(bench, dict) or not isinstance(bench.get("present"), bool)
            or not isinstance(bench.get("incline"), bool)):
        errs.append(f"{where}.bench: needs boolean 'present' and 'incline'")
        ok = False
    elif bench["incline"] and not bench["present"]:
        errs.append(f"{where}.bench: incline without a bench")
        ok = False
    for k in ("pull_up_bar", "bands"):
        if not isinstance(eq.get(k), bool):
            errs.append(f"{where}.{k}: must be boolean")
            ok = False
    return ok


def check_target(t, where, errs, keys):
    if not isinstance(t, dict):
        errs.append(f"{where}: target must be an object")
        return
    if t.get("unit") not in UNITS:
        errs.append(f"{where}: target.unit must be one of {sorted(UNITS)}")
    for k in keys:
        if not (is_int(t.get(k)) and t.get(k) > 0):
            errs.append(f"{where}: target.{k} must be a positive integer")
    if not isinstance(t.get("per_side"), bool):
        errs.append(f"{where}: target.per_side must be boolean")


def check_movement(mv, idx, eq, errs):
    where = f"movement[{idx}] {mv.get('id', '?') if isinstance(mv, dict) else '?'}"
    if not isinstance(mv, dict):
        errs.append(f"{where}: not an object")
        return
    missing = [k for k in MOVEMENT_KEYS if k not in mv]
    extra = [k for k in mv if k not in MOVEMENT_KEYS]
    if missing:
        errs.append(f"{where}: missing {missing}")
        return
    if extra:
        errs.append(f"{where}: unexpected keys {extra}")
    if not is_str(mv["id"]) or not is_str(mv["name"]):
        errs.append(f"{where}: id and name must be non-empty strings")
    pats = mv["patterns"]
    if (not isinstance(pats, list) or not 1 <= len(pats) <= 2 or len(set(pats)) != len(pats)
            or not all(p in PATTERNS for p in pats)):
        errs.append(f"{where}: patterns must be 1 or 2 distinct values from {sorted(PATTERNS)}")
    if not str_list(mv["roles"]) or len(set(mv["roles"])) != len(mv["roles"]):
        errs.append(f"{where}: roles must be a non-empty list of distinct strings")
    if mv["muscle_group"] not in MUSCLE_GROUPS:
        errs.append(f"{where}: muscle_group must be one of {sorted(MUSCLE_GROUPS)}")
    if not isinstance(mv["in_draft_rotation"], bool):
        errs.append(f"{where}: in_draft_rotation must be boolean")
    check_target(mv["target"], where, errs, ("default", "min", "max"))
    ld = mv["load"]
    if not isinstance(ld, dict) or set(ld) != {"dumbbells", "default_source", "default_weight_lb",
                                               "fixed_only"}:
        errs.append(f"{where}: load needs exactly dumbbells, default_source, default_weight_lb, "
                    f"fixed_only")
    else:
        if ld["dumbbells"] not in (0, 1, 2) or not is_int(ld["dumbbells"]):
            errs.append(f"{where}: load.dumbbells must be 0, 1, or 2")
        if ld["default_source"] not in SOURCES:
            errs.append(f"{where}: load.default_source must be one of {sorted(SOURCES)}")
        elif not weight_ok(ld["default_source"], ld["default_weight_lb"], eq):
            errs.append(f"{where}: default_weight_lb {ld['default_weight_lb']} is not available "
                        f"as {ld['default_source']} under default_equipment")
        if not isinstance(ld["fixed_only"], bool):
            errs.append(f"{where}: load.fixed_only must be boolean")
        elif ld["fixed_only"] and ld["default_source"] != "fixed":
            errs.append(f"{where}: fixed_only movement must default to a fixed pair")
        if ld["default_source"] == "bodyweight" and ld["dumbbells"] != 0:
            errs.append(f"{where}: bodyweight movement must have dumbbells 0")
    if mv["progression"] not in PROGRESSIONS:
        errs.append(f"{where}: progression must be one of {sorted(PROGRESSIONS)}")
    else:
        unit = mv["target"].get("unit") if isinstance(mv["target"], dict) else None
        if (mv["progression"] == "timed") != (unit == "seconds"):
            errs.append(f"{where}: progression 'timed' goes with unit 'seconds' and only there")
        if mv["progression"] == "bodyweight" and isinstance(ld, dict) \
                and ld.get("default_source") != "bodyweight":
            errs.append(f"{where}: bodyweight progression needs default_source bodyweight")
        if mv["progression"] == "load" and isinstance(ld, dict) \
                and ld.get("default_source") == "bodyweight":
            errs.append(f"{where}: load progression needs a loaded default_source")
    if not isinstance(mv["equipment"], dict) or set(mv["equipment"]) != {"bench"} \
            or mv["equipment"]["bench"] not in BENCH:
        errs.append(f"{where}: equipment must be {{'bench': none|flat|incline}}")
    if not is_int(mv["seconds_per_round"]):
        errs.append(f"{where}: seconds_per_round must be an integer")
    if not isinstance(mv["equivalents"], list) or not all(is_str(x) for x in mv["equivalents"]):
        errs.append(f"{where}: equivalents must be a list of ids")
    hv = mv["harder_variation"]
    if hv is not None:
        if not isinstance(hv, dict) or not (
                (set(hv) == {"id"} and is_str(hv["id"]))
                or (set(hv) == {"name", "how"} and is_str(hv["name"]) and is_str(hv["how"]))):
            errs.append(f"{where}: harder_variation must be null, {{id}}, or {{name, how}}")
    if not str_list(mv["cues"]):
        errs.append(f"{where}: cues must be a non-empty list of strings")
    if not is_str(mv["video_url"]):
        errs.append(f"{where}: video_url must be a string")


def check_template(t, idx, errs):
    where = f"slot_templates[{idx}] {t.get('id', '?') if isinstance(t, dict) else '?'}"
    if not isinstance(t, dict):
        errs.append(f"{where}: not an object")
        return
    for k in ("id", "day_type", "source", "finisher", "blocks"):
        if k not in t:
            errs.append(f"{where}: missing {k}")
            return
    if not is_str(t["id"]):
        errs.append(f"{where}: id must be a string")
    if t["day_type"] not in DAY_TYPES:
        errs.append(f"{where}: day_type must be one of {sorted(DAY_TYPES)}")
    if not (is_str(t["source"]) or str_list(t["source"])):
        errs.append(f"{where}: source must be a string or list of strings")
    if not isinstance(t["finisher"], bool):
        errs.append(f"{where}: finisher must be boolean")
    if not isinstance(t["blocks"], list):
        errs.append(f"{where}: blocks must be a list")
        return
    for b in t["blocks"]:
        if not isinstance(b, dict) or b.get("block") not in BLOCK_ROUNDS or not is_int(b.get("rounds")) \
                or not isinstance(b.get("slots"), list):
            errs.append(f"{where}: each block needs block A|B|C, integer rounds, slots list")
            continue
        for s in b["slots"]:
            if not isinstance(s, dict) or set(s) != {"roles"} or not str_list(s["roles"]):
                errs.append(f"{where} block {b['block']}: each slot must be {{roles: [..]}}")


def check_finisher_types(f, idx, errs):
    where = f"finishers[{idx}] {f.get('id', '?') if isinstance(f, dict) else '?'}"
    if not isinstance(f, dict):
        errs.append(f"{where}: not an object")
        return
    missing = FINISHER_KEYS - set(f)
    if missing:
        errs.append(f"{where}: missing {sorted(missing)}")
        return
    if not is_str(f["id"]) or not is_str(f["name"]):
        errs.append(f"{where}: id and name must be strings")
    for k in ("rounds", "rest_sec", "est_seconds"):
        if not (is_int(f[k]) and f[k] > 0):
            errs.append(f"{where}: {k} must be a positive integer")
    if not str_list(f["movements"]):
        errs.append(f"{where}: movements must be a non-empty list of strings")
    ld = f["load"]
    if not isinstance(ld, dict) or ld.get("source") not in SOURCES or ld.get("dumbbells") not in (0, 1, 2):
        errs.append(f"{where}: load needs source and dumbbells")
    elif not ld.get("uses_session_adjustable") and ld["source"] != "bodyweight" \
            and not is_num(ld.get("weight_lb_per_dumbbell")):
        errs.append(f"{where}: load needs weight_lb_per_dumbbell or uses_session_adjustable")
    if not str_list(f["day_types"]) or not set(f["day_types"]) <= DAY_TYPES:
        errs.append(f"{where}: day_types must list day types")
    if not str_list(f["excluded_when_session_has"], allow_empty=True) \
            or not set(f["excluded_when_session_has"]) <= PATTERNS:
        errs.append(f"{where}: excluded_when_session_has must list patterns")
    for k in ("no_equipment_alternate", "requires_adjustable"):
        if not isinstance(f[k], bool):
            errs.append(f"{where}: {k} must be boolean")


def check_draft_types(w, idx, eq, errs):
    where = f"draft[{idx}] {w.get('id', '?') if isinstance(w, dict) else '?'}"
    if not isinstance(w, dict):
        errs.append(f"{where}: not an object")
        return
    for k in ("id", "day_type", "template_id", "adjustable_setting_lb", "finisher",
              "expected_volume_lb", "blocks"):
        if k not in w:
            errs.append(f"{where}: missing {k}")
            return
    if w["day_type"] not in DAY_TYPES:
        errs.append(f"{where}: bad day_type")
    if not is_str(w["template_id"]):
        errs.append(f"{where}: template_id must be a string")
    if w["adjustable_setting_lb"] is not None and not weight_ok("adjustable", w["adjustable_setting_lb"], eq):
        errs.append(f"{where}: adjustable_setting_lb not available on the default adjustable pair")
    if w["finisher"] is not None and w["finisher"] not in FINISHER_IDS:
        errs.append(f"{where}: finisher must be A to E or null")
    if not is_int(w["expected_volume_lb"]):
        errs.append(f"{where}: expected_volume_lb must be an integer")
    if not isinstance(w["blocks"], list) or len(w["blocks"]) != 3:
        errs.append(f"{where}: needs 3 blocks")
        return
    for b in w["blocks"]:
        if not isinstance(b, dict) or b.get("block") not in BLOCK_ROUNDS \
                or b.get("rounds") != BLOCK_ROUNDS[b.get("block")] \
                or not isinstance(b.get("movements"), list) or len(b["movements"]) != 3:
            errs.append(f"{where}: each block needs block, standard rounds, and 3 movements")
            continue
        for e in b["movements"]:
            ew = f"{where} {b['block']} {e.get('id', '?') if isinstance(e, dict) else '?'}"
            if not isinstance(e, dict) or not is_str(e.get("id")):
                errs.append(f"{ew}: needs id")
                continue
            check_target(e.get("target"), ew, errs, ("value",))
            ld = e.get("load")
            if not isinstance(ld, dict) or set(ld) != {"source", "weight_lb_per_dumbbell", "dumbbells"}:
                errs.append(f"{ew}: load needs source, weight_lb_per_dumbbell, dumbbells")
                continue
            if ld["source"] not in SOURCES or ld["dumbbells"] not in (0, 1, 2):
                errs.append(f"{ew}: bad load source or dumbbells")
            elif not weight_ok(ld["source"], ld["weight_lb_per_dumbbell"], eq):
                errs.append(f"{ew}: weight not available under default_equipment")
            if ld["source"] == "bodyweight" and ld["dumbbells"] != 0:
                errs.append(f"{ew}: bodyweight load must have dumbbells 0")


def check1(lib, profiles, drafts):
    errs = []
    missing = [k for k in TOP_KEYS if k not in lib]
    if missing:
        return [f"library: missing top-level keys {missing}"]
    if lib["schema_version"] != 1:
        errs.append("library.schema_version must be 1")
    if lib["units"] != "lb":
        errs.append("library.units must be 'lb'")
    eq_ok = check_equipment(lib["default_equipment"], "default_equipment", errs)
    tm = lib["timing"]
    if not isinstance(tm, dict):
        errs.append("timing must be an object")
    else:
        for k in ("transition_sec", "between_blocks_sec", "warm_up_sec"):
            if not (is_int(tm.get(k)) and tm.get(k) > 0):
                errs.append(f"timing.{k} must be a positive integer")
        rb = tm.get("rest_between_rounds_sec")
        if not isinstance(rb, dict) or set(rb) != set(BLOCK_ROUNDS) or not all(is_int(v) for v in rb.values()):
            errs.append("timing.rest_between_rounds_sec needs integer A, B, C")
    if not isinstance(lib["roles"], list) or not lib["roles"]:
        errs.append("roles must be a non-empty list")
    else:
        for r in lib["roles"]:
            if not isinstance(r, dict) or set(r) != {"id", "label"} or not is_str(r.get("label")) \
                    or not (isinstance(r.get("id"), str) and ROLE_ID.match(r["id"])):
                errs.append(f"role {r!r}: needs snake_case id and label")
    if not isinstance(lib["movements"], list):
        errs.append("movements must be a list")
    elif eq_ok:
        for i, mv in enumerate(lib["movements"]):
            check_movement(mv, i, lib["default_equipment"], errs)
    if not isinstance(lib["slot_templates"], list) or not lib["slot_templates"]:
        errs.append("slot_templates must be a non-empty list")
    else:
        for i, t in enumerate(lib["slot_templates"]):
            check_template(t, i, errs)
    if not isinstance(lib["finishers"], list):
        errs.append("finishers must be a list")
    else:
        for i, f in enumerate(lib["finishers"]):
            check_finisher_types(f, i, errs)
    wu = lib["warm_up"]
    if not isinstance(wu, dict) or not is_int(wu.get("rounds")) or not str_list(wu.get("movements")):
        errs.append("warm_up needs integer rounds and a movements list")
    # fixtures
    if not isinstance(profiles, dict) or sorted(profiles) != sorted(PROFILE_NAMES):
        errs.append(f"equipment_profiles: needs exactly {PROFILE_NAMES}")
    else:
        for name in PROFILE_NAMES:
            check_equipment(profiles[name], f"profile {name}", errs)
        if eq_ok and profiles["full"] != lib["default_equipment"]:
            errs.append("profile full must equal library.default_equipment")
        nb, fo = profiles["no_bench"], profiles["fixed_only"]
        if isinstance(nb, dict) and isinstance(nb.get("bench"), dict) and nb["bench"].get("present") is not False:
            errs.append("profile no_bench must have bench.present false")
        if isinstance(fo, dict) and isinstance(fo.get("adjustable"), dict):
            if fo["adjustable"].get("present") is not False:
                errs.append("profile fixed_only must have adjustable.present false")
            if not fo.get("fixed_pairs_lb"):
                errs.append("profile fixed_only must list fixed pairs")
            if not (isinstance(fo.get("bench"), dict) and fo["bench"].get("present") and fo["bench"].get("incline")):
                errs.append("profile fixed_only must have a bench with incline")
    if not isinstance(drafts, list):
        errs.append("draft_workouts must be a list")
    else:
        ids = [w.get("id") for w in drafts if isinstance(w, dict)]
        if sorted(ids) != sorted(DRAFT_IDS):
            errs.append(f"draft_workouts ids must be {DRAFT_IDS}, found {ids}")
        if eq_ok:
            for i, w in enumerate(drafts):
                check_draft_types(w, i, lib["default_equipment"], errs)
    return errs


# ----------------------------------------------------------------- checks 2-9

def check2(lib, source):
    errs = []
    mvs = lib["movements"]
    ids = [m["id"] for m in mvs]
    if len(mvs) != EXPECTED_MOVEMENTS:
        errs.append(f"expected {EXPECTED_MOVEMENTS} movements, found {len(mvs)}")
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append(f"duplicate ids {dup}")
    bad = [i for i in ids if not KEBAB.match(i)]
    if bad:
        errs.append(f"ids not kebab-case {bad}")
    names = [m["name"] for m in mvs]
    dupn = sorted({n for n in names if names.count(n) > 1})
    if dupn:
        errs.append(f"duplicate names {dupn}")
    if source is None:
        note = "source comparison skipped (no --source given)"
    else:
        try:
            with open(source, encoding="utf-8") as f:
                prog = json.load(f)
            slots = [mv["name"] for w in prog["weeks"] for d in w["days"]
                     for b in d["blocks"] for mv in b["movements"]]
        except (OSError, ValueError, KeyError, TypeError) as exc:
            errs.append(f"cannot read --source {source}: {exc}")
            return errs, "source unreadable"
        src = set(slots)
        lib_names = set(names)
        if src != lib_names:
            if src - lib_names:
                errs.append(f"in program.json but not library: {sorted(src - lib_names)}")
            if lib_names - src:
                errs.append(f"in library but not program.json: {sorted(lib_names - src)}")
        note = f"names compared with program.json ({len(slots)} slots, {len(src)} distinct)"
    return errs, f"{len(mvs)} movements, {len(set(ids))} distinct ids; {note}"


def block_a_roles(lib):
    return {r for t in lib["slot_templates"] for b in t["blocks"] if b["block"] == "A"
            for s in b["slots"] for r in s["roles"]}


def check3(lib, drafts):
    errs = []
    by_id = {m["id"]: m for m in lib["movements"]}
    role_ids = [r["id"] for r in lib["roles"]]
    roles = set(role_ids)
    if len(roles) != len(role_ids):
        errs.append("duplicate role ids")
    used_by_mv, used_by_slot = set(), set()
    for m in lib["movements"]:
        for r in m["roles"]:
            used_by_mv.add(r)
            if r not in roles:
                errs.append(f"{m['id']}: unknown role {r}")
    for t in lib["slot_templates"]:
        for b in t["blocks"]:
            for s in b["slots"]:
                for r in s["roles"]:
                    used_by_slot.add(r)
                    if r not in roles:
                        errs.append(f"template {t['id']} {b['block']}: unknown role {r}")
    for r in role_ids:
        if r not in used_by_mv:
            errs.append(f"role {r} has no movements")
        if r not in used_by_slot:
            errs.append(f"role {r} is not used by any slot")
    n_equiv = 0
    for m in lib["movements"]:
        eqs = m["equivalents"]
        if len(set(eqs)) != len(eqs):
            errs.append(f"{m['id']}: duplicate equivalents")
        sharing = 0
        no_bench_alt = False
        for e in eqs:
            n_equiv += 1
            if e == m["id"]:
                errs.append(f"{m['id']}: lists itself as an equivalent")
                continue
            if e not in by_id:
                errs.append(f"{m['id']}: equivalent {e} does not resolve")
                continue
            if set(by_id[e]["roles"]) & set(m["roles"]):
                sharing += 1
            else:
                errs.append(f"{m['id']}: equivalent {e} shares no role")
            if not needs_bench(by_id[e]):
                no_bench_alt = True
        if sharing < 2:
            errs.append(f"{m['id']}: needs at least 2 equivalents sharing a role, has {sharing}")
        if needs_bench(m) and not no_bench_alt:
            errs.append(f"{m['id']}: needs the bench but has no no-bench equivalent")
        hv = m["harder_variation"]
        if isinstance(hv, dict) and "id" in hv:
            if hv["id"] == m["id"]:
                errs.append(f"{m['id']}: harder_variation points to itself")
            elif hv["id"] not in by_id:
                errs.append(f"{m['id']}: harder_variation {hv['id']} does not resolve")
    groups = {}
    for m in lib["movements"]:
        groups.setdefault(m["muscle_group"], []).append(m["id"])
    for g in sorted(MUSCLE_GROUPS):
        if len(groups.get(g, [])) < 2:
            errs.append(f"muscle_group {g} has {len(groups.get(g, []))} movement(s), needs at least 2")
    template_ids = {t["id"] for t in lib["slot_templates"]}
    finisher_ids = {f["id"] for f in lib["finishers"]}
    n_fix = 0
    for w in drafts:
        if w["template_id"] not in template_ids:
            errs.append(f"{w['id']}: template_id {w['template_id']} does not resolve")
        if w["finisher"] is not None and w["finisher"] not in finisher_ids:
            errs.append(f"{w['id']}: finisher {w['finisher']} does not resolve")
        for b in w["blocks"]:
            for e in b["movements"]:
                n_fix += 1
                if e["id"] not in by_id:
                    errs.append(f"{w['id']} {b['block']}: movement {e['id']} does not resolve")
    n_bench = sum(1 for m in lib["movements"] if needs_bench(m))
    return errs, (f"{len(roles)} roles; {len(groups)} muscle groups; {n_equiv} equivalent links; "
                  f"{n_bench} bench movements checked for a no-bench equivalent; "
                  f"{n_fix} fixture movement refs")


def check4(lib, lib_text):
    errs = []
    req_roles = block_a_roles(lib)
    n_cues = n_hv_req = 0
    non_ascii = sorted({c for c in lib_text if ord(c) > 126})
    if non_ascii:
        errs.append(f"library.json has non-ASCII characters {non_ascii}")
    for m in lib["movements"]:
        mid = m["id"]
        cues = m["cues"]
        if not 2 <= len(cues) <= 4:
            errs.append(f"{mid}: needs 2 to 4 cues, has {len(cues)}")
        for c in cues:
            n_cues += 1
            if len(c) >= 90:
                errs.append(f"{mid}: cue is {len(c)} chars: {c!r}")
            if c.rstrip().endswith("."):
                errs.append(f"{mid}: cue ends with a period: {c!r}")
            if "—" in c or "--" in c:
                errs.append(f"{mid}: cue has an em dash: {c!r}")
            if BANNED.search(c):
                errs.append(f"{mid}: cue mentions slow, pause, or tempo work: {c!r}")
        url = m["video_url"]
        if not url.startswith(VIDEO_PREFIX) or len(url) == len(VIDEO_PREFIX):
            errs.append(f"{mid}: video_url must start with {VIDEO_PREFIX} and carry a query")
        else:
            q = url[len(VIDEO_PREFIX):]
            phrase = urllib.parse.unquote_plus(q)
            if urllib.parse.quote_plus(phrase) != q:
                errs.append(f"{mid}: video_url query is not URL-encoded plainly")
            words = phrase.lower().split()
            if "form" not in words:
                errs.append(f"{mid}: video search phrase must include 'form'")
            if "db" in words:
                errs.append(f"{mid}: video search phrase must spell out 'dumbbell'")
            if m["load"]["default_source"] != "bodyweight" and "dumbbell" not in words:
                errs.append(f"{mid}: loaded movement's search phrase must include 'dumbbell'")
        spr = m["seconds_per_round"]
        if not 15 <= spr <= 150:
            errs.append(f"{mid}: seconds_per_round {spr} outside 15 to 150")
        t = m["target"]
        if not t["min"] <= t["default"] <= t["max"]:
            errs.append(f"{mid}: target needs min <= default <= max")
        hv = m["harder_variation"]
        required = m["progression"] == "load" and bool(set(m["roles"]) & req_roles)
        if required:
            n_hv_req += 1
            if hv is None:
                errs.append(f"{mid}: load movement with a Block A role needs a harder_variation")
        if isinstance(hv, dict) and "name" in hv:
            if BANNED.search(hv["name"] + " " + hv["how"]):
                errs.append(f"{mid}: harder_variation mentions slow, pause, or tempo work")
            if "—" in hv["name"] + hv["how"]:
                errs.append(f"{mid}: harder_variation has an em dash")
    return errs, (f"{n_cues} cues, {len(lib['movements'])} video URLs, seconds_per_round, and "
                  f"targets checked; {n_hv_req} Block A load movements need a harder variation")


def draft_ids(drafts):
    return {e["id"] for w in drafts for b in w["blocks"] for e in b["movements"]}


def check5(lib, drafts):
    errs = []
    on = {m["id"] for m in lib["movements"] if m["in_draft_rotation"]}
    off = {m["id"] for m in lib["movements"] if not m["in_draft_rotation"]}
    if len(on) != EXPECTED_IN_ROTATION:
        errs.append(f"expected {EXPECTED_IN_ROTATION} in rotation, found {len(on)}")
    if len(off) != EXPECTED_MOVEMENTS - EXPECTED_IN_ROTATION:
        errs.append(f"expected {EXPECTED_MOVEMENTS - EXPECTED_IN_ROTATION} swaps, found {len(off)}")
    used = draft_ids(drafts)
    if ADDED_IN_ROTATION - on:
        errs.append(f"added movements not flagged in rotation: {sorted(ADDED_IN_ROTATION - on)}")
    if ADDED_IN_ROTATION & used:
        errs.append(f"added movements also appear in drafts: {sorted(ADDED_IN_ROTATION & used)}")
    drafted = on - ADDED_IN_ROTATION
    if drafted != used:
        if drafted - used:
            errs.append(f"flagged in rotation but not in drafts: {sorted(drafted - used)}")
        if used - drafted:
            errs.append(f"used in drafts but not flagged: {sorted(used - drafted)}")
    return errs, (f"{len(on)} in rotation, {len(off)} swaps; compared with the {len(used)} draft ids "
                  f"plus {len(ADDED_IN_ROTATION)} added")


def check6(lib, profiles):
    errs = []
    lines = []
    mvs = lib["movements"]
    n_guar = 0
    at_min = []
    header = f"    {'template':<8} {'slot':<4} {'roles':<30} " + " ".join(f"{p:>10}" for p in PROFILE_NAMES)
    lines.append(header)
    for t in lib["slot_templates"]:
        tid = t["id"]
        blocks = t["blocks"]
        if [b["block"] for b in blocks] != ["A", "B", "C"]:
            errs.append(f"{tid}: blocks must be A, B, C in order")
        for b in blocks:
            if b["rounds"] != BLOCK_ROUNDS.get(b["block"]):
                errs.append(f"{tid} {b['block']}: rounds must be {BLOCK_ROUNDS.get(b['block'])}")
            if len(b["slots"]) != 3:
                errs.append(f"{tid} {b['block']}: needs 3 slots, has {len(b['slots'])}")
        slots = [(b["block"], i + 1, s["roles"]) for b in blocks for i, s in enumerate(b["slots"])]
        pools = {}
        for blk, n, roles in slots:
            row = []
            for p in PROFILE_NAMES:
                pool = [m for m in mvs if eligible(m, roles, profiles[p])]
                pools[(blk, n, p)] = pool
                row.append(len(pool))
                if len(pool) < POOL_MIN[p]:
                    errs.append(f"{tid} {blk}{n} {roles}: pool {len(pool)} under {p}, minimum {POOL_MIN[p]}")
                elif len(pool) == POOL_MIN[p]:
                    at_min.append(f"{tid} {blk}{n} ({p})")
            flag = "  <- at minimum" if any(row[i] == POOL_MIN[p] for i, p in enumerate(PROFILE_NAMES)) else ""
            lines.append(f"    {tid:<8} {blk}{n:<3} {','.join(roles):<30} "
                         + " ".join(f"{c:>10}" for c in row) + flag)
        for p in PROFILE_NAMES:
            for req, pats in REQUIREMENTS:
                ok = any(pools[(blk, n, p)] and all(set(m["patterns"]) & pats for m in pools[(blk, n, p)])
                         for blk, n, _ in slots)
                if ok:
                    n_guar += 1
                else:
                    errs.append(f"{tid}: no slot guarantees {req} under {p}")
    total = len(lib["slot_templates"]) * len(PROFILE_NAMES) * len(REQUIREMENTS)
    summary = (f"{len(lib['slot_templates'])} templates, 3x3 slots, rounds 4/4/3; "
               f"{n_guar}/{total} requirement guarantees hold; pool minimums 3/2/2 "
               f"({len(at_min)} slot-profile cells exactly at the minimum)")
    return errs, summary, lines


def fits(block_entries, slot_roles, by_id):
    for perm in itertools.permutations(block_entries):
        if all(set(by_id[e["id"]]["roles"]) & set(roles) for e, roles in zip(perm, slot_roles)):
            return True
    return False


def check7(lib, drafts):
    errs = []
    by_id = {m["id"]: m for m in lib["movements"]}
    tpls = {t["id"]: t for t in lib["slot_templates"]}
    fins = {f["id"]: f for f in lib["finishers"]}
    vols = []
    seen = {}
    for w in drafts:
        t = tpls[w["template_id"]]
        if t["day_type"] != w["day_type"]:
            errs.append(f"{w['id']}: template {t['id']} is a {t['day_type']} day, workout is {w['day_type']}")
        if t["finisher"] != (w["finisher"] is not None):
            errs.append(f"{w['id']}: finisher presence does not match template {t['id']}")
        session_patterns = set()
        total = 0
        for b in w["blocks"]:
            tb = next(x for x in t["blocks"] if x["block"] == b["block"])
            if b["rounds"] != tb["rounds"]:
                errs.append(f"{w['id']} {b['block']}: rounds differ from template")
            if not fits(b["movements"], [s["roles"] for s in tb["slots"]], by_id):
                errs.append(f"{w['id']} {b['block']}: movements do not fit template {t['id']} slots")
            adj_weights = set()
            for e in b["movements"]:
                m = by_id[e["id"]]
                session_patterns |= set(m["patterns"])
                if e["load"]["dumbbells"] != m["load"]["dumbbells"]:
                    errs.append(f"{w['id']} {e['id']}: dumbbells {e['load']['dumbbells']} differ "
                                f"from library {m['load']['dumbbells']}")
                if e["target"]["unit"] != m["target"]["unit"] or e["target"]["per_side"] != m["target"]["per_side"]:
                    errs.append(f"{w['id']} {e['id']}: target unit or per_side differs from library")
                if e["load"]["source"] == "adjustable":
                    adj_weights.add(e["load"]["weight_lb_per_dumbbell"])
                seen.setdefault(e["id"], []).append(e)
                total += volume(e, b["rounds"])
            if len(adj_weights) > 1:
                errs.append(f"{w['id']} {b['block']}: more than one adjustable setting {sorted(adj_weights)}")
            if adj_weights and adj_weights != {w["adjustable_setting_lb"]}:
                errs.append(f"{w['id']} {b['block']}: adjustable weight differs from adjustable_setting_lb")
        if w["finisher"] is not None:
            f = fins[w["finisher"]]
            if w["day_type"] not in f["day_types"]:
                errs.append(f"{w['id']}: finisher {f['id']} not allowed on a {w['day_type']} day")
            if set(f["excluded_when_session_has"]) & session_patterns:
                errs.append(f"{w['id']}: finisher {f['id']} excluded by session patterns")
        if total != w["expected_volume_lb"]:
            errs.append(f"{w['id']}: volume {total} != expected {w['expected_volume_lb']}")
        vols.append(f"{w['id']} {total}")
    # library defaults come from the draft: same source and weight, lowest target
    for mid, entries in seen.items():
        m = by_id[mid]
        lo = min(e["target"]["value"] for e in entries)
        if m["target"]["default"] != lo:
            errs.append(f"{mid}: default target {m['target']['default']} is not the lowest draft value {lo}")
        for e in entries:
            if (e["load"]["source"], e["load"]["weight_lb_per_dumbbell"]) != \
                    (m["load"]["default_source"], m["load"]["default_weight_lb"]):
                errs.append(f"{mid}: library default load differs from {e['load']}")
                break
    return errs, f"{len(drafts)} workouts checked against templates; volumes " + ", ".join(vols)


def check8(lib):
    errs = []
    fins = lib["finishers"]
    ids = [f["id"] for f in fins]
    if ids != FINISHER_IDS:
        errs.append(f"finisher ids must be {FINISHER_IDS}, found {ids}")
    by = {f["id"]: f for f in fins}
    for f in fins:
        if sorted(f["day_types"]) != ["pull", "push"]:
            errs.append(f"{f['id']}: day_types must be push and pull")
        lo, hi = FINISHER_SEC
        if not lo <= f["est_seconds"] <= hi:
            errs.append(f"{f['id']}: est_seconds {f['est_seconds']} outside {lo} to {hi}")
        if f["id"] != "D" and f["excluded_when_session_has"]:
            errs.append(f"{f['id']}: only D carries a session exclusion")
        if f["id"] != "B" and f["no_equipment_alternate"]:
            errs.append(f"{f['id']}: only B is the no-equipment alternate")
        if f["id"] != "C" and (f["requires_adjustable"] or f["load"].get("uses_session_adjustable")):
            errs.append(f"{f['id']}: only C uses the session adjustable")
    if "D" in by and by["D"]["excluded_when_session_has"] != ["lunge"]:
        errs.append("D: excluded_when_session_has must be ['lunge']")
    if "B" in by and (by["B"]["no_equipment_alternate"] is not True or by["B"]["load"]["source"] != "bodyweight"):
        errs.append("B: must be a bodyweight no_equipment_alternate")
    if "C" in by and not (by["C"]["requires_adjustable"] is True
                          and by["C"]["load"].get("uses_session_adjustable") is True
                          and by["C"]["load"]["source"] == "adjustable"):
        errs.append("C: must require the adjustable pair and use the session setting")
    wu = lib["warm_up"]
    if wu["rounds"] < 1 or not wu["movements"]:
        errs.append("warm_up must have rounds and movements")
    return errs, (f"{len(fins)} finishers {''.join(ids)}, rule fields checked (D excludes lunge, "
                  f"B no-equipment alternate, C needs adjustable); warm-up {wu['rounds']} rounds x "
                  f"{len(wu['movements'])}")


def duration_sec(w, lib):
    by_id = {m["id"]: m for m in lib["movements"]}
    tm = lib["timing"]
    total = tm["warm_up_sec"]
    for b in w["blocks"]:
        spr = sum(by_id[e["id"]]["seconds_per_round"] for e in b["movements"])
        rest = tm["rest_between_rounds_sec"][b["block"]]
        total += b["rounds"] * (spr + 2 * tm["transition_sec"]) + (b["rounds"] - 1) * rest
    gaps = len(w["blocks"]) - 1 + (1 if w["finisher"] else 0)
    total += tm["between_blocks_sec"] * gaps
    if w["finisher"]:
        total += next(f["est_seconds"] for f in lib["finishers"] if f["id"] == w["finisher"])
    return total


def check9(lib, drafts):
    warns = []
    parts = []
    for w in drafts:
        mins = duration_sec(w, lib) / 60
        parts.append(f"{w['id']} {mins:.1f}")
        lo, hi = DURATION_LONG.get(w["id"], DURATION_MIN)
        if not lo <= mins <= hi:
            warns.append(f"{w['id']}: {mins:.1f} min outside {lo} to {hi}")
    return warns, "estimated minutes: " + ", ".join(parts)


# ----------------------------------------------------------------- main

def load_json(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return json.loads(text), text


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", help="path to program.json for the name comparison in check 2")
    args = ap.parse_args()

    results = []  # (num, title, status, detail, errors, extra_lines, hard)

    def record(num, title, errs, detail, extra=None, hard=True):
        status = "PASS" if not errs else ("FAIL" if hard else "WARN")
        results.append((num, title, status, detail, errs, extra or [], hard))
        print(f"{status}  {num}. {title}: {detail}")
        for e in errs[:20]:
            print(f"        - {e}")
        if len(errs) > 20:
            print(f"        - ... {len(errs) - 20} more")
        for line in extra or []:
            print(line)

    parse_errs = []
    lib = profiles = drafts = None
    lib_text = ""
    for label, path in (("library", LIBRARY_PATH), ("profiles", PROFILES_PATH), ("drafts", DRAFTS_PATH)):
        try:
            data, text = load_json(path)
        except (OSError, ValueError) as exc:
            parse_errs.append(f"{os.path.relpath(path, APP)}: {exc}")
            continue
        if label == "library":
            lib, lib_text = data, text
        elif label == "profiles":
            profiles = data
        else:
            drafts = data

    if parse_errs:
        record(1, "Files and schema", parse_errs, "files do not parse")
    else:
        errs = check1(lib, profiles, drafts)
        record(1, "Files and schema", errs,
               f"3 files parse; {len(lib.get('movements', []))} movements, "
               f"{len(lib.get('slot_templates', []))} templates, {len(lib.get('finishers', []))} finishers, "
               f"{len(profiles) if isinstance(profiles, dict) else 0} profiles, "
               f"{len(drafts) if isinstance(drafts, list) else 0} workouts validated")

    titles = {2: "Movement count and ids", 3: "References", 4: "Content", 5: "Rotation flags",
              6: "Templates and pools", 7: "Draft fit and volume", 8: "Finishers and warm-up",
              9: "Duration (report only)"}
    if results[0][2] != "PASS":
        for n in range(2, 10):
            record(n, titles[n], ["skipped: check 1 failed"], "not run", hard=(n != 9))
    else:
        e, d = check2(lib, args.source)
        record(2, titles[2], e, d)
        e, d = check3(lib, drafts)
        record(3, titles[3], e, d)
        refs_ok = not e
        e, d = check4(lib, lib_text)
        record(4, titles[4], e, d)
        e, d = check5(lib, drafts)
        record(5, titles[5], e, d)
        e, d, lines = check6(lib, profiles)
        record(6, titles[6], e, d, lines)
        if refs_ok:
            e, d = check7(lib, drafts)
            record(7, titles[7], e, d)
            e, d = check8(lib)
            record(8, titles[8], e, d)
            e, d = check9(lib, drafts)
            record(9, titles[9], e, d, hard=False)
        else:
            for n in (7, 8, 9):
                record(n, titles[n], ["skipped: references failed"], "not run", hard=(n != 9))

    hard = [r for r in results if r[6]]
    passed = sum(1 for r in hard if r[2] == "PASS")
    soft = [r for r in results if not r[6]]
    soft_note = ", ".join(f"check {r[0]} {r[2]}" for r in soft)
    print(f"Summary: {passed}/{len(hard)} hard checks passed; {soft_note}")
    return 0 if passed == len(hard) else 1


if __name__ == "__main__":
    sys.exit(main())
