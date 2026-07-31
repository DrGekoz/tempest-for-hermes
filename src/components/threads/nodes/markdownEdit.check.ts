import assert from "node:assert";
import { applyWrap, applyLineOp } from "./markdownEdit.ts";

// wrap: on then off
assert.equal(applyWrap("word", "**"), "**word**");
assert.equal(applyWrap("**word**", "**"), "word");
assert.equal(applyWrap("x", "`"), "`x`");
assert.equal(applyWrap("<u>x</u>", "<u>", "</u>"), "x");

// headings toggle + level swap
assert.deepEqual(applyLineOp(["foo"], "h1"), ["# foo"]);
assert.deepEqual(applyLineOp(["# foo"], "h1"), ["foo"]);
assert.deepEqual(applyLineOp(["## foo"], "h1"), ["# foo"]);

// bullet toggle, swaps from quote
assert.deepEqual(applyLineOp(["a", "b"], "bullet"), ["- a", "- b"]);
assert.deepEqual(applyLineOp(["- a", "- b"], "bullet"), ["a", "b"]);
assert.deepEqual(applyLineOp(["> a"], "bullet"), ["- a"]);

// numbered renumbers, blank lines untouched by count
assert.deepEqual(applyLineOp(["a", "b", "c"], "numbered"), ["1. a", "2. b", "3. c"]);
assert.deepEqual(applyLineOp(["1. a", "2. b"], "numbered"), ["a", "b"]);

// quote toggle
assert.deepEqual(applyLineOp(["a"], "quote"), ["> a"]);
assert.deepEqual(applyLineOp(["> a"], "quote"), ["a"]);

console.log("markdownEdit: all checks passed");
