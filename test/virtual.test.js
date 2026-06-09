// @zakkster/lite-virtual -- test suite (node:test)
//
// The headless axes are pure reactive math and are tested directly. The DOM
// renderers are exercised against a minimal element + ResizeObserver mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect } from "@zakkster/lite-signal";
import {
    virtualAxis,
    variableAxis,
    measuredAxis,
    mountList,
    mountMeasuredList,
    onEndReached,
    stickyHeader,
} from "../Virtual.js";

// --- DOM + ResizeObserver mock ----------------------------------------------
let roInstances = [];
class MockResizeObserver {
    constructor(cb) {
        this.cb = cb;
        this.targets = [];
        roInstances.push(this);
    }
    observe(el) {
        this.targets.push(el);
    }
    unobserve(el) {
        const i = this.targets.indexOf(el);
        if (i >= 0) this.targets.splice(i, 1);
    }
    disconnect() {
        this.targets = [];
    }
    fire(entries) {
        this.cb(entries);
    }
}
global.ResizeObserver = MockResizeObserver;

function mockEl() {
    const el = {
        style: {},
        tabIndex: -1,
        scrollTop: 0,
        scrollLeft: 0,
        clientHeight: 0,
        textContent: "",
        children: [],
        parentNode: null,
        _listeners: {},
        setAttribute() {},
        appendChild(c) {
            el.children.push(c);
            c.parentNode = el;
            return c;
        },
        removeChild(c) {
            const i = el.children.indexOf(c);
            if (i >= 0) el.children.splice(i, 1);
        },
        remove() {
            if (el.parentNode) el.parentNode.removeChild(el);
        },
        addEventListener(t, fn) {
            (el._listeners[t] || (el._listeners[t] = [])).push(fn);
        },
        removeEventListener(t, fn) {
            const a = el._listeners[t];
            if (a) {
                const i = a.indexOf(fn);
                if (i >= 0) a.splice(i, 1);
            }
        },
        fire(t) {
            for (const fn of [...(el._listeners[t] || [])]) fn();
        },
    };
    el.ownerDocument = { createElement: () => mockEl() };
    return el;
}

function mockScope() {
    const effects = [];
    const cleanups = [];
    return {
        effect: (fn) => {
            const d = effect(fn);
            effects.push(d);
            return d;
        },
        on: (target, type, handler) => {
            target.addEventListener(type, handler);
            const off = () => target.removeEventListener(type, handler);
            cleanups.push(off);
            return off;
        },
        onCleanup: (fn) => cleanups.push(fn),
        dispose: () => {
            for (const c of cleanups) c();
            for (const d of effects) d();
        },
    };
}

const rowByText = (host, text) => host.children.find((c) => c.textContent === text);

// ============================ headless axes =================================

test("virtualAxis.offsetForIndex aligns and clamps", () => {
    const ax = virtualAxis({ count: 100, itemSize: 30, viewport: 300, overscan: 0 });
    assert.equal(ax.offsetForIndex(50, "start"), 1500);
    assert.equal(ax.offsetForIndex(50, "end"), 1500 - 300 + 30);
    assert.equal(ax.offsetForIndex(50, "center"), 1500 - 150 + 15);
    assert.equal(ax.offsetForIndex(0, "start"), 0);
    assert.equal(ax.offsetForIndex(99, "start"), 2700, "clamped to total - viewport");
});

test("virtualAxis.offsetForIndex auto only moves when off-screen", () => {
    const ax = virtualAxis({ count: 100, itemSize: 30, viewport: 300, overscan: 0 });
    // item 50 top=1500, below the viewport at scroll 0 -> align to end
    assert.equal(ax.offsetForIndex(50, "auto"), 1230);
    ax.setScroll(1500); // item 50 now at the top -> already visible -> no move
    assert.equal(ax.offsetForIndex(50, "auto"), 1500);
});

