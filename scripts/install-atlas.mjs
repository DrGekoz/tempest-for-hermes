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
// WASM-only: we bundle the pure-JS/WASM inference path (onnxruntime-web) and skip
// the native/large deps — `onnxruntime-node` (per-platform native binaries) and
// `sharp` (image codec, only used by image pipelines, not text embedding). This
// keeps the installer small with no per-platform binary management; transformers
// falls back to the WASM backend when onnxruntime-node isn't present.
//
// The MODEL WEIGHTS ARE NOT BUNDLED — they download on user consent at runtime
// into the app-data cache. Only the (small) inference runtime ships here.
//
// No-op until the Atlas package is published WITH the @xenova/transformers dep;
// today it isn't installed, so this warns and copies nothing (zero bloat).
const SEMANTIC_ROOTS = ['@xenova/transformers']
const EXCLUDE = new Set(['onnxruntime-node', 'sharp'])

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
  for (const dep of Object.keys(meta.dependencies ?? {})) copyClosure(dep, seen)
}

for (const pkg of SEMANTIC_ROOTS) copyClosure(pkg)

console.log('Atlas staged → src-tauri/resources/atlas/')
