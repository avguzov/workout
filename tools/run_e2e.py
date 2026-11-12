#!/usr/bin/env python3
"""Scripted end-to-end run of the app in headless Edge at phone size.

Usage, from app/:  python tools/run_e2e.py

Serves app/ on a free 127.0.0.1 port and opens /tests/e2e.html, which loads the real app
(index.html) in a 390 x 844 iframe and drives it through its DOM. The page POSTs its results
to /__results. Two Edge processes share one temporary profile:

  phase 1  fresh profile: first session, full logging with edits, summary volume, reload,
           sessions until Today shows last-time numbers, mid-workout reload
  phase 2  a second Edge process on the same profile: every session and the workout in
           progress survived the restart, and Resume lands on the same block and round
  swap     a third Edge process on its own fresh profile: the Swap sheet on Today
  settings each name in FRESH_PHASES runs next, every one on its own fresh profile: the tab
           row, Settings (equipment guard, default length, swap switch), and backup export
           and import
  history  History and Progress: empty states, a seeded history built with flow.js, the list,
           the detail view, the charts against stats.js, and the 375 px layout

Edge is killed and the profile removed on every exit path, including timeouts and Ctrl+C.
Exit codes: 0 every assertion passed, 1 some assertion failed, 2 timed out, 3 Edge not found.
Standard library only. Set EDGE_PATH to override the Edge location.
"""

import http.server
import json
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from pathlib import Path

sys.dont_write_bytecode = True  # no __pycache__ in the repo from importing run_tests
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_tests import Handler as BaseHandler, find_edge, kill_edge, remove_profile  # noqa: E402

APP_DIR = Path(__file__).resolve().parent.parent
PHASE_TIMEOUT_SEC = {1: 480, 2: 120}
PHASE_TIMEOUT_SEC["swap"] = 180  # swap phase, on its own fresh profile
# Named phases that each get their own new profile, run in order after the swap phase.
# To add one: give it a timeout, append its name here, and dispatch on PHASE_NAME in
# tests/e2e.js main().
PHASE_TIMEOUT_SEC["settings"] = 300  # tabs, Settings, and backup
PHASE_TIMEOUT_SEC["history"] = 240  # History and Progress
FRESH_PHASES = ["settings", "history"]
WINDOW = "390,844"


