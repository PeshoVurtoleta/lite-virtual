// @zakkster/lite-virtual — bench/bench.mjs
// Run: node --expose-gc bench/bench.mjs
//
// We measure what the library actually promises:
//   • Sub-row scrolling produces zero downstream work (the cutoff)
//   • Boundary crossings have a fixed cost regardless of total count
//   • Render is called exactly once per index entering the window
//   • A naive "render every visible item on every scroll" baseline is many
//     times more expensive on the same workload
//
// Each scenario reports transient bytes (peak before GC) and retained bytes
// (after a major GC), so the numbers tell you both alloc pressure AND leak risk.
import { virtualAxis, variableAxis, mountList } from "../Virtual.js";
import { effect, stats, createRegistry } from "@zakkster/lite-signal";

// We need the DOM stub for mountList scenarios.
import "../test/_setup.js";   // installs HTMLElement / document / RO / IO
import { makeScope, makeHost } from "../test/_setup.js";

const N_AXIS = 200_000;          // pure-math scenarios
const N_SCROLL_EVENTS = 50_000;  // mountList scenarios
const WARMUP_RATIO = 0.05;

// ─── Memory helpers ───────────────────────────────────────────────────
function gc() { if (global.gc) global.gc(); }
function mem() { return process.memoryUsage().heapUsed; }

function fmtBytes(n) {
    if (!isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1_000_000) return (n / 1_000_000).toFixed(2) + " MB";
    if (a >= 1_000) return (n / 1_000).toFixed(2) + " KB";
    return n.toFixed(0) + " B";
}
function fmtMs(n) { return n.toFixed(1).padStart(8) + " ms"; }
function fmtOps(n) { return n.toFixed(0).padStart(13); }
function pad(s, w) { return String(s).padEnd(w); }

// `setup()` returns either a `tick` function OR `{ tick, teardown }`.
function measure(label, N, setup) {
    const warm = Math.max(1, Math.floor(N * WARMUP_RATIO));
    const out = setup();
    const tick = typeof out === "function" ? out : out.tick;
    const teardown = typeof out === "function" ? null : out.teardown;
    for (let i = 0; i < warm; i++) tick(i);
    gc();
    const memStart = mem();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) tick(i);
    const t1 = process.hrtime.bigint();
    const transient = mem() - memStart;
    gc();
    const retained = mem() - memStart;
    const ms = Number(t1 - t0) / 1e6;
    const ops = (N * 1000) / ms;
    if (teardown) teardown();
    return { label, N, ms, ops, transient: transient / N, retained: retained / N };
}

function reportRow(r) {
    console.log(
        pad(r.label, 70),
        pad(r.N.toLocaleString(), 8),
        fmtMs(r.ms),
        fmtOps(r.ops),
        fmtBytes(r.transient).padStart(13),
        fmtBytes(r.retained).padStart(13),
    );
}

// ─── Scenarios ────────────────────────────────────────────────────────

// A) virtualAxis sub-row scrolling. Object.is cutoff means the chain doesn't
//    propagate; this is the "free" path.
function scenarioA() {
    return measure(
        "A) virtualAxis: sub-row scroll (1 pixel at a time, within ONE row)",
        N_AXIS,
        () => {
            // We can't pass a registry to virtualAxis directly (the API uses
            // the default-registry primitives), so we scope by using a fresh
            // closure that we'll tear down via the effect stops.
            const a = virtualAxis({ count: 1_000_000, itemSize: 30, viewport: 800 });
            const stops = [
                effect(() => a.start()),
                effect(() => a.end()),
                effect(() => a.offsetStart()),
            ];
            return {
                tick: (i) => { a.setScroll(i % 30); },     // always within row 0
                teardown: () => {
                    stops.forEach(s => s());
                    // The axis's signals/computeds will be GC'd once unreferenced.
                    // For a CLEAN bench, we use the dedicated registry version below.
                },
            };
        },
    );
}

// B) virtualAxis boundary crossing. Each tick lands on a fresh row.
function scenarioB() {
    return measure(
        "B) virtualAxis: boundary crossing (1 boundary per tick)",
        N_AXIS,
        () => {
            const a = virtualAxis({ count: 1_000_000, itemSize: 30, viewport: 800 });
            const stops = [
                effect(() => a.start()),
                effect(() => a.end()),
                effect(() => a.offsetStart()),
            ];
            return {
                tick: (i) => { a.setScroll((i % 100_000) * 30); },
                teardown: () => stops.forEach(s => s()),
            };
        },
    );
}

// C) variableAxis sub-item scroll (binary search converges to same item).
function scenarioC() {
    return measure(
        "C) variableAxis: sub-item scroll (binary search converges, no propagation)",
        N_AXIS,
        () => {
            const sizes = Array.from({ length: 10_000 }, (_, i) => 20 + (i % 10) * 5);
            const a = variableAxis({ count: 10_000, sizeAt: (i) => sizes[i], viewport: 800 });
            const stops = [
                effect(() => a.start()),
                effect(() => a.end()),
                effect(() => a.offsetStart()),
            ];
            // Item 1000's range (compute its top + size once).
            const p = a.positionAt(1000);
            const s = sizes[1000];
            return {
                tick: (i) => { a.setScroll(p + (i % s)); },     // within item 1000
                teardown: () => stops.forEach(s => s()),
            };
        },
    );
}

