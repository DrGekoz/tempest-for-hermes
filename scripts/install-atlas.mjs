import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootModules = join(root, 'node_modules')
const src = join(rootModules, '@usetempest', 'atlas')
const dest = join(root, 'src-tauri', 'resources', 'atlas')
const destModules = join(dest, 'node_modules')

if (!existsSync(src)) process.exit(0)

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

// Pin to CommonJS so Node doesn't inherit the root package.json "type": "module"
writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify({ name: '@tempest/atlas-runtime', private: true, type: 'commonjs' }, null, 2) + '\n'
)

cpSync(src, join(destModules, '@usetempest', 'atlas'), { recursive: true })

// Semantic search runs the model through @xenova/transformers. That library is a
// dependency of the Atlas package, but npm hoists it to root node_modules and we
// only copy the Atlas package above — so `require('@xenova/transformers')` would
// fail to resolve in the shipped bundle. Copy its transitive closure here.
//
// onnxruntime-node MUST be included: transformers' backends/onnx.js is a static
// ESM `import * as ONNX_NODE from 'onnxruntime-node'`, so a missing package
// throws ERR_MODULE_NOT_FOUND at module-load time — there is no runtime WASM
// fallback in v2.x. `sharp` (image codec) stays excluded — text embedding never
// touches it. Model weights are NOT bundled: they download on user consent at
// runtime into the app-data cache.
const SEMANTIC_ROOTS = ['@xenova/transformers']
const EXCLUDE = new Set(['sharp'])

/** Copy `pkg` from root node_modules → dest, then recurse into its deps. */
function copyClosure(pkg, seen = new Set()) {
  if (seen.has(pkg) || EXCLUDE.has(pkg)) return
  seen.add(pkg)
  const from = join(rootModules, ...pkg.split('/'))
  const pkgJson = join(from, 'package.json')
  if (!existsSync(pkgJson)) {
    console.warn(`[install-atlas] WARN: dependency not found in root node_modules: ${pkg}`)
    return
  }
  cpSync(from, join(destModules, ...pkg.split('/')), { recursive: true })
  let meta
  try { meta = JSON.parse(readFileSync(pkgJson, 'utf8')) } catch { return }
  // Walk both `dependencies` and `optionalDependencies` — @xenova/transformers
  // declares `onnxruntime-node` as OPTIONAL, but its backends/onnx.js does a
  // hard static import of it, so we still need it bundled.
  const deps = { ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) }
  for (const dep of Object.keys(deps)) copyClosure(dep, seen)
}

for (const pkg of SEMANTIC_ROOTS) copyClosure(pkg)

// onnxruntime-node ships prebuilt native binaries for every platform under
// bin/napi-v3/{darwin,linux,win32}/{arch}/. Each build only needs its own —
// keeping the other two adds ~70MB of dead weight to every installer.
// ponytail: prunes by process.platform of the build machine; per-platform CI
// already runs this script per target, so each installer gets exactly one.
const ORT_PLATFORMS = ['darwin', 'linux', 'win32']
const ortBin = join(destModules, 'onnxruntime-node', 'bin', 'napi-v3')
if (existsSync(ortBin)) {
  for (const p of ORT_PLATFORMS) {
    if (p !== process.platform) {
      rmSync(join(ortBin, p), { recursive: true, force: true })
    }
  }
}

console.log('Atlas staged → src-tauri/resources/atlas/')