test("virtualAxis exposes firstIndex and count", () => {
    const ax = virtualAxis({ count: 40, itemSize: 20, viewport: 100, overscan: 0 });
    assert.equal(ax.count(), 40);
    ax.setScroll(85);
    assert.equal(ax.firstIndex.peek(), 4, "floor(85/20)");
});

test("variableAxis.offsetForIndex uses prefix offsets", () => {
    const sizes = [10, 20, 30, 40, 50];
    const ax = variableAxis({ count: 5, sizeAt: (i) => sizes[i], viewport: 60, overscan: 0 });
    assert.equal(ax.positionAt(3), 60); // 10+20+30
    assert.equal(ax.offsetForIndex(3, "start"), 60);
    assert.equal(ax.offsetForIndex(3, "end"), 60 - 60 + 40); // item3 size 40
});

test("measuredAxis: Fenwick offsets match brute force after measures", () => {
    const N = 64;
    const ax = measuredAxis({ count: N, estimateSize: 20, viewport: 100, overscan: 0 });
    assert.equal(ax.totalSize.peek(), N * 20);

    // apply a scattered set of measurements
    const sizes = new Array(N).fill(20);
    const updates = [[0, 50], [5, 12], [5, 31], [63, 80], [40, 7], [12, 12], [12, 100]];
    for (const [i, h] of updates) {
        ax.measure(i, h);
        sizes[i] = h;
    }
    // brute-force prefix sums
    const prefix = [0];
    for (let i = 0; i < N; i++) prefix.push(prefix[i] + sizes[i]);

    for (const i of [0, 1, 5, 6, 12, 13, 40, 63, 64]) {
        assert.equal(ax.positionAt(i), prefix[i], `positionAt(${i})`);
    }
    assert.equal(ax.totalSize.peek(), prefix[N], "total");
    assert.equal(ax.sizeAt(12), 100);
});

test("measuredAxis: findItem (firstIndex) tracks measured offsets", () => {
    const ax = measuredAxis({ count: 10, estimateSize: 20, viewport: 50, overscan: 0 });
    ax.measure(2, 40); // offsets: 0,20,40,80,100,...
    ax.setScroll(85);
    assert.equal(ax.firstIndex.peek(), 3, "prefix(3)=80 <= 85 < prefix(4)=100");
    assert.equal(ax.offsetForIndex(5, "start"), 20 + 20 + 40 + 20 + 20);
});

test("measuredAxis: sub-item scroll does not change firstIndex (integer-gated)", () => {
    const ax = measuredAxis({ count: 100, estimateSize: 30, viewport: 90, overscan: 0 });
    let runs = 0;
    const stop = effect(() => {
        ax.firstIndex();
        runs++;
    });
    const base = runs;
    ax.setScroll(10); // still inside item 0
    ax.setScroll(20);
    ax.setScroll(29);
    assert.equal(runs, base, "no recompute while scrolling within one item");
    ax.setScroll(30); // cross into item 1
    assert.equal(runs, base + 1, "one recompute on boundary crossing");
    stop();
});

test("onEndReached fires once near the end and again after count grows", () => {
    const ax = virtualAxis({ count: 100, itemSize: 10, viewport: 50, overscan: 2 });
    let fires = 0;
    const stop = onEndReached(ax, { distance: 0, onReached: () => fires++ });
    assert.equal(fires, 0, "not near the end at scroll 0");

    ax.setScroll(950); // bottom
    assert.equal(fires, 1, "fired when the window reached the end");
    ax.setScroll(940);
    assert.equal(fires, 1, "does not refire at the same count");

    ax.setCount(150); // a load resolved
    ax.setScroll(1450); // new bottom
    assert.equal(fires, 2, "refires once the list grew and we reached the new end");
    stop();
});

test("stickyHeader resolves the active group ordinal reactively", () => {
    const fi = signal(0);
    const active = stickyHeader(() => fi(), [0, 10, 25, 40]);
    assert.equal(active(), 0);
    fi.set(5);
    assert.equal(active(), 0);
    fi.set(10);
    assert.equal(active(), 1);
    fi.set(24);
    assert.equal(active(), 1);
    fi.set(25);
    assert.equal(active(), 2);
    fi.set(999);
    assert.equal(active(), 3);
});