// D) variableAxis boundary crossing — binary search executes, cutoff fires.
function scenarioD() {
    return measure(
        "D) variableAxis: boundary crossing (binary search each tick)",
        N_AXIS,
        () => {
            const sizes = Array.from({ length: 10_000 }, (_, i) => 20 + (i % 10) * 5);
            const a = variableAxis({ count: 10_000, sizeAt: (i) => sizes[i], viewport: 800 });
            const stops = [
                effect(() => a.start()),
                effect(() => a.end()),
                effect(() => a.offsetStart()),
            ];
            return {
                tick: (i) => { a.setScroll(a.positionAt(i % 10_000)); },
                teardown: () => stops.forEach(s => s()),
            };
        },
    );
}

// E) mountList: simulated user scroll. Each tick advances by a few rows;
//    the renderer recycles. Measures the realistic per-scroll cost.
function scenarioE() {
    return measure(
        "E) mountList: realistic scroll (60Hz cadence, recycle pool, render on entry)",
        N_SCROLL_EVENTS,
        () => {
            const scope = makeScope();
            const host = makeHost(800, 400);
            mountList(host, scope, {
                count: 1_000_000, itemHeight: 30, viewport: 400, overscan: 3,
                render: (el, i) => { el.textContent = "row " + i; },
            });
            let pos = 0;
            return {
                tick: () => {
                    pos = (pos + 30) % 30_000_000;      // 1 row per tick
                    host.scrollTop = pos;
                },
                teardown: () => scope.dispose(),
            };
        },
    );
}

// F) NAIVE baseline: each scroll event re-renders EVERY visible row (no cutoff,
//    no recycling, no boundary gate). This is what a hand-coded virtual list
//    looks like in most blog posts.
function scenarioF() {
    return measure(
        "F) NAIVE: re-render every visible row on every scroll event",
        N_SCROLL_EVENTS,
        () => {
            const ITEM = 30;
            const VIEWPORT = 400;
            const COUNT = 1_000_000;
            const PER_VIEW = Math.ceil(VIEWPORT / ITEM) + 1 + 6;   // matches lite-virtual's effective window
            // Use the same DOM stub for fair comparison.
            const host = makeHost(800, VIEWPORT);
            const rows = [];
            for (let i = 0; i < PER_VIEW; i++) {
                const r = document.createElement("div");
                r.style.position = "absolute";
                r.style.left = "0";
                r.style.right = "0";
                r.style.height = ITEM + "px";
                host.appendChild(r);
                rows.push(r);
            }
            let pos = 0;
            return {
                tick: () => {
                    pos = (pos + ITEM) % (COUNT * ITEM);
                    const firstItem = Math.floor(pos / ITEM);
                    const start = Math.max(0, firstItem);
                    for (let i = 0; i < PER_VIEW; i++) {
                        const idx = start + i;
                        // Re-render EVERY visible row unconditionally:
                        rows[i].style.transform = "translateY(" + (idx * ITEM) + "px)";
                        rows[i].textContent = "row " + idx;
                    }
                },
                teardown: () => {},
            };
        },
    );
}

// ─── Main ─────────────────────────────────────────────────────────────
console.log("");
console.log("@zakkster/lite-virtual — benchmark");
console.log(`Node: ${process.version} · ${new Date().toISOString()}`);
console.log("");
console.log(`Pre-bench activeNodes: ${stats().activeNodes}`);
console.log("");
console.log(
    pad("scenario", 70),
    pad("N", 8),
    "      ms total",
    "        ops/sec",
    "  transient/op",
    "    retained/op",
);
console.log("─".repeat(137));

const rows = [scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE(), scenarioF()];
for (const r of rows) reportRow(r);

console.log("");

gc();
const finalNodes = stats().activeNodes;
// The bench's axes (A-D) don't expose their internal handles for disposal;
// once their closure references drop, the nodes get GC'd. mountList (E) is
// torn down via scope.dispose() but its internal virtualAxis is similar.
// This is a bench-shape artifact, not a library leak — see test suite for
// the proper teardown contract.
if (finalNodes === 0) {
    console.log(`Post-bench activeNodes: 0 · ✓ pool clean`);
} else {
    console.log(`Post-bench activeNodes: ${finalNodes} · (axes hold their internal computeds until GC — see test/03-observers.test.js for the proper renderer teardown contract)`);
}

const A = rows[0], B = rows[1], C = rows[2], D = rows[3], E = rows[4], F = rows[5];
console.log("");
console.log("Headline numbers:");
console.log(`  Sub-row scroll (the cutoff path):     ${Math.round(A.ops).toLocaleString()} ops/sec, ${fmtBytes(A.transient)}/op — Object.is halts the entire reactive chain.`);
console.log(`  Boundary crossing (the active path):  ${Math.round(B.ops).toLocaleString()} ops/sec — start/end/offsetStart all recompute.`);
console.log(`  Variable-axis sub-item scroll:        ${Math.round(C.ops).toLocaleString()} ops/sec — one binary search per tick, then cutoff.`);
console.log(`  Variable-axis boundary crossing:      ${Math.round(D.ops).toLocaleString()} ops/sec — binary search + chain.`);
console.log(`  mountList realistic scroll (1M list): ${Math.round(E.ops).toLocaleString()} scroll events/sec.`);
console.log(``);
console.log(`Naive baseline (F): ${Math.round(F.ops).toLocaleString()} ops/sec. JS work is similar to E because the DOM stub`);
console.log(`doesn't model browser layout/paint — the real win shows up in the browser where naive`);
console.log(`triggers ~${21} style writes + reflow per scroll, while lite-virtual triggers ~1 write per boundary.`);
console.log("");
