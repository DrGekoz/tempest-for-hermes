// Self-check for the quota helpers behind the title-bar island.
// Run with `node src/lib/quota.check.ts` (Node strips the types natively).
import assert from "node:assert";
import { CRIT, WARN, formatReset, levelOf, pct, peakQuota, type QuotaWindow } from "./quota.ts";

// ── level thresholds are inclusive at the boundary ───────────────────────────
assert.strictEqual(levelOf(0), "ok");
assert.strictEqual(levelOf(WARN - 0.001), "ok");
assert.strictEqual(levelOf(WARN), "warn", "the island must open up exactly at the warn mark");
assert.strictEqual(levelOf(CRIT - 0.001), "warn");
assert.strictEqual(levelOf(CRIT), "crit");
assert.strictEqual(levelOf(1.4), "crit", "an over-budget window is still critical, not wrapped");

// ── pct clamps rather than printing a bar wider than its track ───────────────
assert.strictEqual(pct(0.5), 50);
assert.strictEqual(pct(0.006), 1);
assert.strictEqual(pct(1.4), 100, "an over-budget window must not overflow the bar");
assert.strictEqual(pct(-1), 0);

// ── the island speaks for the fullest window ─────────────────────────────────
const q = (id: string, used: number): QuotaWindow => ({ id, label: id, used, resetsAt: 0 });
assert.strictEqual(peakQuota([]), null, "no data is not a zeroed window");
assert.strictEqual(peakQuota([q("a", 0.2), q("b", 0.8), q("c", 0.5)])?.id, "b");
assert.strictEqual(peakQuota([q("a", 0), q("b", 0)])?.id, "a", "a tie keeps the first, so the pill does not flicker");

// ── reset text never prints a nonsense duration ──────────────────────────────
const now = 1_000_000_000_000;
const at = (ms: number) => formatReset(now + ms, now);
assert.strictEqual(at(-5_000), "resetting");
assert.strictEqual(at(0), "resetting");
assert.strictEqual(at(30_000), "resets in 1m", "under a minute rounds up, never to 0m");
assert.strictEqual(at(8 * 60_000), "resets in 8m");
assert.strictEqual(at(59.6 * 60_000), "resets in 1h", "rounding to 60 minutes must carry, not print 60m");
assert.strictEqual(at(60 * 60_000), "resets in 1h");
assert.strictEqual(at(134 * 60_000), "resets in 2h 14m");

console.log("quota.check.ts — all assertions passed");
