#!/usr/bin/env python3
"""Install the Tempest for Hermes plugin into a local Hermes install.

Steps:
  1. Ensure the Node runtime deps are installed (npm install in runtime/).
  2. Install the plugin dir into ~/.hermes/plugins/tempest-for-hermes
     (a directory junction on Windows when possible, else a copy).
  3. Enable the plugin in config.yaml (add to plugins.enabled + entries).

Usage:
  python scripts/install.py [--plugin-dir <repo/hermes-plugin>]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def log(msg):
    print("[install] " + msg)


def npm_install(runtime_dir: Path) -> bool:
    pkg = runtime_dir / "node_modules"
    if (runtime_dir / "node_modules").exists():
        log("runtime deps already installed")
        return True
    log("npm install in %s (first run, large download)…" % runtime_dir)
    try:
        subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=str(runtime_dir), check=True)
        return True
    except Exception as e:
        log("npm install failed: %s" % e)
        return False


def _junction(src: Path, dst: Path) -> bool:
    """Create a Windows directory junction src -> dst (dst becomes a link to src)."""
    try:
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
            check=True, capture_output=True, text=True,
        )
        return True
    except Exception:
        return False


def install_plugin(src: Path, dst: Path) -> None:
    if dst.exists():
        log("plugin already present at %s" % dst)
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        if _junction(src, dst):
            log("created junction: %s -> %s" % (dst, src))
            return
        log("junction failed; falling back to copy")
    shutil.copytree(src, dst)
    log("copied plugin to %s" % dst)


def enable_in_config(plugin_id: str) -> None:
    try:
        from hermes_cli.config import load_config, cfg_get, cfg_set
    except Exception:
        log("could not import hermes config helpers; add '%s' to plugins.enabled manually" % plugin_id)
        return
    try:
        cfg_set(load_config(), "plugins", "entries", plugin_id, "port", 8124)
        cfg_set(load_config(), "plugins", "entries", plugin_id, "enabled", True)
        log("config: set plugins.entries.%s" % plugin_id)
    except Exception as e:
        log("config entries update failed: %s" % e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin-dir", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--plugins-root", default=str(Path.home() / "AppData/Local/hermes/plugins"))
    args = ap.parse_args()

    src = Path(args.plugin_dir).resolve()
    runtime_dir = src / "runtime"
    if not (runtime_dir / "atlas-bridge.mjs").exists():
        log("ERROR: no atlas-bridge.mjs in %s" % runtime_dir)
        sys.exit(1)

    if not npm_install(runtime_dir):
        log("ERROR: runtime install failed; run `cd %s && npm install` manually" % runtime_dir)
        sys.exit(1)

    plugins_root = Path(args.plugins_root)
    dst = plugins_root / "tempest-for-hermes"
    install_plugin(src, dst)
    enable_in_config("tempest-for-hermes")

    log("Done. Restart Hermes (gateway/CLI) for the plugin to load, then open:")
    log("    http://127.0.0.1:8124")


if __name__ == "__main__":
    main()
