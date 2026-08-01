import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Force Vite to pre-bundle the UMD/CJS cytoscape layout plugins into ESM
  // so they load correctly inside type:"module" workers.
  worker: {
    format: "es",
  },
  optimizeDeps: {
    include: ["cytoscape", "cytoscape-fcose"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Ignore `src-tauri` (Rust) and `.tempest/` — the latter holds Tempest's
      //    own worktrees, logs, atlas index, and session pid files. When Tempest is
      //    run on its own repo (dogfooding), creating a worktree checks a full source
      //    tree into `.tempest/<branch>/`; without this, Vite sees those files and
      //    triggers a full page reload mid-action.
      ignored: ["**/src-tauri/**", "**/.tempest/**"],
    },
  },
}));
