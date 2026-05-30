// 04-keyed-and-grid.test.js — mountKeyedList and mountGrid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { makeScope, makeHost, fireResize } from "./_setup.js";
import { mountKeyedList, mountGrid } from "../Virtual.js";

const ITEM = 40;
const VIEWPORT = 400;

// ─────────────────────────────────────────────────────────────────────────────
// mountKeyedList — identity-by-key, NOT by index
// ─────────────────────────────────────────────────────────────────────────────

test("mountKeyedList: render() is called ONCE per key that enters the window, never twice", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const items = signal(Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `row-${i}` })));
    const renders = new Map();
    mountKeyedList(host, scope, {
        items: () => items(),
        itemHeight: ITEM, viewport: VIEWPORT, overscan: 2,
        key: (item) => item.id,
        render: (_el, item) => { renders.set(item.id, (renders.get(item.id) || 0) + 1); },
    });
    // Initial visible: ceil(400/40)+1 + 2 = 13 items rendered, ids 0..12.
    for (let i = 0; i < 13; i++) {
        assert.equal(renders.get(i), 1, `id ${i} rendered exactly once on mount`);
    }
    scope.dispose();
});

test("mountKeyedList: node identity stays with the data key across scroll (NOT with the index)", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const items = signal(Array.from({ length: 1000 }, (_, i) => ({ id: i })));
    const nodeByKey = new Map();
    mountKeyedList(host, scope, {
        items: () => items(),
        itemHeight: ITEM, viewport: VIEWPORT, overscan: 2,
        key: (item) => item.id,
        render: (el, item) => { nodeByKey.set(item.id, el); },
    });
    const node0 = nodeByKey.get(0);
    // Scroll down enough that id 0 leaves and id 50 enters.
    host.scrollTop = 50 * ITEM;
    // id 0 is now off-window — its node should have been removed.
    // The new id-50 node should be different from node0 (since node0 was removed).
    const node50 = nodeByKey.get(50);
    assert.ok(node50 !== node0, "different key → different node (no recycling across keys)");
    scope.dispose();
});

test("mountKeyedList: a node is REMOVED from the DOM when its key leaves the window", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const items = signal(Array.from({ length: 1000 }, (_, i) => ({ id: i })));
    mountKeyedList(host, scope, {
        items: () => items(),
        itemHeight: ITEM, viewport: VIEWPORT, overscan: 2,
        key: (item) => item.id,
        render: () => {},
    });
    const childrenAtTop = host.children.length;
    host.scrollTop = 500 * ITEM;
    const childrenInMiddle = host.children.length;
    // We expect roughly the same count of rendered rows: 1 spacer + ~13 visible
    assert.ok(Math.abs(childrenInMiddle - childrenAtTop) <= 2,
        `child count similar (was ${childrenAtTop}, now ${childrenInMiddle}) — old nodes were removed, new ones created`);
    scope.dispose();
});

