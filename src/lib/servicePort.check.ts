// Self-check for the per-workspace port allocator.
// Run: `node src/lib/servicePort.check.ts` (Node strips the types natively).
import assert from "node:assert";
import { portForWorkspace, hostSlug, proxyUrl } from "./servicePort.ts";

// In range.
for (const p of ["/a", "D:\\repos\\app", "/home/x/wt/feature-1", ""]) {
  const port = portForWorkspace(p);
  assert.ok(port >= 3000 && port <= 3999, `${p} → ${port} out of range`);
}

// Deterministic — same path, same port, every time.
assert.strictEqual(portForWorkspace("/home/x/wt/a"), portForWorkspace("/home/x/wt/a"));

// Separator and trailing-slash normalization: one worktree, one port.
assert.strictEqual(portForWorkspace("D:/repos/app"), portForWorkspace("D:\\repos\\app"));
assert.strictEqual(portForWorkspace("/home/x/wt/a"), portForWorkspace("/home/x/wt/a/"));

// Sibling worktrees of one project must (almost always) differ — spot-check that
// a handful of realistic siblings land on distinct ports.
const siblings = ["main", "feat-login", "feat-billing", "bugfix-42", "spike"].map(
  (n) => portForWorkspace(`/home/x/project/.worktrees/${n}`),
);
assert.strictEqual(new Set(siblings).size, siblings.length, "sibling worktrees collided");

// Hostname slug: basename, DNS-safe, separator/trailing-slash normalized.
assert.strictEqual(hostSlug("D:\\proj\\.worktrees\\Feat-Login"), "feat-login");
assert.strictEqual(hostSlug("/home/x/proj/feat_billing/"), "feat-billing");
assert.strictEqual(hostSlug("/a/b"), hostSlug("/a/b/")); // trailing slash
assert.strictEqual(hostSlug(""), "app"); // empty falls back, never a bare ""
assert.strictEqual(proxyUrl("D:/proj/.worktrees/spike"), "http://spike.localhost:7000");

console.log("servicePort: all checks passed");
