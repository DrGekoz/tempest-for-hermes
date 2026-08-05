import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src-tauri', 'resources', 'eve')

if (!existsSync(join(dir, 'package.json'))) process.exit(0)

try {
  execSync('npm install eve --save-exact --no-audit --no-fund --silent', { cwd: dir, stdio: 'inherit' })
  console.log('Eve staged → src-tauri/resources/eve/node_modules/')
} catch (e) {
  // Non-fatal: automations stay unavailable until deps install.
  console.warn('Eve install skipped:', e?.message ?? e)
}
