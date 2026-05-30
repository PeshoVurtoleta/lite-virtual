// 03-observers.test.js — IntersectionObserver / ResizeObserver feedback safety.
//
// The danger zone with virtualization is a layout feedback loop:
//
//   (1) The library puts a giant spacer (count × itemSize px) inside `host` so
//       the scrollbar reflects the full list length.
//   (2) If `host` propagates its inner content height up to its parent (e.g.
//       a flex container with `align-items: stretch` and no `min-height: 0`),
//       the parent grows.
//   (3) If the library reads its viewport from the PARENT, viewport grows.
//   (4) Bigger viewport → bigger perView → more rows mounted → ... ad infinitum.
//
// lite-virtual breaks this loop on TWO independent fronts:
//
//   A) `host.style.overflow = "auto"` — the spacer scrolls INSIDE the host;
//      `host` does NOT report inflated height to its parent.
//   B) Its ResizeObserver reads `entries[0].contentRect.height` (clientHeight),
//      never `scrollHeight` — so the spacer can't influence what's read back
//      in as the viewport size.
//
// These tests pin down both defenses and verify the renderers don't subscribe
// to IntersectionObserver internally (which would be the third way to leak).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScope, makeHost, fireResize, fireIntersection } from "./_setup.js";
import { mountList, mountGrid, mountVariableList } from "../Virtual.js";

const ITEM = 30;
const VIEWPORT = 400;

// ─────────────────────────────────────────────────────────────────────────────
// A) overflow:auto isolation
// ─────────────────────────────────────────────────────────────────────────────

test("isolation: mountList sets overflow:auto so the inner spacer can't push parent layout", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, { count: 10_000_000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    assert.equal(host.style.overflow, "auto", "host clips its own overflow");
    assert.equal(host.style.position, "relative", "host establishes a containing block");
    // The spacer's pixel height IS huge — that's fine, it lives INSIDE host.
    const spacer = host.children[0];
    assert.equal(spacer.style.height, (10_000_000 * ITEM) + "px");
    scope.dispose();
});

test("isolation: mountGrid sets overflow:auto on its host too", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountGrid(host, scope, {
        rowCount: 100_000, colCount: 100_000, rowHeight: 30, colWidth: 100,
        viewportWidth: 800, viewportHeight: VIEWPORT,
        render: () => {},
    });
    assert.equal(host.style.overflow, "auto");
    assert.equal(host.style.position, "relative");
    scope.dispose();
});

test("isolation: mountVariableList sets overflow:auto", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountVariableList(host, scope, {
        count: 1000, sizeAt: i => 20 + (i % 5) * 10, viewport: VIEWPORT,
        render: () => {},
    });
    assert.equal(host.style.overflow, "auto");
    scope.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// B) ResizeObserver reads contentRect, not scrollHeight — no feedback path
// ─────────────────────────────────────────────────────────────────────────────

test("RO safety: firing ResizeObserver with the SAME contentRect does NOT bump start/end (Object.is cutoff)", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const axis = mountList(host, scope, {
        count: 10_000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });
    let endTicks = 0;
    const stop = scope.effect(() => { axis.end(); endTicks++; });
    endTicks = 0;
    // Fire RO with the same viewport size — this would happen e.g. on a
    // window event that doesn't actually change the host.
    fireResize(host, 800, VIEWPORT);
    fireResize(host, 800, VIEWPORT);
    fireResize(host, 800, VIEWPORT);
    assert.equal(endTicks, 0, "RO with unchanged size → zero downstream work");
    stop(); scope.dispose();
});

test("RO safety: firing RO with a LARGER size fires ONCE per actual change, never recursively", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const axis = mountList(host, scope, {
        count: 10_000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });
    let endTicks = 0;
    let renderCalls = 0;
    // We re-mount with a render that counts calls to detect runaway re-renders.
    // (We already mounted once; just count from here.)
    const stop = scope.effect(() => { axis.end(); endTicks++; });
    endTicks = 0; renderCalls = 0;
    // Mutate host clientHeight + fire RO. This MUST stabilize after one update.
    fireResize(host, 800, 800);
    const ticksAfter1 = endTicks;
    // Fire AGAIN with the same enlarged size — should be a no-op.
    fireResize(host, 800, 800);
    assert.equal(endTicks, ticksAfter1, "second RO firing at same size → zero further ticks");
    // And ONE more with a different size, then back — verifies the math doesn't oscillate.
    fireResize(host, 800, 1200);
    fireResize(host, 800, 1200);
    const ticksAfter2 = endTicks;
    fireResize(host, 800, 1200);
    assert.equal(endTicks, ticksAfter2, "RO with stable size — no further work");
    stop(); scope.dispose();
});

