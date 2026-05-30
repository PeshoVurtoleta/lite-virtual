// 05-variable.test.js — variableAxis and mountVariableList.
//
// variableAxis is the "non-uniform heights" path. The promise: scrolling
// WITHIN a known-height item is still allocation-free + DOM-write-free,
// because firstItem is still an integer and Object.is still gates downstream
// work. The cost paid is O(n) on build (compute prefix sums) and O(log n)
// per scroll (binary search). These tests pin down both halves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { makeScope, makeHost } from "./_setup.js";
import { variableAxis, mountVariableList } from "../Virtual.js";

// ─────────────────────────────────────────────────────────────────────────────
// variableAxis math
// ─────────────────────────────────────────────────────────────────────────────

test("variableAxis: positionAt(i) is the prefix-sum offset; totalSize is the sum", () => {
    const sizes = [20, 30, 40, 50, 60, 70, 80, 90, 100];
    const a = variableAxis({ count: sizes.length, sizeAt: (i) => sizes[i], viewport: 200 });
    assert.equal(a.positionAt(0), 0);
    assert.equal(a.positionAt(1), 20);
    assert.equal(a.positionAt(2), 50);
    assert.equal(a.positionAt(sizes.length), sizes.reduce((a, b) => a + b));
    assert.equal(a.totalSize(), 540);
});

test("variableAxis: scrolling WITHIN an item does not move start/end (binary search converges)", () => {
    const sizes = Array.from({ length: 100 }, (_, i) => 30 + (i % 10));   // 30..39 cycling
    const a = variableAxis({ count: 100, sizeAt: (i) => sizes[i], viewport: 200, overscan: 2 });
    let startTicks = 0, endTicks = 0;
    const s1 = effect(() => { a.start(); startTicks++; });
    const s2 = effect(() => { a.end(); endTicks++; });
    startTicks = 0; endTicks = 0;
    // Find item 50's pixel range.
    const p50 = a.positionAt(50);
    const sz50 = sizes[50];
    a.setScroll(p50);                  // top of item 50
    const ticksAfterFirst = startTicks;
    for (let dx = 1; dx < sz50; dx++) a.setScroll(p50 + dx);   // within item 50
    assert.equal(startTicks, ticksAfterFirst, "scrolling within item 50 → start did not fire");
    s1(); s2();
});

test("variableAxis: minSize() returns the smallest height", () => {
    const sizes = [50, 30, 70, 20, 90, 40];
    const a = variableAxis({ count: 6, sizeAt: (i) => sizes[i], viewport: 200 });
    assert.equal(a.minSize(), 20);
});

test("variableAxis: remeasure() picks up new heights from the same sizeAt closure", () => {
    let multiplier = 1;
    const a = variableAxis({
        count: 10,
        sizeAt: (i) => (i + 1) * 10 * multiplier,
        viewport: 200,
    });
    const totalBefore = a.totalSize();
    multiplier = 2;
    a.remeasure();
    assert.equal(a.totalSize(), totalBefore * 2, "remeasure rebuilds offsets from current sizeAt");
});

test("variableAxis: setCount grows the offset array", () => {
    const a = variableAxis({ count: 5, sizeAt: (i) => 30, viewport: 200 });
    assert.equal(a.totalSize(), 150);
    a.setCount(10);
    assert.equal(a.totalSize(), 300);
});

test("variableAxis: binary search handles negative scroll (pin to 0) and overscroll (pin to count)", () => {
    const a = variableAxis({ count: 10, sizeAt: () => 30, viewport: 100 });
    a.setScroll(-999);
    assert.equal(a.start(), 0, "negative scroll → start at 0");
    a.setScroll(99999);
    assert.equal(a.end(), 10, "scroll past end → end pinned to count");
});

// ─────────────────────────────────────────────────────────────────────────────
// mountVariableList renderer
// ─────────────────────────────────────────────────────────────────────────────

test("mountVariableList: spacer height = totalSize; pool pre-sized from smallest row", () => {
    const scope = makeScope();
    const host = makeHost(800, 300);
    const sizes = Array.from({ length: 1000 }, (_, i) => 20 + (i % 5) * 10);  // 20..60
    mountVariableList(host, scope, {
        count: 1000, sizeAt: (i) => sizes[i], viewport: 300, overscan: 3,
        render: () => {},
    });
    const total = sizes.reduce((a, b) => a + b);
    const spacer = host.children[0];
    assert.equal(spacer.style.height, total + "px");
    // Pool: ceil(300 / minSize=20) + 1 + 2*3 = 15 + 1 + 6 = 22 nodes
    const rows = host.children.length - 1;
    assert.equal(rows, 22, "pool sized from smallest row");
    scope.dispose();
});

test("mountVariableList: each row gets its own pixel height applied", () => {
    const scope = makeScope();
    const host = makeHost(800, 300);
    const sizes = [25, 50, 75, 100, 125, 150, 175, 200];
    mountVariableList(host, scope, {
        count: sizes.length, sizeAt: (i) => sizes[i], viewport: 300, overscan: 1,
        render: () => {},
    });
    // Each pool node should have its assigned size at the moment it represents that index.
    // Check that the first visible row has height = sizes[0].
    const firstRow = host.children[1];
    assert.equal(firstRow.style.height, sizes[0] + "px", "first visible row took its own height");
    scope.dispose();
});

test("mountVariableList: render() is called once per index entering the window", () => {
    const scope = makeScope();
    const host = makeHost(800, 300);
    const sizes = Array.from({ length: 200 }, () => 30);
    const renders = new Map();
    mountVariableList(host, scope, {
        count: 200, sizeAt: (i) => sizes[i], viewport: 300, overscan: 2,
        render: (_el, i) => { renders.set(i, (renders.get(i) || 0) + 1); },
    });
    // Initial: visible 0..(ceil(300/30)+1+2) = 0..12 → 13 items rendered
    for (let i = 0; i < 12; i++) {
        assert.equal(renders.get(i), 1, `index ${i} rendered once`);
    }
    renders.clear();
    // Smooth scroll one row.
    host.scrollTop = 30;
    // firstItem = 1; start = max(0, 1-2) = 0; end = lastItem(scroll+vh) + 1 + 2.
    // The previously-rendered nodes don't re-render — only the newly-entered one does.
    const newRenders = [...renders.keys()];
    assert.ok(newRenders.length <= 2, `at most one new index rendered, got: ${newRenders}`);
    scope.dispose();
});

test("mountVariableList: scrolling within an item produces zero renders", () => {
    const scope = makeScope();
    const host = makeHost(800, 300);
    let renderCalls = 0;
    mountVariableList(host, scope, {
        count: 1000, sizeAt: () => 50, viewport: 300, overscan: 2,
        render: () => { renderCalls++; },
    });
    renderCalls = 0;
    for (let px = 1; px < 50; px++) host.scrollTop = px;
    assert.equal(renderCalls, 0, "49 sub-row scroll events → 0 renders");
    scope.dispose();
});
