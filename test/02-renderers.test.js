// 02-renderers.test.js — mountList recycling.
// Asserts the core promises: pool size is bounded, recycling is index-based,
// fast scroll re-renders exactly the rows that newly entered, parking hides
// nodes that left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScope, makeHost, fireResize } from "./_setup.js";
import { mountList } from "../Virtual.js";

const ITEM = 30;
const VIEWPORT = 400;
// perView = ceil(400/30) + 1 = 15; pool = end - start = 15 + 2*overscan (away from edges).

test("mountList: spacer height equals totalSize (count × itemHeight)", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 100000, itemHeight: ITEM, viewport: VIEWPORT,
        render: () => {},
    });
    const spacer = host.children[0];
    assert.equal(spacer.style.height, (100000 * ITEM) + "px");
    scope.dispose();
});

test("mountList: host gets overflow:auto and position:relative (so the giant spacer scrolls INSIDE, not pushes parent)", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    assert.equal(host.style.overflow, "auto");
    assert.equal(host.style.position, "relative");
    scope.dispose();
});

test("mountList: host gets tabIndex >= 0 so arrow/page keys can scroll it via keyboard", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    assert.ok(host.tabIndex < 0, "fresh host is not focusable");
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    assert.ok(host.tabIndex >= 0, "after mountList, host is focusable for keyboard scroll");
    scope.dispose();
});

test("mountList: tabIndex is NOT clobbered if the caller already set one", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    host.tabIndex = 3;                                      // caller's pre-existing value
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    assert.equal(host.tabIndex, 3, "caller's tabIndex preserved");
    scope.dispose();
});

test("mountList: spacer is absolute + hidden + aria-hidden (bulletproof against parent formatting context)", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    const spacer = host.children[0];
    assert.equal(spacer.style.position, "absolute", "spacer absolute → no flow interference");
    assert.equal(spacer.style.top, "0");
    assert.equal(spacer.style.left, "0");
    assert.equal(spacer.style.width, "1px", "1px wide → no horizontal-flex collapse");
    assert.equal(spacer.style.visibility, "hidden", "hidden → no paint, no pointer events");
    assert.equal(spacer.getAttribute("aria-hidden"), "true", "AT skips it");
    assert.equal(spacer.style.height, (1000 * ITEM) + "px", "explicit pixel height still drives scrollHeight");
    scope.dispose();
});

test("mountList: only ~(perView + 2*overscan) row nodes exist regardless of count", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 10_000_000,                  // 10 million items
        itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });
    // host.children = [spacer, ...rows]
    const rows = host.children.length - 1;
    // At scroll=0: start=0, end = 0 + ceil(400/30)+1 + 3 = 15+3 = 18 rows
    assert.ok(rows <= 25, `pool has ${rows} rows (cap ~25), not millions`);
    assert.ok(rows >= 15, `pool has ${rows} rows (≥ perView=15)`);
    scope.dispose();
});

test("mountList: render() is called exactly once per index when scrolling smoothly", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const callsByIndex = new Map();
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: (_el, i) => { callsByIndex.set(i, (callsByIndex.get(i) || 0) + 1); },
    });
    // Initial: indices 0..17 each rendered exactly once.
    for (let i = 0; i < 18; i++) {
        assert.equal(callsByIndex.get(i), 1, `index ${i} rendered once on mount`);
    }
    // Scroll down by one row. firstItem=1, start=0 (overscan pinned), end=19.
    // Only newly-entered index 18 should render. (15-17 are still in window.)
    host.scrollTop = ITEM;
    assert.equal(callsByIndex.get(18), 1, "index 18 rendered once on boundary cross");
    assert.equal(callsByIndex.get(0), 1, "index 0 NOT re-rendered (still in window)");
    scope.dispose();
});

test("mountList: scrolling within ONE row (sub-itemHeight) writes NOTHING to the DOM", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    let renderCalls = 0;
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT,
        render: () => { renderCalls++; },
    });
    renderCalls = 0;
    // 29 pixels of scroll, all within item 0 — should hit ZERO render calls.
    for (let px = 1; px < ITEM; px++) host.scrollTop = px;
    assert.equal(renderCalls, 0, "29 sub-row scroll events → 0 renders (boundary cutoff)");
    scope.dispose();
});

test("mountList: a long scroll re-renders ONLY the indices that newly entered", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const indexRenderCounts = new Map();
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: (_el, i) => { indexRenderCounts.set(i, (indexRenderCounts.get(i) || 0) + 1); },
    });
    indexRenderCounts.clear();
    // Jump from scrollTop 0 → 30 (one row). firstItem 0→1.
    host.scrollTop = ITEM;
    // New end is 19 (was 18). Only index 18 should render.
    const renderedIndices = [...indexRenderCounts.keys()].sort((a, b) => a - b);
    assert.deepEqual(renderedIndices, [18], "only index 18 (newly entered) was rendered");
    scope.dispose();
});

test("mountList: each row node has style.position absolute and a transform setting its y", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT,
        render: () => {},
    });
    // Children: [0] = spacer, [1..] = rows. Pick a row.
    const row = host.children[1];
    assert.equal(row.style.position, "absolute");
    // The first row's transform is translateY(0px)
    assert.equal(row.style.transform, "translateY(0px)");
    scope.dispose();
});

test("mountList: pool grows once when first scrolling off the top, then stays fixed across jumps", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });
    // At scroll=0 the upper overscan is clipped: n = perView + overscan = 18.
    // Once we scroll away from the top, the full window is perView + 2*overscan = 21.
    const rowsAtTop = host.children.length - 1;
    host.scrollTop = 500 * ITEM;
    const rowsAfterJump1 = host.children.length - 1;
    assert.ok(rowsAfterJump1 >= rowsAtTop, "pool may grow on first off-top scroll");
    host.scrollTop = 900 * ITEM;
    const rowsAfterJump2 = host.children.length - 1;
    assert.equal(rowsAfterJump2, rowsAfterJump1, "pool stable across further jumps — pure recycling");
    scope.dispose();
});

test("mountList: ResizeObserver firing with a larger viewport grows the pool", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 10000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });
    const rowsBefore = host.children.length - 1;
    fireResize(host, 800, 800);            // doubled viewport
    const rowsAfter = host.children.length - 1;
    assert.ok(rowsAfter > rowsBefore, `pool grew from ${rowsBefore} to ${rowsAfter}`);
    scope.dispose();
});

test("mountList: scope.dispose() clears effects; subsequent scrolls do not call render", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    let renderCalls = 0;
    mountList(host, scope, {
        count: 1000, itemHeight: ITEM, viewport: VIEWPORT,
        render: () => { renderCalls++; },
    });
    scope.dispose();
    const renderCallsAtDispose = renderCalls;
    host.scrollTop = 500 * ITEM;
    assert.equal(renderCalls, renderCallsAtDispose, "no renders after dispose");
});
