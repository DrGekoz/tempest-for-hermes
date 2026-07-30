# tests

Developer self-checks — no framework, no fixtures.

The checks themselves live next to the code they cover, as `src/**/*.check.ts`.
Each is a plain script that imports the pure functions and asserts on them with
`node:assert`. `tests/run.mjs` discovers and runs every one.

```bash
npm test              # run all checks
npm test tempest      # only checks whose path contains "tempest"
node tests/run.mjs -v # also print each check's own stdout
```

Exit code is non-zero if any check fails, so this drops into a pre-commit hook or CI.

## Adding a check

Create `src/<area>/<thing>.check.ts` next to the code, keep it to pure functions
(no Tauri `invoke`, no React), assert with `node:assert`, and end with
`console.log("<thing>: all checks passed")`. The runner picks it up automatically —
nothing to register here.

Import sibling modules with an explicit `.ts` extension (e.g.
`import { x } from "./thing.ts"`) so bare `node` can resolve them.
