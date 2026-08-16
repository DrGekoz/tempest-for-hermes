"""tempest-for-hermes — a Hermes plugin that brings Tempest's Token Intelligence
and parallel worktree-isolated agent orchestration to Hermes agents.

This is the Hermes plugin half of the "Tempest for Hermes" fork. It reuses
Tempest's core system — the ``@usetempest/atlas`` semantic code knowledge graph
("Token Intelligence") — as a local, shared codebase index, and gives Hermes:

* a ``tempest_context`` tool so an agent pulls *surgical* context for a task
  from the shared graph instead of reading the whole codebase (fewer tokens,
  fewer tool calls — the Tempest claim, now inside Hermes);
* an HTTP dashboard (``web/index.html``) showing indexed projects + graph
  stats, a context playground, and a panel that spawns N parallel Hermes agents
  in isolated git worktrees/branches (blow-the-blast-radius-to-zero isolation
  via ``git worktree``), with per-agent status, logs and a diff for review.

Nothing here mutates the conversation or the prompt cache: context is pulled
explicitly through the tool, exactly like Tempest's surgical-context model.

Layout
------
<plugin>/
  __init__.py       this file
  plugin.yaml       manifest (name, version, hooks)
  web/              dashboard frontend
  runtime/          node runtime (package.json + atlas-bridge.mjs wrapping
                    @usetempest/atlas); ``npm install`` once during setup
  scripts/          setup helpers
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants & config
# ---------------------------------------------------------------------------

DEFAULT_PORT = 8124
STATE_DIR_NAME = "tempest-for-hermes"
SESSIONS_FILE = "sessions.json"
ACTIVE_PROJECT_FILE = "active_project.txt"

# Timeouts (seconds) for the atlas bridge subprocess per command.
_BRIDGE_TIMEOUTS = {
    "version": 20,
    "projects": 60,
    "stats": 60,
    "search": 60,
    "context": 120,
    "index": 600,  # a first full index of a big repo can take a while
}

# Candidate Python interpreters that can run the Hermes CLI (``-m hermes_cli.main``).
_HERMES_PY_CANDIDATES = [
    os.environ.get("TEMPEST_HERMES_PY", ""),
    str(Path.home() / "AppData/Roaming/uv/tools/hermes-agent/Scripts/python.exe"),
    str(Path.home() / "AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe"),
]

_server: Optional[threading.Thread] = None
_started = False


def _plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def _state_dir() -> Path:
    d = get_hermes_home() / STATE_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def _port() -> int:
    try:
        from hermes_cli.config import cfg_get, load_config
        return int(cfg_get(load_config(), "plugins", "entries", "tempest-for-hermes", "port") or DEFAULT_PORT)
    except Exception:
        return DEFAULT_PORT


# ---------------------------------------------------------------------------
# Atlas bridge (Node) invocation
# ---------------------------------------------------------------------------

def _node() -> Optional[str]:
    return shutil.which("node") or None


def _runtime_dir() -> Path:
    return _plugin_dir() / "runtime"


def _bridge_cmd(cmd: str, args: Optional[dict] = None) -> Dict[str, Any]:
    """Run ``node atlas-bridge.mjs <cmd> '<json>'`` and return its JSON object."""
    node = _node()
    if not node:
        return {"ok": False, "error": "node is not installed (required for the atlas bridge)"}
    bridge = _runtime_dir() / "atlas-bridge.mjs"
    if not bridge.exists():
        return {"ok": False, "error": f"atlas bridge not found: {bridge}"}
    # The runtime node_modules must be installed (npm install once in runtime/).
    proc = subprocess.run(
        [node, str(bridge), cmd, json.dumps(args or {})],
        cwd=str(_runtime_dir()),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=_BRIDGE_TIMEOUTS.get(cmd, 120),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )
    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "").strip()[-2000:], "returncode": proc.returncode}
    try:
        return json.loads(out.splitlines()[-1])
    except Exception as e:
        return {"ok": False, "error": f"bad bridge output: {e}\n{out[-2000:]}", "returncode": proc.returncode}


def _bridge_ok(result: Dict[str, Any]) -> bool:
    return bool(result.get("ok"))


# ---------------------------------------------------------------------------
# Hermes CLI resolution (for the parallel-agent orchestrator)
# ---------------------------------------------------------------------------

def _hermes_python() -> Optional[str]:
    for cand in _HERMES_PY_CANDIDATES:
        if cand and Path(cand).exists():
            return cand
    return None


def _default_agent_command(project: str, prompt: str) -> List[str]:
    """Build the argv for one agent run in an isolated worktree.

    Defaults to invoking the Hermes CLI as ``python -X utf8 -m hermes_cli.main
    chat -q <prompt>`` from inside the worktree. Override with the env var
    TEMPEST_AGENT_CMD (a template string where ``{project}`` and ``{prompt}``
    are substituted) — useful for testing the orchestrator with a trivial
    command.
    """
    override = os.environ.get("TEMPEST_AGENT_CMD")
    if override:
        return override.format(project=project, prompt=prompt).split(" ")
    py = _hermes_python()
    if py:
        return [py, "-X", "utf8", "-m", "hermes_cli.main", "chat", "-q", prompt]
    return ["hermes", "chat", "-q", prompt]


# ---------------------------------------------------------------------------
# Project registry + active project
# ---------------------------------------------------------------------------

def _projects() -> List[dict]:
    return _bridge_cmd("projects").get("projects", [])


def _get_active_project() -> Optional[str]:
    f = _state_dir() / ACTIVE_PROJECT_FILE
    if f.exists():
        p = f.read_text(encoding="utf-8").strip()
        if p:
            return p
    return None


def _set_active_project(path_: str) -> None:
    (_state_dir() / ACTIVE_PROJECT_FILE).write_text(path_, encoding="utf-8")


def _resolve_project(requested: Optional[str]) -> Optional[str]:
    """Resolve the project for a request: explicit path, active project, or the
    first indexed project (falling back to walking up from cwd)."""
    if requested:
        return requested
    active = _get_active_project()
    if active:
        return active
    projs = _projects()
    if projs:
        return projs[0]["path"]
    return None


# ---------------------------------------------------------------------------
# Session / orchestrator state
# ---------------------------------------------------------------------------

class _SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.sessions: Dict[str, dict] = {}
        self._load()

    def _file(self) -> Path:
        return _state_dir() / SESSIONS_FILE

    def _load(self) -> None:
        try:
            if self._file().exists():
                data = json.loads(self._file().read_text(encoding="utf-8"))
                self.sessions = {k: v for k, v in data.items() if not self._done_since(v)}
        except Exception as e:
            logger.warning("tempest sessions load failed: %s", e)
            self.sessions = {}

    @staticmethod
    def _done_since(s: dict, keep_min: int = 30) -> bool:
        if s.get("status") in ("done", "failed", "killed") and s.get("finished"):
            try:
                return time.time() - float(s["finished"]) > keep_min * 60
            except Exception:
                return False
        return False

    def all(self) -> List[dict]:
        with self._lock:
            return list(self.sessions.values())

    def get(self, sid: str) -> Optional[dict]:
        with self._lock:
            return self.sessions.get(sid)

    def put(self, session: dict) -> None:
        with self._lock:
            self.sessions[session["id"]] = session
        self._persist()

    def remove(self, sid: str) -> bool:
        with self._lock:
            ok = self.sessions.pop(sid, None) is not None
        self._persist()
        return ok

    def _persist(self) -> None:
        try:
            self._file().write_text(json.dumps(self.sessions, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning("tempest sessions persist failed: %s", e)


_sessions = _SessionStore()


def _git(args: List[str], cwd: str, timeout: int = 60) -> tuple[int, str]:
    proc = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _worktrees_dir(project: str) -> Path:
    base = _state_dir() / "worktrees" / _safe_name(project)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _safe_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)[:64]


def _spawn_agent(project: str, name: str, prompt: str, command: Optional[List[str]] = None) -> dict:
    import uuid
    sid = uuid.uuid4().hex[:12]
    branch = f"tempest-{_safe_name(name)}-{sid[:6]}"
    wt = _worktrees_dir(project) / branch

    # Create an isolated worktree + branch off the project's default branch.
    rc, out = _git(["worktree", "add", str(wt), "-b", branch], project)
    if rc != 0:
        return {"ok": False, "error": f"git worktree add failed: {out.strip()[:1500]}"}

    argv = command if command is not None else _default_agent_command(project, prompt)
    log_path = wt / "agent.log"

    session = {
        "id": sid,
        "name": name,
        "project": project,
        "branch": branch,
        "worktree": str(wt),
        "prompt": prompt,
        "command": argv,
        "status": "running",
        "started": time.time(),
        "finished": None,
        "exit_code": None,
        "log_path": str(log_path),
    }
    _sessions.put(session)

    def run() -> None:
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(wt),
                stdout=open(log_path, "w", encoding="utf-8"),
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
            code = proc.wait()
        except Exception as e:  # noqa: BLE001
            code = -1
            try:
                with open(log_path, "a", encoding="utf-8") as f:
                    f.write(f"\n[orchestrator] spawn failed: {e}\n")
            except Exception:  # noqa: BLE001
                pass
        cur = _sessions.get(sid)
        if cur:
            cur["status"] = "done" if code == 0 else ("failed" if code != -1 else "failed")
            cur["exit_code"] = code
            cur["finished"] = time.time()
            _sessions.put(cur)

    t = threading.Thread(target=run, daemon=True, name=f"tempest-agent-{sid}")
    t.start()
    return {"ok": True, "session": session}


def _agent_diff(session: dict) -> str:
    project, branch, wt = session.get("project"), session.get("branch"), session.get("worktree")
    if not project or not branch or not wt or not Path(wt).exists():
        return "(worktree missing)"
    rc, out = _git(["diff", f"main...{branch}", "--stat"], project)
    if rc != 0:
        rc, out = _git(["diff", f"HEAD...{branch}", "--stat"], project)
    return out.strip() or "(no changes)"


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class _Handler:
    def __init__(self) -> None:
        self.port = _port()

    def handle(self, conn: socket.socket) -> None:
        # Read until the request is complete: headers + the full body (a single
        # recv() can return headers before the body lands in a later segment).
        buf = b""
        content_length = 0
        conn.settimeout(15)
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                # Once headers are in, learn the expected body length.
                if content_length == 0 and b"\r\n\r\n" in buf:
                    head = buf.split(b"\r\n\r\n", 1)[0].decode("utf-8", "replace")
                    for line in head.split("\r\n"):
                        low = line.lower()
                        if low.startswith("content-length:"):
                            try:
                                content_length = int(line.split(":", 1)[1].strip())
                            except ValueError:
                                content_length = 0
                # Headers + body fully received?
                if b"\r\n\r\n" in buf:
                    header_end = buf.index(b"\r\n\r\n") + 4
                    if content_length == 0:
                        break  # no request body expected (e.g. GET)
                    if len(buf) >= header_end + content_length:
                        break
                if len(buf) > 1 << 20:  # 1 MiB safety cap
                    break
        except socket.timeout:
            pass
        except Exception:
            conn.close()
            return
        try:
            text = buf.decode("utf-8", "replace")
            head = text.split("\r\n\r\n", 1)[0]
            lines = head.split("\r\n")
            if not lines:
                conn.close()
                return
            parts = lines[0].split(" ")
            method = parts[0] if len(parts) > 0 else "GET"
            target = parts[1] if len(parts) > 1 else "/"
            body_raw = text.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in text else ""
            self.dispatch(conn, method, target, body_raw)
        except Exception as e:  # noqa: BLE001
            logger.exception("tempest server handler error: %s", e)
            self._respond(conn, 500, "application/json", json.dumps({"ok": False, "error": str(e)}))
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def _respond(self, conn, code: int, ctype: str, body: str) -> None:
        data = body.encode("utf-8")
        reason = {200: "OK", 404: "Not Found", 400: "Bad Request", 500: "Internal Server Error", 405: "Method Not Allowed"}.get(code, "OK")
        header = (
            f"HTTP/1.1 {code} {reason}\r\n"
            "Content-Type: " + ctype + "\r\n"
            "Cache-Control: no-store\r\n"
            "Content-Length: " + str(len(data)) + "\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("utf-8")
        try:
            conn.sendall(header + data)
        except Exception:  # noqa: BLE001
            pass

    def _json(self, conn, code: int, obj: Any) -> None:
        self._respond(conn, code, "application/json", json.dumps(obj))

    def _html(self, conn, body: str) -> None:
        self._respond(conn, 200, "text/html; charset=utf-8", body)

    def _serve_web(self, conn, target: str) -> None:
        web_dir = _plugin_dir() / "web"
        rel = target.lstrip("/")
        if not rel or rel.endswith("/"):
            rel = "index.html"
        if "/" in rel:
            rel = rel.split("/", 1)[-1]
        p = (web_dir / rel).resolve()
        if web_dir.resolve() not in p.parents and p != web_dir.resolve():
            self._respond(conn, 404, "text/plain", "not found")
            return
        if not p.exists() or not p.is_file():
            self._respond(conn, 404, "text/plain", "not found")
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(p.suffix.lower(), "application/octet-stream")
        try:
            self._respond(conn, 200, ctype, p.read_text(encoding="utf-8"))
        except Exception:
            self._respond(conn, 500, "text/plain", "read error")

    def _read_body(self, body_raw: str) -> dict:
        try:
            return json.loads(body_raw) if body_raw.strip() else {}
        except Exception:
            return {}

    def dispatch(self, conn, method: str, target: str, body_raw: str) -> None:
        # Static web + state
        if method == "GET" and target in ("/", "/index.html"):
            return self._serve_web(conn, "/index.html")
        if method == "GET" and target.startswith("/web/"):
            return self._serve_web(conn, target[len("/web/"):])
        if method == "GET" and target == "/state":
            projs = []
            try:
                projs = _projects()
            except Exception as e:  # noqa: BLE001
                projs = []
            return self._json(conn, 200, {
                "ok": True,
                "version": _version(),
                "port": self.port,
                "node": bool(_node()),
                "bridge_ready": bool(_node()),
                "projects": projs,
                "activeProject": _get_active_project(),
                "sessions": _sessions.all(),
            })
        if method == "GET" and target == "/health":
            return self._json(conn, 200, {"ok": True, "service": "tempest-for-hermes"})

        # JSON API
        if method == "POST" and target == "/api/index":
            b = self._read_body(body_raw)
            r = _bridge_cmd("index", {"project": b.get("project"), "sync": b.get("sync", True)})
            if _bridge_ok(r) and b.get("set_active", True):
                _set_active_project(r.get("project") or b.get("project"))
            return self._json(conn, 200 if _bridge_ok(r) else 500, r)
        if method == "POST" and target == "/api/context":
            b = self._read_body(body_raw)
            project = _resolve_project(b.get("project"))
            if not project:
                return self._json(conn, 400, {"ok": False, "error": "no project (index one or set active project)"})
            r = _bridge_cmd("context", {
                "project": project, "query": b.get("query"),
                "maxNodes": b.get("maxNodes"), "maxCodeBlocks": b.get("maxCodeBlocks"),
                "format": b.get("format", "markdown"),
            })
            return self._json(conn, 200 if _bridge_ok(r) else 500, r)
        if method == "GET" and target.startswith("/api/stats"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(target).query)
            project = q.get("project", [None])[0] or _resolve_project(None)
            if not project:
                return self._json(conn, 400, {"ok": False, "error": "no project"})
            r = _bridge_cmd("stats", {"project": project})
            return self._json(conn, 200 if _bridge_ok(r) else 500, r)
        if method == "GET" and target.startswith("/api/search"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(target).query)
            project = q.get("project", [None])[0] or _resolve_project(None)
            query = q.get("query", [""])[0]
            if not project:
                return self._json(conn, 400, {"ok": False, "error": "no project"})
            r = _bridge_cmd("search", {"project": project, "query": query, "limit": int(q.get("limit", ["10"])[0])})
            return self._json(conn, 200 if _bridge_ok(r) else 500, r)
        if method == "GET" and target.startswith("/api/projects"):
            r = _bridge_cmd("projects")
            return self._json(conn, 200 if _bridge_ok(r) else 500, r)

        # Agent orchestration
        if method == "POST" and target == "/api/agents":
            b = self._read_body(body_raw)
            project = b.get("project") or _resolve_project(None)
            if not project:
                return self._json(conn, 400, {"ok": False, "error": "no project"})
            tasks = b.get("tasks") or [{"name": "agent", "prompt": b.get("prompt") or ""}]
            command = b.get("command")  # optional argv override (tests / custom agents)
            spawned = []
            for t in tasks:
                if not (t.get("prompt") or "").strip():
                    continue
                cmd = None
                if command:
                    cmd = command if isinstance(command, list) else command.split(" ")
                r = _spawn_agent(project, t.get("name", "agent"), t["prompt"], cmd)
                spawned.append(r)
            return self._json(conn, 200, {"ok": True, "spawned": spawned})
        if method == "GET" and target.startswith("/api/agents/status"):
            return self._json(conn, 200, {"ok": True, "sessions": _sessions.all()})
        if method == "GET" and target.startswith("/api/agents"):
            rest = target[len("/api/agents/"):].split("/")
            sid, action = rest[0], (rest[1] if len(rest) > 1 else "status")
            s = _sessions.get(sid)
            if not s:
                return self._json(conn, 404, {"ok": False, "error": "session not found"})
            if action == "log":
                try:
                    log_txt = Path(s["log_path"]).read_text(encoding="utf-8")[-6000:]
                except Exception:
                    log_txt = ""
                return self._json(conn, 200, {"ok": True, "id": sid, "log": log_txt})
            if action == "diff":
                return self._json(conn, 200, {"ok": True, "id": sid, "diff": _agent_diff(s)})
            return self._json(conn, 200, {"ok": True, "session": s})
        if method == "POST" and target.startswith("/api/active-project"):
            b = self._read_body(body_raw)
            _set_active_project(b.get("project") or "")
            return self._json(conn, 200, {"ok": True})

        self._respond(conn, 404, "text/plain", "not found")


def _version() -> str:
    try:
        from hermes_cli.config import cfg_get, load_config
        return cfg_get(load_config(), "plugins", "entries", "tempest-for-hermes", "version") or "1.0.0"
    except Exception:
        return "1.0.0"


def _serve_forever() -> None:
    port = _port()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind(("127.0.0.1", port))
    except OSError:
        # Another Hermes process is already serving — nothing to do.
        logger.info("tempest-for-hermes: port %s already bound; skipping server", port)
        return
    srv.listen(64)
    srv.settimeout(1.0)
    handler = _Handler()
    logger.info("tempest-for-hermes dashboard listening on http://127.0.0.1:%s", port)
    while True:
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        handler.handle(conn)


def _ensure_server() -> None:
    global _started
    if _started:
        return
    _started = True
    t = threading.Thread(target=_serve_forever, daemon=True, name="tempest-server")
    t.start()


# ---------------------------------------------------------------------------
# Tool: tempest_context
# ---------------------------------------------------------------------------

def _tool_handler(args: dict, **kw: Any) -> str:
    """Pull surgical context for a task from the shared code knowledge graph."""
    query = (args.get("query") or "").strip()
    if not query:
        return json.dumps({"ok": False, "error": "query is required"})
    project = _resolve_project(args.get("project"))
    if not project:
        indexed = [p["name"] for p in _projects()]
        hint = "indexed projects: " + (", ".join(indexed) if indexed else "none yet")
        return json.dumps({"ok": False, "error": f"no project set — {hint}"})
    r = _bridge_cmd("context", {
        "project": project,
        "query": query,
        "maxCodeBlocks": args.get("maxCodeBlocks") or 8,
        "format": "markdown",
    })
    if not _bridge_ok(r):
        return json.dumps({"ok": False, "error": r.get("error"), "project": project})
    # Prefer the markdown context; fall back to the JSON summary.
    body = r.get("markdown") or (r.get("summary") or "")
    stats = r.get("stats") or {}
    header = f"[tempest_context] project={r.get('project')} nodes={stats.get('nodeCount')} files={stats.get('fileCount')}\n"
    if not body:
        body = json.dumps({"summary": r.get("summary"), "relatedFiles": r.get("relatedFiles")})
    return header + body


_TOOL_SCHEMA = {
    "name": "tempest_context",
    "description": (
        "Pull surgical, token-cheap context for a task from the Tempest code knowledge graph "
        "(atlas) for an indexed project, instead of reading the whole codebase. Use when you "
        "need to understand a specific function, file, or area of a codebase before editing it. "
        "Returns markdown context (entry points, related files, code blocks) plus a stats header."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The task or question to find relevant code context for.",
            },
            "project": {
                "type": "string",
                "description": "Optional absolute path to an indexed project. Defaults to the active project.",
            },
            "maxCodeBlocks": {
                "type": "integer",
                "description": "Optional max code blocks to include (default 8).",
            },
        },
        "required": ["query"],
    },
}


def register(ctx) -> None:
    """Hermes plugin entry point."""
    try:
        ctx.register_tool(
            name="tempest_context",
            toolset="file",
            schema=_TOOL_SCHEMA,
            handler=_tool_handler,
            check_fn=lambda: True,
            description="Tempest code knowledge-graph context (atlas).",
            emoji="🧠",
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("tempest tool registration failed: %s", e)
    try:
        _ensure_server()
    except Exception:  # noqa: BLE001
        logger.exception("tempest server start failed")


# Open the dashboard in the browser if configured to do so at startup.
def open_dashboard() -> None:
    if os.environ.get("TEMPEST_OPEN_DASHBOARD") == "1":
        webbrowser.open(f"http://127.0.0.1:{_port()}")