// ============================ renderers =====================================

test("mountList renders a window and scrollToIndex moves to the item", () => {
    roInstances = [];
    const host = mockEl();
    const scope = mockScope();
    const axis = mountList(host, scope, {
        count: 1000,
        itemHeight: 25,
        viewport: 100,
        overscan: 1,
        render: (el, i) => {
            el.textContent = "row " + i;
        },
    });
    // spacer height = total
    const spacer = host.children[0];
    assert.equal(spacer.style.height, 25000 + "px");
    assert.ok(rowByText(host, "row 0"), "row 0 rendered at start");

    axis.scrollToIndex(40, "start");
    assert.equal(host.scrollTop, 1000, "scrolled to 40 * 25");
    assert.equal(axis.firstIndex.peek(), 40, "window advanced");
    assert.ok(rowByText(host, "row 40"), "row 40 rendered after scroll");
    scope.dispose();
});

test("mountList horizontal uses scrollLeft and translateX", () => {
    roInstances = [];
    const host = mockEl();
    const scope = mockScope();
    const axis = mountList(host, scope, {
        count: 1000,
        itemSize: 50,
        viewport: 200,
        overscan: 1,
        horizontal: true,
        render: (el, i) => {
            el.textContent = "col " + i;
        },
    });
    const spacer = host.children[0];
    assert.equal(spacer.style.width, 50000 + "px", "main axis is width when horizontal");

    axis.scrollToIndex(10, "start");
    assert.equal(host.scrollLeft, 500, "horizontal scroll uses scrollLeft");
    const col = rowByText(host, "col 10");
    assert.ok(col && /translateX/.test(col.style.transform), "rows positioned on X");
    scope.dispose();
});

test("mountMeasuredList: a measured row patches the axis and updates total", () => {
    roInstances = [];
    const host = mockEl();
    const scope = mockScope();
    const axis = mountMeasuredList(host, scope, {
        count: 1000,
        estimateSize: 20,
        viewport: 100,
        overscan: 2,
        render: (el, i) => {
            el.textContent = "row " + i;
        },
    });
    const spacer = host.children[0];
    assert.equal(spacer.style.height, 20000 + "px", "starts at estimate * count");

    const rowRo = roInstances[0]; // row observer created first in mountMeasuredList
    const row0 = rowByText(host, "row 0");
    rowRo.fire([{ target: row0, contentRect: { height: 50 } }]);

    assert.equal(axis.sizeAt(0), 50, "axis recorded the measured height");
    assert.equal(axis.totalSize.peek(), 20000 + 30, "total grew by the delta");
    assert.equal(spacer.style.height, 20030 + "px", "spacer reflects new total");
    scope.dispose();
});

test("mountMeasuredList: a measurement above the fold re-anchors the scroll", () => {
    roInstances = [];
    const host = mockEl();
    const scope = mockScope();
    const axis = mountMeasuredList(host, scope, {
        count: 1000,
        estimateSize: 20,
        viewport: 100,
        overscan: 2,
        render: (el, i) => {
            el.textContent = "row " + i;
        },
    });
    // scroll so item 1 is the anchor with a 10px sub-item offset
    host.scrollTop = 30;
    host.fire("scroll");
    assert.equal(axis.firstIndex.peek(), 1);

    // grow row 0 (above the anchor) from 20 -> 60
    const rowRo = roInstances[0];
    const row0 = rowByText(host, "row 0");
    rowRo.fire([{ target: row0, contentRect: { height: 60 } }]);

    assert.equal(axis.sizeAt(0), 60);
    // anchor item 1 was at offset 20 (scroll 30, delta +10); now at 60 -> scroll 70
    assert.equal(host.scrollTop, 70, "scroll re-pinned so the anchor row stays put");
    scope.dispose();
});