class Handler(BaseHandler):
    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length)

    def do_GET(self):
        if self.path.split("?")[0] == "/__expect":
            body = json.dumps(self.server.expect or {}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/__log":
            self.server.log.append(self._body().decode("utf-8", "replace"))
            self.send_response(204)
            self.end_headers()
            return
        if self.path != "/__results":
            self.send_error(404)
            return
        body = self._body()
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception as exc:  # malformed payload still ends the phase
            data = {"results": [{"name": "results payload", "ok": False, "message": str(exc)}]}
        self.send_response(204)
        self.end_headers()
        self.server.results = data
        self.server.done.set()


def run_phase(edge, profile_dir, port, phase, server):
    """Start Edge on the shared profile, wait for this phase's results, then kill Edge."""
    server.results = None
    server.done.clear()
    url = f"http://127.0.0.1:{port}/tests/e2e.html?phase={phase}"
    args = [
        edge,
        "--headless=new",
        f"--user-data-dir={profile_dir}",
        f"--window-size={WINDOW}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        url,
    ]
    proc = None
    leftover = ""
    try:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        got = server.done.wait(PHASE_TIMEOUT_SEC[phase])
    finally:
        leftover = kill_edge(proc, profile_dir)
    return got, leftover


def main():
    edge = find_edge()
    if not edge:
        print("Edge not found. Set EDGE_PATH to msedge.exe.", file=sys.stderr)
        return 3

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(APP_DIR)))
    server.done = threading.Event()
    server.results = None
    server.expect = None
    server.log = []
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile_dir = tempfile.mkdtemp(prefix="app-e2e-edge-")
    phases = {}
    leftovers = []
    timeout_msg = None
    started = time.time()
    try:
        for phase in (1, 2):
            if phase == 2:
                server.expect = (phases.get(1) or {}).get("expect")
                if not server.expect:
                    break
            got, leftover = run_phase(edge, profile_dir, port, phase, server)
            if leftover:
                leftovers.append(f"phase {phase}: {leftover}")
            if not got or server.results is None:
                timeout_msg = (f"TIMEOUT: phase {phase} sent no results within "
                               f"{PHASE_TIMEOUT_SEC[phase]} seconds")
                break
            phases[phase] = server.results
        if not timeout_msg:
            # Swap phase: its own fresh profile, so phases 1 and 2 keep theirs.
            swap_profile = tempfile.mkdtemp(prefix="app-e2e-swap-")
            try:
                got, leftover = run_phase(edge, swap_profile, port, "swap", server)
            finally:
                if not remove_profile(swap_profile):
                    leftovers.append(f"swap profile left at {swap_profile}")
            if leftover:
                leftovers.append(f"phase swap: {leftover}")
            if not got or server.results is None:
                timeout_msg = f"TIMEOUT: phase swap sent no results within {PHASE_TIMEOUT_SEC['swap']} seconds"
            else:
                phases["swap"] = server.results
        for name in FRESH_PHASES:
            if timeout_msg:
                break
            fresh_profile = tempfile.mkdtemp(prefix=f"app-e2e-{name}-")
            try:
                got, leftover = run_phase(edge, fresh_profile, port, name, server)
            finally:
                if not remove_profile(fresh_profile):
                    leftovers.append(f"{name} profile left at {fresh_profile}")
            if leftover:
                leftovers.append(f"phase {name}: {leftover}")
            if not got or server.results is None:
                timeout_msg = f"TIMEOUT: phase {name} sent no results within {PHASE_TIMEOUT_SEC[name]} seconds"
            else:
                phases[name] = server.results
    finally:
        server.shutdown()
        server.server_close()
        removed = remove_profile(profile_dir)
    elapsed = time.time() - started

    results = []
    for phase in (1, 2):
        for r in (phases.get(phase) or {}).get("results") or []:
            results.append((phase, r))
    for r in (phases.get("swap") or {}).get("results") or []:
        results.append(("swap", r))
    for name in FRESH_PHASES:
        for r in (phases.get(name) or {}).get("results") or []:
            results.append((name, r))
    if 1 in phases and 2 not in phases and not timeout_msg:
        results.append((2, {"name": "phase 2 ran", "ok": False,
                            "message": "skipped because phase 1 produced no expectations"}))
    results.append((0, {"name": "cleanup: Edge stopped and temporary profile removed",
                        "ok": not leftovers and removed,
                        "message": "; ".join(leftovers) + ("" if removed else f" profile left at {profile_dir}")}))

    for phase, r in results:
        ok = bool(r.get("ok"))
        line = ("PASS  " if ok else "FAIL  ") + (f"[{phase}] " if phase else "") + str(r.get("name"))
        if not ok and r.get("message"):
            line += "  -- " + str(r.get("message"))[:600]
        print(line)

    print()
    for phase in (1, 2):
        for k, v in ((phases.get(phase) or {}).get("info") or {}).items():
            print(f"info [{phase}] {k}: {v}")
    for k, v in ((phases.get("swap") or {}).get("info") or {}).items():
        print(f"info [swap] {k}: {v}")
    for name in FRESH_PHASES:
        for k, v in ((phases.get(name) or {}).get("info") or {}).items():
            print(f"info [{name}] {k}: {v}")

    passed = sum(1 for _, r in results if r.get("ok"))
    failed = len(results) - passed
    if timeout_msg or failed:
        print()
        print("last driver log lines:")
        for line in server.log[-25:]:
            print("  " + line[:300])
    print()
    print(f"elapsed: {elapsed:.1f} s")
    if timeout_msg:
        print(timeout_msg, file=sys.stderr)
        print(f"TOTAL: {passed} passed, {failed} failed, timed out")
        return 2
    print(f"TOTAL: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
