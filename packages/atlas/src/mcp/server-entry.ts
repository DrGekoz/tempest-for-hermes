/**
 * Atlas CLI entry point — invoked by Tempest for two purposes:
 *
 *   node server-entry.js --init --path <project>
 *     Initialise the .atlas/ directory and build the first full code-graph index.
 *     Runs once when the user first accepts Token Intelligence for a project.
 *     Exits 0 when done (or if the project was already indexed).
 *
 *   node server-entry.js --path <project> [--semantic --model-cache <dir>]
 *     Start an MCP server session (proxy or daemon). Used at agent spawn time
 *     to inject the atlas tools into the agent's context.
 *     The daemon re-invokes this script with ATLAS_DAEMON_INTERNAL=1 set,
 *     so it also handles the "I am the shared daemon" path transparently.
 *
 *   node server-entry.js --download-model --model-cache <dir>
 *     Pre-fetch the semantic embedding model into <dir>, streaming JSON progress
 *     lines to stdout. Invoked by Tempest when the user consents to semantic
 *     search during onboarding, so the one-time download has a progress bar.
 *
 * Semantic search is a Tempest-owned, opt-in setting passed here as ARGS (never
 * an env block in the written MCP config). `--semantic` / `--model-cache` are
 * normalized into ATLAS_SEMANTIC / ATLAS_MODEL_CACHE below so they propagate to
 * the detached daemon and query worker threads, which inherit process.env.
 */

import * as path from 'path';

void main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  let initMode = false;
  let semantic = false;
  let modelCache: string | undefined;
  let downloadModel = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path') {
      const next = args[i + 1];
      if (next !== undefined) {
        projectPath = next;
        i++;
      }
    } else if (arg === '--init') {
      initMode = true;
    } else if (arg === '--semantic') {
      semantic = true;
    } else if (arg === '--download-model') {
      downloadModel = true;
    } else if (arg === '--model-cache') {
      const next = args[i + 1];
      if (next !== undefined) {
        modelCache = next;
        i++;
      }
    }
    // Ignore 'serve', '--mcp', and other flags the daemon spawner may pass
    // when re-invoking this script with ATLAS_DAEMON_INTERNAL=1.
  }

  // Normalize the Tempest-supplied args into env so Atlas's own detached daemon
  // (spawned with {...process.env}) and query worker threads (inherit env) all
  // see the same config without extra plumbing. See semanticDisabled().
  if (modelCache) process.env.ATLAS_MODEL_CACHE = modelCache;
  if (semantic) process.env.ATLAS_SEMANTIC = '1';

  // Download-model mode: fetch + warm the model, stream progress, exit.
  if (downloadModel) {
    const { prefetchModel } = require('../embedding') as typeof import('../embedding');
    try {
      await prefetchModel((p) => process.stdout.write(JSON.stringify(p) + '\n'));
      process.stdout.write(JSON.stringify({ status: 'done' }) + '\n');
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`[Atlas] model download failed: ${err}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (!projectPath) {
    // Global MCP configs (Goose, Codex CLI) omit --path; fall back to CWD.
    projectPath = process.cwd();
  }

  const resolvedPath = path.resolve(projectPath);

  if (initMode) {
    process.stderr.write(`[Atlas] --init for ${resolvedPath}\n`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index') as typeof import('../index');
    let instance: import('../index').Atlas | undefined;
    try {
      if (!mod.isInitialized(resolvedPath)) {
        process.stderr.write('[Atlas] not yet initialized — calling Atlas.init()\n');
        instance = await mod.default.init(resolvedPath, { index: true });
        process.stderr.write('[Atlas] Atlas.init() complete\n');
      } else {
        process.stderr.write('[Atlas] already initialized, skipping\n');
      }
    } catch (err) {
      process.stderr.write(`[Atlas] init failed: ${err}\n`);
    } finally {
      // Release the DB connection and tear down any remaining resources.
      try { instance?.close(); } catch { /* best-effort */ }
    }
    process.stderr.write('[Atlas] exiting\n');
    // Do NOT call process.exit() here. indexAll() parses on a pool of
    // worker_threads; on Windows + Node >=22 an explicit process.exit() while a
    // worker's MessagePort async handle is still mid-close aborts the whole
    // process with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
    // src/win/async.c` — reproduced on ~40% of fresh indexes. When Atlas is
    // spawned from Tempest's windowed (no-console, CREATE_NO_WINDOW) process
    // that abort has no console/window to service, so it surfaces as an
    // indefinite hang and the index never reports done (the DB file is written
    // but the toast polls forever). Instead let the event loop drain naturally
    // now that the DB is closed and the parse pool is destroyed. A last-resort
    // unref'd timer force-exits only if some future handle ever lingers — by
    // which point every worker handle is long closed, so the assertion can't
    // fire. `.unref()` keeps this timer from delaying the normal, immediate exit.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 2000).unref();
    return;
  }

  // MCP server mode: proxy to (or become) the shared daemon.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mcp = require('./index') as typeof import('./index');
  const server = new mcp.MCPServer(resolvedPath);
  await server.start();
}