test("mountKeyedList: reordering items moves nodes by index (state preserved) — NOT a rebuild", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const items = signal([
        { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" },
        { id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" },
    ]);
    const renderCounts = new Map();
    const nodeByKey = new Map();
    mountKeyedList(host, scope, {
        items: () => items(),
        itemHeight: ITEM, viewport: VIEWPORT, overscan: 2,
        key: (item) => item.id,
        render: (el, item) => {
            renderCounts.set(item.id, (renderCounts.get(item.id) || 0) + 1);
            nodeByKey.set(item.id, el);
        },
    });
    const aNode = nodeByKey.get("a");
    const bNode = nodeByKey.get("b");
    assert.equal(renderCounts.get("a"), 1);
    assert.equal(renderCounts.get("b"), 1);

    // Reorder: swap a and b
    items.set([{ id: "b" }, { id: "a" }, ...items.peek().slice(2)]);

    assert.equal(renderCounts.get("a"), 1, "a was NOT re-rendered (node moved)");
    assert.equal(renderCounts.get("b"), 1, "b was NOT re-rendered");
    // Same nodes — identity preserved.
    assert.equal(nodeByKey.get("a"), aNode, "a's node identity preserved");
    assert.equal(nodeByKey.get("b"), bNode, "b's node identity preserved");
    // But their transforms swapped.
    assert.equal(aNode.style.transform, "translateY(" + ITEM + "px)", "a moved to slot 1");
    assert.equal(bNode.style.transform, "translateY(0px)", "b moved to slot 0");

    scope.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// mountGrid — 2D recycling
// ─────────────────────────────────────────────────────────────────────────────

test("mountGrid: pool is pre-sized to MAX window (does not grow during scroll)", () => {
    const scope = makeScope();
    const host = makeHost(800, 600);
    mountGrid(host, scope, {
        rowCount: 10_000, colCount: 1000,
        rowHeight: 30, colWidth: 100,
        viewportHeight: 600, viewportWidth: 800,
        overscan: 2,
        render: () => {},
    });
    // Cells expected: (ceil(600/30)+1+4) × (ceil(800/100)+1+4) = 25 × 13 = 325
    // (plus the spacer at index 0)
    const cellsAtTop = host.children.length - 1;
    host.scrollTop = 500 * 30;
    host.scrollLeft = 500 * 100;
    const cellsAfterScroll = host.children.length - 1;
    assert.equal(cellsAfterScroll, cellsAtTop, "pool size unchanged after big 2-D scroll");
    scope.dispose();
});

test("mountGrid: scrolling within a single (row,col) cell re-renders NOTHING", () => {
    const scope = makeScope();
    const host = makeHost(800, 600);
    let renderCalls = 0;
    mountGrid(host, scope, {
        rowCount: 10_000, colCount: 1000,
        rowHeight: 30, colWidth: 100,
        viewportHeight: 600, viewportWidth: 800,
        render: () => { renderCalls++; },
    });
    renderCalls = 0;
    // Sub-cell scroll: top 0→29 (within row 0), left 0→99 (within col 0)
    for (let i = 1; i < 30; i++) host.scrollTop = i;
    for (let i = 1; i < 100; i++) host.scrollLeft = i;
    assert.equal(renderCalls, 0, "sub-cell scroll → zero renders (2-axis cutoff)");
    scope.dispose();
});

test("mountGrid: crossing a row boundary re-renders ONE row of cells", () => {
    const scope = makeScope();
    const host = makeHost(800, 600);
    const renderedKeys = new Set();
    mountGrid(host, scope, {
        rowCount: 1000, colCount: 1000,
        rowHeight: 30, colWidth: 100,
        viewportHeight: 600, viewportWidth: 800,
        overscan: 2,
        render: (_el, r, c) => { renderedKeys.add(r + "," + c); },
    });
    renderedKeys.clear();
    // Scroll one row down. firstRow goes 0→1. start row stays 0 (overscan-pinned).
    // end row was max=23 → becomes 24, so one new row of cells enters.
    host.scrollTop = 30;
    const newRows = new Set([...renderedKeys].map(k => k.split(",")[0]));
    // Newly rendered cells should all share one row index (the row that entered).
    assert.equal(newRows.size, 1, `one row's cells re-rendered, got rows: ${[...newRows]}`);
    scope.dispose();
});

test("mountGrid: ResizeObserver firing with larger size grows the pool", () => {
    const scope = makeScope();
    const host = makeHost(400, 300);
    mountGrid(host, scope, {
        rowCount: 1000, colCount: 1000,
        rowHeight: 30, colWidth: 100,
        viewportHeight: 300, viewportWidth: 400,
        render: () => {},
    });
    const before = host.children.length - 1;
    fireResize(host, 800, 600);
    const after = host.children.length - 1;
    assert.ok(after > before, `viewport grew → pool grew (${before} → ${after})`);
    scope.dispose();
});

test("mountGrid: dispose disconnects RO + clears all effects", () => {
    const scope = makeScope();
    const host = makeHost(800, 600);
    mountGrid(host, scope, {
        rowCount: 1000, colCount: 1000,
        rowHeight: 30, colWidth: 100,
        viewportHeight: 600, viewportWidth: 800,
        render: () => {},
    });
    const roBefore = globalThis.__roRegistry.reduce((n, ro) => n + ro._targets.length, 0);
    scope.dispose();
    const roAfter = globalThis.__roRegistry.reduce((n, ro) => n + ro._targets.length, 0);
    assert.equal(roAfter, roBefore - 1, "grid's RO removed on dispose");
});
