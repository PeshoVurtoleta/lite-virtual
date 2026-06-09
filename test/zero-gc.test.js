// Zero-GC contract for lite-virtual's headline claim:
//
//   "scrolling within a row writes nothing to the DOM and allocates zero bytes"
//
// We measure retained heap delta across N sub-row scroll calls (firstItem
// unchanged the whole time). The Object.is cutoff inside virtualAxis /
// variableAxis / measuredAxis must hold, so the entire chain skips work and
// retained allocation hovers at zero. Skips automatically without --expose-gc.
//
// A regression that, say, allocated a fresh object for the floor() result, or
// dropped the cutoff on offsetStart, or introduced a per-scroll subscriber-list
// growth, would push retained bytes well past these thresholds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { virtualAxis, variableAxis, measuredAxis } from "../Virtual.js";

const hasGc = typeof global !== "undefined" && typeof global.gc === "function";

function steadyState(axis, scrollFn, N) {
    let s = 0, e = 0;
    const stop = effect(() => { s = axis.start(); e = axis.end(); });

    // Warm V8
    for (let i = 0; i < 5_000; i++) scrollFn(axis, i);
    global.gc(); global.gc();

    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) scrollFn(axis, i);
    global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    stop();
    return { retained, perOp: retained / N };
}

test("zero-GC: virtualAxis sub-row scroll retains ~0 B/op across 50k iterations", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const a = virtualAxis({ count: 1_000_000, itemSize: 30, viewport: 400, overscan: 3 });
    // All scrolls stay inside item 0 (0..29 px) -- firstItem is always 0.
    const { perOp, retained } = steadyState(a, (axis, i) => axis.setScroll(15 + (i & 3)), 50_000);
    // < 1 B/op is the contract; real value is ~0.04 B/op.
    assert.ok(perOp < 1, `virtualAxis sub-row expected < 1 B/op retained; got ${perOp.toFixed(3)} (${retained} B / 50000)`);
});

test("zero-GC: variableAxis sub-item scroll retains ~0 B/op (cutoff after binary search)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const a = variableAxis({ count: 100_000, sizeAt: (k) => 30 + (k % 5) * 10, viewport: 400, overscan: 3 });
    const { perOp, retained } = steadyState(a, (axis, i) => axis.setScroll(15 + (i & 3)), 50_000);
    assert.ok(perOp < 1, `variableAxis sub-item expected < 1 B/op retained; got ${perOp.toFixed(3)} (${retained} B / 50000)`);
});

test("zero-GC: measuredAxis sub-item scroll retains ~0 B/op (Fenwick + cutoff)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const a = measuredAxis({ count: 100_000, estimateSize: 30, viewport: 400, overscan: 3 });
    const { perOp, retained } = steadyState(a, (axis, i) => axis.setScroll(15 + (i & 3)), 50_000);
    assert.ok(perOp < 1, `measuredAxis sub-item expected < 1 B/op retained; got ${perOp.toFixed(3)} (${retained} B / 50000)`);
});

// Boundary crossings DO allocate (subscriber notifications, new offsetStart, etc).
// We bound them too -- one boundary cross shouldn't be more than a few dozen bytes.
test("zero-GC: virtualAxis boundary crossing stays under 50 B/op retained", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const a = virtualAxis({ count: 1_000_000, itemSize: 30, viewport: 400, overscan: 3 });
    // Each setScroll lands on a fresh row boundary.
    const { perOp, retained } = steadyState(a, (axis, i) => axis.setScroll((i % 1000) * 30), 50_000);
    assert.ok(perOp < 50, `boundary cross expected < 50 B/op retained; got ${perOp.toFixed(3)} (${retained} B / 50000)`);
});
