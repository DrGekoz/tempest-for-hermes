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
  // Asset write path (atlas-extension-plan Rung 3). Deliberately NOT exposed
  // over MCP — agents read assets, humans/CLI write them. One flag per verb,
  // consuming the next positional arg(s) so a Tauri host / shell script can
  // shell out with the same syntax as `--init`.
  let assetVerb: 'add' | 'remove' | 'link' | 'unlink' | 'list' | null = null;
  let assetArg1: string | undefined;
  let assetArg2: string | undefined;
  let assetLinkedTo: string | undefined;

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
    } else if (arg === '--asset-add' || arg === '--asset-remove') {
      assetVerb = arg === '--asset-add' ? 'add' : 'remove';
      const next = args[i + 1];
      if (next !== undefined) { assetArg1 = next; i++; }
    } else if (arg === '--asset-link' || arg === '--asset-unlink') {
      assetVerb = arg === '--asset-link' ? 'link' : 'unlink';
      const a = args[i + 1];
      const b = args[i + 2];
      if (a !== undefined && b !== undefined) { assetArg1 = a; assetArg2 = b; i += 2; }
    } else if (arg === '--asset-list') {
      assetVerb = 'list';
    } else if (arg === '--asset-linked-to') {
      const next = args[i + 1];
      if (next !== undefined) { assetLinkedTo = next; i++; }
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

  // Asset write-path mode. Opens the project, runs the verb, prints the
  // result JSON on stdout, and exits. Never starts an MCP server.
  if (assetVerb) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index') as typeof import('../index');
    if (!mod.isInitialized(resolvedPath)) {
      process.stderr.write(`[Atlas] project not initialized at ${resolvedPath} — run --init first\n`);
      process.exitCode = 1;
      return;
    }
    let instance: import('../index').Atlas | undefined;
    try {
      instance = await mod.default.open(resolvedPath);
      let output: unknown;
      switch (assetVerb) {
        case 'add': {
          if (!assetArg1) throw new Error('--asset-add requires a file path');
          output = await instance.addAsset(assetArg1);
          break;
        }
        case 'remove': {
          if (!assetArg1) throw new Error('--asset-remove requires an id or path');
          const id = assetArg1.startsWith('asset:')
            ? assetArg1
            : instance.resolveAssetIdByPath(assetArg1);
          output = { removed: instance.removeAsset(id), id };
          break;
        }
        case 'link': {
          if (!assetArg1 || !assetArg2) throw new Error('--asset-link requires <asset-id> <symbol-id>');
          instance.linkAsset(assetArg1, assetArg2);
          output = { linked: true, asset: assetArg1, symbol: assetArg2 };
          break;
        }
        case 'unlink': {
          if (!assetArg1 || !assetArg2) throw new Error('--asset-unlink requires <asset-id> <symbol-id>');
          output = { unlinked: instance.unlinkAsset(assetArg1, assetArg2), asset: assetArg1, symbol: assetArg2 };
          break;
        }
        case 'list': {
          output = instance.listAssets(assetLinkedTo ? { linkedTo: assetLinkedTo } : undefined);
          break;
        }
      }
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`[Atlas] asset ${assetVerb} failed: ${err}\n`);
      process.exitCode = 1;
    } finally {
      try { instance?.close(); } catch { /* best-effort */ }
    }
    return;
  }

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
