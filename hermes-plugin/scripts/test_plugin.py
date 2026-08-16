#!/usr/bin/env python3
"""Headless test harness for the Tempest for Hermes plugin.

Runs against a throwaway HERMES_HOME so it never touches the real install.
Exercises: atlas bridge (index/context/stats/search), the tempest_context tool
handler, the HTTP dashboard endpoints, and the parallel worktree agent
orchestrator (using a trivial command override so no real LLM is spawned).

Usage:
  python scripts/test_plugin.py [--keep]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent          # <repo>/hermes-plugin
HERMES_SRC = REPO.parent.parent / "hermes-agent"       # source checkout if present
PASS, FAIL = 0, 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")

# ---------------------------------------------------------------------------

def make_sample_repo(tmp):
    proj = tmp / "sample-repo"
    (proj / "src").mkdir(parents=True)
    for name, body in {
        "src/cart.js": (
            "function Cart(items) { this.items = items || []; }\n"
            "Cart.prototype.add = function(product, qty) { this.items.push({product, qty: qty || 1}); return this.total(); };\n"
            "Cart.prototype.total = function() { return this.items.reduce((s, i) => s + i.product.price * i.qty, 0); };\n"
            "Cart.prototype.discount = function(pct) { return this.total() * (1 - pct / 100); };\n"
            "module.exports = Cart;\n"),
        "src/checkout.js": (
            "const Cart = require('./cart');\n"
            "const Product = require('./product');\n"
            "function checkout(c, p) { const cart = new Cart(); for (const x of p) cart.add(new Product(x.name, x.price), x.qty); return { c, subtotal: cart.total(), after: cart.discount(10) }; }\n"
            "module.exports = checkout;\n"),
        "src/product.js": (
            "class Product { constructor(name, price, tax) { this.name = name; this.price = price; this.tax = tax || 0; } netPrice() { return this.price + this.price * this.tax; } }\n"
            "module.exports = Product;\n"),
        "index.js": "const checkout = require('./src/checkout');\nconsole.log(checkout('ann', [{name:'shirt',price:20,qty:2}]));\n",
    }.items():
        (proj / name).write_text(body, encoding="utf-8")
    # Make it a git repo so the worktree orchestrator works.
    subprocess.run(["git", "init", "-q", "-b", "main", str(proj)], check=True)
    subprocess.run(["git", "-C", str(proj), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(proj), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], check=True)
    return proj

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    tmp_root = Path(tempfile.mkdtemp(prefix="tempest-test-"))
    os.environ["HERMES_HOME"] = str(tmp_root)
    os.environ["TEMPEST_REGISTRY"] = str(tmp_root / "projects.json")
    # Point the bridge at THIS repo's runtime (node_modules must be installed).
    os.environ["TEMPEST_RUNTIME_DIR"] = str(REPO / "runtime")

    # Import the plugin __init__.py as a module.
    import importlib.util
    spec = importlib.util.spec_from_file_location("tempest_plugin", REPO / "__init__.py")
    plug = importlib.util.module_from_spec(spec)
    sys.modules["tempest_plugin"] = plug
    if HERMES_SRC.exists():
        sys.path.insert(0, str(HERMES_SRC))
    spec.loader.exec_module(plug)
    print("plugin module imported OK")

    proj = make_sample_repo(tmp_root)

    # --- 1. Bridge: version / index / stats / context / search ---
    print("\n[1] atlas bridge")
    v = plug._bridge_cmd("version")
    check("version", v.get("ok"), str(v))
    idx = plug._bridge_cmd("index", {"project": str(proj)})
    check("index", idx.get("ok") and idx.get("stats", {}).get("nodeCount", 0) >= 5, str(idx)[:200])
    st = plug._bridge_cmd("stats", {"project": str(proj)})
    check("stats", st.get("ok") and st.get("stats", {}).get("fileCount") == 4, str(st)[:200])
    ctx = plug._bridge_cmd("context", {"project": str(proj), "query": "how does the cart apply a discount?"})
    check("context", ctx.get("ok") and ("Code Context" in ctx.get("markdown", "") or ctx.get("summary")), str(ctx)[:200])
    projs = plug._bridge_cmd("projects")
    check("projects lists repo", projs.get("ok") and any(p["name"] == "sample-repo" for p in projs.get("projects", [])))

    # --- 2. tempest_context tool handler ---
    print("\n[2] tempest_context tool")
    plug._set_active_project(str(proj))
    out = plug._tool_handler({"query": "cart discount total"})
    check("tool returns context", isinstance(out, str) and len(out) > 50 and "Code Context" in out, out[:200])
    out2 = plug._tool_handler({"query": ""})
    check("tool rejects empty query", "query is required" in out2)

    # --- 3. HTTP dashboard endpoints ---
    print("\n[3] HTTP endpoints")
    import socket
    import threading
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    srv.close()
    # Run the real server on a test port.
    plug._port = lambda: port
    plug._ensure_server()
    # wait for listener
    ok = False
    for _ in range(50):
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=0.5)
            s.close(); ok = True; break
        except Exception:
            time.sleep(0.1)
    check("server listening", ok, "port " + str(port))

    def hit(method, path, body=None):
        url = f"http://127.0.0.1:{port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return str(r.status), json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            return str(e.code), json.loads(e.read().decode("utf-8", "replace"))

    # /health
    st, body = hit("GET", "/health")
    check("/health", st == "200" and body.get("ok"), st)
    # /state
    st, body = hit("GET", "/state")
    check("/state lists projects", st == "200" and len(body.get("projects", [])) == 1, st)
    # /api/context
    st, body = hit("POST", "/api/context", {"project": str(proj), "query": "cart discount"})
    check("/api/context", st == "200" and body.get("ok"), (st, str(body)[:150]))
    # /api/stats
    st, body = hit("GET", f"/api/stats?project={proj}")
    check("/api/stats", st == "200" and body.get("ok") and body.get("stats", {}).get("fileCount") == 4, st)
    # /api/index sets active project
    st, body = hit("POST", "/api/index", {"project": str(proj)})
    check("/api/index", st == "200" and body.get("ok") and plug._get_active_project() == str(proj), (st, str(body)[:120]))
    # /web static
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as r:
        st = str(r.status)
        body = r.read().decode("utf-8", "replace")
    check("/ serves dashboard", st == "200" and "Tempest for Hermes" in body, st)

    # --- 4. Worktree orchestrator (trivial command override) ---
    print("\n[4] parallel worktree agent orchestration")
    os.environ["TEMPEST_AGENT_CMD"] = "{project}__DELIM__{prompt}"
    # Spawn a session directly (bypasses HTTP for clarity) using a trivial argv.
    sess_r = plug._spawn_agent(str(proj), "tester", "hello", command=["git", "--version"])
    check("spawn ok", sess_r.get("ok") and "session" in sess_r, str(sess_r)[:200])
    sid = sess_r["session"]["id"]
    s = plug._sessions.get(sid)
    # wait for completion (short poll)
    for _ in range(40):
        s = plug._sessions.get(sid)
        if s and s["status"] == "done":
            break
        time.sleep(0.25)
    check("agent completed", s and s["status"] == "done" and s.get("exit_code") == 0, str(s))
    # worktree + branch created
    wt = Path(s["worktree"])
    check("worktree exists", wt.exists() and (wt / "src").exists())
    rc, out = plug._git(["branch", "--list", s["branch"]], str(proj))
    check("branch exists", rc == 0 and s["branch"] in out, out)
    # log captured
    logtxt = (wt / "agent.log").read_text(encoding="utf-8", errors="replace")
    check("agent log captured", "git version" in logtxt, logtxt[:200])
    # diff endpoint works on an agent that changed nothing
    d = plug._agent_diff(s)
    check("agent diff returns (no changes ok)", isinstance(d, str))

    # --- 5. v1.1 features: persistent bridge, cwd resolution, staleness, kill, merge/cleanup ---
    print("\n[5] v1.1 features")
    # Persistent bridge: one Node process serves every call.
    pid1 = plug._bridge.pid()
    check("persistent bridge alive", pid1 is not None, str(pid1))
    plug._bridge_cmd("version")
    pid2 = plug._bridge.pid()
    check("bridge process reused across calls", pid2 == pid1, f"{pid1} vs {pid2}")
    st = plug._bridge_state()
    check("bridge state reports persistent", st.get("mode") == "persistent" and st.get("pid") == pid1, str(st))

    # cwd-aware project resolution.
    plug._set_active_project("")
    os.chdir(str(proj))
    resolved = plug._resolve_project(None)
    check("cwd-aware resolution finds sample-repo", resolved == str(proj), str(resolved))
    os.chdir(REPO)
    # active project still wins when set; explicit arg wins over everything.
    plug._set_active_project(str(proj))
    check("active project wins over cwd", plug._resolve_project(None) == str(proj))
    check("explicit project wins", plug._resolve_project("C:/nope") == "C:/nope")

    # Staleness: clean repo -> no resync; dirty repo -> flagged.
    plug._stale_checked.clear()
    check("clean repo not stale", plug._needs_resync(str(proj)) is False)
    (proj / "src" / "untracked.py").write_text("x = 1\n", encoding="utf-8")
    plug._stale_checked.clear()
    check("dirty repo flagged stale", plug._needs_resync(str(proj)) is True)
    (proj / "src" / "untracked.py").unlink()

    # Kill a running agent (sys.executable instead of `sleep` so PATH quirks
    # on Windows can't break the spawn; taskkill /T takes the whole tree).
    k = plug._spawn_agent(str(proj), "killer", "hi",
                          command=[sys.executable, "-c", "import time; time.sleep(60)"])
    kid = k["session"]["id"]
    time.sleep(1.5)
    kr = plug._kill_agent(kid)
    check("kill ok", kr.get("ok"), str(kr))
    ks = plug._sessions.get(kid)
    check("session killed", ks and ks["status"] == "killed", str(ks))
    check("pid recorded", ks and ks.get("pid") is not None, str(ks))

    # Merge + cleanup a successful agent.
    m = plug._spawn_agent(
        str(proj), "merger", "hi",
        command=["git", "-c", "user.email=t@t", "-c", "user.name=t",
                 "commit", "--allow-empty", "-qm", "test-change"],
    )
    mid = m["session"]["id"]
    ms = plug._sessions.get(mid)
    for _ in range(40):
        ms = plug._sessions.get(mid)
        if ms and ms["status"] != "running":
            break
        time.sleep(0.25)
    mr = plug._agent_merge(ms)
    check("merge ok", mr.get("ok") and mr.get("merged"), str(mr))
    merged_s = plug._sessions.get(mid)
    check("session merged", merged_s["status"] == "merged", str(merged_s))
    mwt = Path(merged_s["worktree"])
    cr = plug._agent_cleanup(merged_s)
    check("cleanup ok", cr.get("ok") and "worktree removed" in cr.get("message", ""), str(cr))
    check("worktree removed", not mwt.exists())
    rc, out = plug._git(["branch", "--list", merged_s["branch"]], str(proj))
    check("branch deleted", rc == 0 and merged_s["branch"] not in out, out)

    # Session process-alive checks (used to reap orphans after a restart).
    check("dead pid not alive", plug._session_process_alive({"pid": 999999999}) is False)
    alive_proc = plug._spawn_agent(str(proj), "alive", "hi",
                                   command=[sys.executable, "-c", "import time; time.sleep(30)"])
    alive_sid = alive_proc["session"]["id"]
    # pid lands ~0.3s after spawn (worker thread); poll for it, then assert.
    for _ in range(20):
        if (plug._sessions.get(alive_sid) or {}).get("pid"):
            break
        time.sleep(0.25)
    check("live pid alive", plug._session_process_alive(plug._sessions.get(alive_sid)) is True)
    kr2 = plug._kill_agent(alive_sid)
    check("live agent kill ok", kr2.get("ok"), str(kr2))
    check("live agent killed for cleanup", plug._sessions.get(alive_sid)["status"] == "killed")

    # --- summary ---
    print(f"\n===== {PASS} passed, {FAIL} failed =====")
    if not args.keep:
        shutil.rmtree(tmp_root, ignore_errors=True)
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
