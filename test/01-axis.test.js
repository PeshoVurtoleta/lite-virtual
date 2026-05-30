// 01-axis.test.js — virtualAxis & virtualGrid math.
// The library's core claim is "boundary-only updates" — integer firstItem +
// Object.is cutoff. These tests pin that down at the math layer (no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { virtualAxis, virtualGrid } from "../Virtual.js";

// ─────────────────────────────────────────────────────────────────────────────
// virtualAxis — initial state
// ─────────────────────────────────────────────────────────────────────────────

test("virtualAxis: initial start/end/offsetStart/totalSize from inputs", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    assert.equal(a.start(), 0, "no scroll → start at top");
    // perView = ceil(400/30) + 1 = 15; end = firstItem + perView + overscan = 0 + 15 + 3 = 18
    assert.equal(a.end(), 18);
    assert.equal(a.offsetStart(), 0);
    assert.equal(a.totalSize(), 30000, "1000 items × 30px");
});

test("virtualAxis: overscan extends start ONLY when not pinned to top", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 5 });
    a.setScroll(300);                  // firstItem = 10
    assert.equal(a.start(), 5);        // 10 - 5
    a.setScroll(60);                   // firstItem = 2
    assert.equal(a.start(), 0, "Math.max(0, 2-5) = 0 — pinned to top");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BIG ONE: boundary-only updates
// ─────────────────────────────────────────────────────────────────────────────

test("virtualAxis: scrolling within an item produces ZERO start/end changes (Object.is cutoff)", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    let startTicks = 0, endTicks = 0;
    const stop1 = effect(() => { a.start(); startTicks++; });
    const stop2 = effect(() => { a.end(); endTicks++; });
    startTicks = 0; endTicks = 0;
    // Scroll through every pixel of item 0 (0..29) and item 1 (30..59).
    // Item 0 pixels: no boundary crossing. Item 1 pixels: one boundary crossing.
    for (let px = 1; px < 30; px++) a.setScroll(px);
    assert.equal(startTicks, 0, "no boundary crossing within item 0 → start did not fire");
    assert.equal(endTicks, 0,   "no boundary crossing within item 0 → end did not fire");
    a.setScroll(30);                   // crosses into item 1
    assert.equal(startTicks, 0, "start still 0 (Math.max(0,1-3)=0 — pinned)");
    assert.equal(endTicks, 1, "end ticked once on boundary cross");
    for (let px = 31; px < 60; px++) a.setScroll(px);
    assert.equal(endTicks, 1, "scrolling within item 1 → end still 1");
    stop1(); stop2();
});

test("virtualAxis: a fast scroll across N rows fires start/end exactly N times", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    let startTicks = 0, endTicks = 0;
    const stop1 = effect(() => { a.start(); startTicks++; });
    const stop2 = effect(() => { a.end(); endTicks++; });
    startTicks = 0; endTicks = 0;
    // Scroll from item 50 to item 100 (50 boundary crossings) one pixel at a time.
    for (let i = 50; i <= 100; i++) {
        a.setScroll(i * 30);           // land exactly on each boundary
    }
    // 51 boundaries crossed (50 → 100 inclusive on the moves), all distinct firstItem values.
    assert.equal(startTicks, 51, "start ticks = boundary crossings");
    assert.equal(endTicks, 51);
    stop1(); stop2();
});

// ─────────────────────────────────────────────────────────────────────────────
// Overscroll pinning (iOS rubber-band, Android over-pull, scroll-into-view)
// ─────────────────────────────────────────────────────────────────────────────

test("virtualAxis: negative scrollPos pins firstItem to 0 (iOS rubber-band)", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400 });
    a.setScroll(300);
    const startMid = a.start();
    a.setScroll(-500);
    assert.equal(a.start(), 0, "negative scrollPos → pinned at top");
    assert.equal(a.offsetStart(), 0);
    a.setScroll(300);
    assert.equal(a.start(), startMid, "recovers when scroll returns to normal");
});

test("virtualAxis: scrolling past the end pins firstItem to count", () => {
    const a = virtualAxis({ count: 100, itemSize: 30, viewport: 400, overscan: 3 });
    a.setScroll(999999);
    // firstItem pins to count=100; start = max(0, 100-3) = 97; end = min(100, 100+...) = 100
    assert.equal(a.start(), 97);
    assert.equal(a.end(), 100, "end pinned to count");
});

// ─────────────────────────────────────────────────────────────────────────────
// setCount / setViewport reactivity
// ─────────────────────────────────────────────────────────────────────────────

test("virtualAxis: setCount updates totalSize but does not move the viewport", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    a.setScroll(300);
    const startBefore = a.start();
    a.setCount(2000);
    assert.equal(a.totalSize(), 60000);
    assert.equal(a.start(), startBefore, "growing the list does not shift the visible window");
});

test("virtualAxis: setCount shrinking past the current scroll pins to the new end", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    a.setScroll(900);                  // firstItem = 30
    a.setCount(20);                    // now we're scrolled past the end
    assert.equal(a.start(), 17);       // pinned: 20 - 3 overscan
    assert.equal(a.end(), 20);
});

test("virtualAxis: setViewport grows perView (more rows visible)", () => {
    const a = virtualAxis({ count: 1000, itemSize: 30, viewport: 400, overscan: 3 });
    const endBefore = a.end();
    a.setViewport(800);
    assert.ok(a.end() > endBefore, "doubling viewport at least roughly doubles 'end'");
});

// ─────────────────────────────────────────────────────────────────────────────
// virtualGrid: independent axes
// ─────────────────────────────────────────────────────────────────────────────

test("virtualGrid: row and column scrolling are independent", () => {
    const g = virtualGrid({
        rowCount: 1000, colCount: 500, rowHeight: 30, colWidth: 100,
        viewportHeight: 400, viewportWidth: 800, overscan: 2,
    });
    let rTicks = 0, cTicks = 0;
    const s1 = effect(() => { g.rowStart(); rTicks++; });
    const s2 = effect(() => { g.colStart(); cTicks++; });
    rTicks = 0; cTicks = 0;
    // Scroll deep enough that rowStart actually changes (past overscan pin).
    g.setScroll(0, 300);               // firstRow=10, start=max(0, 10-2)=8
    assert.ok(rTicks > 0, "vertical scroll crossed row boundary");
    const rTicksAfterV = rTicks;
    cTicks = 0;
    g.setScroll(400, 300);             // pure horizontal — top unchanged
    assert.ok(cTicks > 0, "horizontal scroll crossed col boundary");
    assert.equal(rTicks, rTicksAfterV, "horizontal scroll did NOT re-fire rowStart");
    s1(); s2();
});

test("virtualGrid: totalHeight / totalWidth track counts × sizes", () => {
    const g = virtualGrid({
        rowCount: 1000, colCount: 500, rowHeight: 30, colWidth: 100,
        viewportHeight: 400, viewportWidth: 800,
    });
    assert.equal(g.totalHeight(), 30000);
    assert.equal(g.totalWidth(), 50000);
    g.setCounts(2000, 1000);
    assert.equal(g.totalHeight(), 60000);
    assert.equal(g.totalWidth(), 100000);
});