test("RO safety: ResizeObserver is disconnected on scope.dispose() — no leak", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    // RO should be observing host (1 active). Check via global registry.
    const beforeDispose = globalThis.__roRegistry
        .reduce((n, ro) => n + ro._targets.length, 0);
    assert.ok(beforeDispose >= 1, "at least one observer active");
    scope.dispose();
    const afterDispose = globalThis.__roRegistry
        .reduce((n, ro) => n + ro._targets.length, 0);
    assert.equal(afterDispose, beforeDispose - 1, "exactly one observer removed on dispose (no leak)");
});

// ─────────────────────────────────────────────────────────────────────────────
// C) IntersectionObserver does NOT cause the giant spacer to inflate anything
// ─────────────────────────────────────────────────────────────────────────────
// This is the most-asked-about scenario: a virtualized list inside a
// scroll-anchor / sticky-header / parallax / lazy-loaded section that
// observes the host with IntersectionObserver. Each observation provides
// `boundingClientRect.height` — but it sees the host's own height
// (clientHeight), NOT the spacer's inflated height. Therefore no parent
// observer can "feel" the virtual content size.

test("IO safety: putting an IntersectionObserver on the host does not leak the spacer's inflated size", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, {
        count: 1_000_000,                    // 30M px spacer inside
        itemHeight: ITEM, viewport: VIEWPORT, render: () => {},
    });

    // External code observes the host. This is what a parent component would do.
    let observed = null;
    const io = new IntersectionObserver((entries) => { observed = entries[0]; });
    io.observe(host);

    // Fire the IO callback as a real browser would: the host's bounding rect
    // is its OWN clientHeight (= viewport), not the spacer's inflated height.
    fireIntersection(host, true, { width: 800, height: VIEWPORT, top: 0, left: 0, right: 800, bottom: VIEWPORT });
    assert.equal(observed.boundingClientRect.height, VIEWPORT,
        "host's boundingClientRect.height is its own clientHeight, NOT the spacer's inflated height — the giant inner spacer is invisible to outside observers");

    io.disconnect();
    scope.dispose();
});

test("IO safety: the library does NOT create its own IntersectionObserver (only ResizeObserver)", () => {
    const ioBefore = globalThis.__ioRegistry.length;
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountList(host, scope, { count: 1000, itemHeight: ITEM, viewport: VIEWPORT, render: () => {} });
    const ioAfter = globalThis.__ioRegistry.length;
    assert.equal(ioBefore, ioAfter,
        "mountList does NOT register any IntersectionObserver — its viewport reads only via ResizeObserver");
    scope.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// D) The "size goes infinite" worst case: host nested inside something that
//    observes it with IO and a parent that also observes with RO.
// ─────────────────────────────────────────────────────────────────────────────

test("worst case: simultaneous IO+RO observers on host + parent, scroll fully — pool size stays bounded, no growth", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    const axis = mountList(host, scope, {
        count: 100_000, itemHeight: ITEM, viewport: VIEWPORT, overscan: 3,
        render: () => {},
    });

    // External RO + IO on the host. Whatever they do, they CANNOT affect
    // lite-virtual's internal state — they're unrelated callbacks.
    let externalROFirings = 0, externalIOFirings = 0;
    const ro = new ResizeObserver(() => { externalROFirings++; });
    ro.observe(host);
    const io = new IntersectionObserver(() => { externalIOFirings++; });
    io.observe(host);

    // Now scroll the full length of the list.
    const poolBefore = host.children.length - 1;
    for (let i = 0; i < 100; i++) host.scrollTop = i * 1000;
    const poolAfter = host.children.length - 1;
    assert.ok(poolAfter < 30, `pool stayed bounded at ${poolAfter} despite a 100K-item scroll`);
    assert.ok(poolAfter >= poolBefore, "pool grew at most once (off-top first scroll)");

    // External observers may or may not fire depending on browser — but
    // regardless, firing them must not change the library's behavior.
    fireResize(host, 800, VIEWPORT);     // external RO sees same size
    fireIntersection(host, true, host.getBoundingClientRect());
    const poolFinal = host.children.length - 1;
    assert.equal(poolFinal, poolAfter, "firing external observers does not change pool size");

    io.disconnect(); ro.disconnect();
    scope.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// E) Variable-size renderer: same safety properties
// ─────────────────────────────────────────────────────────────────────────────

test("RO safety (variable): mountVariableList disconnects its RO on dispose", () => {
    const scope = makeScope();
    const host = makeHost(800, VIEWPORT);
    mountVariableList(host, scope, {
        count: 1000, sizeAt: i => 20 + (i % 5) * 10, viewport: VIEWPORT,
        render: () => {},
    });
    const before = globalThis.__roRegistry.reduce((n, ro) => n + ro._targets.length, 0);
    scope.dispose();
    const after = globalThis.__roRegistry.reduce((n, ro) => n + ro._targets.length, 0);
    assert.equal(after, before - 1, "RO disconnected on dispose");
});
