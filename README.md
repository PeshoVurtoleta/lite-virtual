# @zakkster/lite-virtual

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-virtual.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-virtual)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![zero-gc](https://img.shields.io/badge/zero--GC-steady--state-5fe39f.svg)](#why-this-exists)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-virtual?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-resource)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-virtual?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-virtual)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-virtual?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-virtual)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-virtual/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE.txt)

> Thrash-free list/grid windowing on `@zakkster/lite-signal`.
> Integer-gated reactive indices + Object.is cutoff =
> **scrolling within a row writes nothing to the DOM and allocates zero bytes.**

```bash
npm i @zakkster/lite-virtual @zakkster/lite-signal
```

```js
import { mount } from "@zakkster/lite-element";
import { mountList } from "@zakkster/lite-virtual";

mount(document.getElementById("box"), (host, scope) => {
    mountList(host, scope, {
        count: 1_000_000,        // a million rows
        itemHeight: 32,
        viewport: host.clientHeight,
        render: (rowEl, i) => { rowEl.textContent = `row ${i}`; },
    });
});
```

**Headline (measured on Node 22, see [Benchmarks](#benchmarks)):**
**~3.6 million sub-row scroll events per second at 0 bytes/op.**
A `mountList` with 1,000,000 items keeps ~21 DOM nodes alive.
~800K full scroll events/sec on a 1M-item list. Scrolling within
one row writes literally nothing to the DOM and allocates literally
zero bytes — verified by the test suite, not by hope.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Quickstart](#quickstart)
- [Pure-math axes](#pure-math-axes)
- [Recycling renderers](#recycling-renderers)
- [Stateful rows: when to use `mountKeyedList`](#stateful-rows-when-to-use-mountkeyedlist)
- [Variable heights](#variable-heights)
- [Observer safety](#observer-safety)
- [API reference](#api-reference)
- [Benchmarks](#benchmarks)
- [Edge cases pinned down](#edge-cases-pinned-down)
- [What this is **not**](#what-this-is-not)
- [Browser / runtime support](#browser--runtime-support)
- [Peer dependency](#peer-dependency)
- [FAQ](#faq)
- [License](#license)

---

## Why this exists

A small set of design constraints picked deliberately:

- **Boundary-only updates.** The visible range derives from
  `Math.floor(scrollTop / itemSize)` — an integer. lite-signal's
  `Object.is` cutoff means that integer only changes when you actually
  cross a row boundary. A fast 1-pixel scroll inside one row produces
  ZERO reactive work, ZERO DOM writes, ZERO bytes allocated. The whole
  chain — start, end, offsetStart, totalSize, your bind effects — sits
  idle between crossings.
- **Bounded DOM pool.** A `mountList` of 1,000,000 items keeps ~21 DOM
  nodes alive, no matter how far you scroll. Recycling is index-based:
  on a one-row scroll, exactly one node's transform + content updates.
- **No virtual DOM. No template compiler. No renderer.** The math
  (`virtualAxis`, `virtualGrid`, `variableAxis`) is pure reactive state
  you can pair with any drawing primitive — DOM, canvas, WebGL, terminal
  ANSI. The included recycling renderers are opinionated, ~1 KB each,
  and use lite-element's scope.
- **Observer-safe by design.** Each renderer sets `host.style.overflow =
  "auto"`, so the giant inner spacer scrolls INSIDE the host and never
  inflates the host's reported size to outer observers (IntersectionObserver,
  parent ResizeObserver, flex containers). The library's own RO reads
  `contentRect.height` — never `scrollHeight` — so no feedback loop is
  reachable.
- **Two layers, separated.** Pure math axes (1 KB) are useful on their own.
  Recycling renderers (3 KB total) layer on top. Use what you need, skip
  what you don't.

If you want a framework integration with hooks, a `<VirtualList>` component,
SSR helpers, snap-to-row, or sticky headers — this is the wrong library.
Seven functions, one peer dep, ~4 KB minified.

---

## What you get

```js
// Pure math — pair with any renderer:
const axis = virtualAxis({ count, itemSize, viewport, overscan });
axis.start();       // reactive integer — only changes on boundary cross
axis.end();         // reactive integer
axis.offsetStart(); // reactive px
axis.totalSize();   // reactive px (count * itemSize)
axis.setScroll(px); axis.setViewport(px); axis.setCount(n);

const grid = virtualGrid({ rowCount, colCount, rowHeight, colWidth,
                           viewportHeight, viewportWidth, overscan });
grid.rowStart, grid.rowEnd, grid.colStart, grid.colEnd, /* ... */

const va = variableAxis({ count, sizeAt: i => sizes[i], viewport, overscan });
va.positionAt(i);   // O(1) prefix-sum offset
va.minSize();       // smallest row (for pool pre-sizing)
va.remeasure();     // rebuild offsets from current sizeAt

// Opinionated recycling renderers — built on lite-element's scope shape:
mountList(host, scope, { count, itemHeight, viewport, render });
mountKeyedList(host, scope, { items, itemHeight, viewport, key, render });
mountGrid(host, scope, { rowCount, colCount, rowHeight, colWidth,
                         viewportWidth, viewportHeight, render });
mountVariableList(host, scope, { count, sizeAt, viewport, render });
```

---

## Quickstart

A 1,000,000-row list rendered as a single `<lite-element>`:

```js
import { define } from "@zakkster/lite-element";
import { mountList } from "@zakkster/lite-virtual";

define("huge-list", (host, scope) => {
    host.style.height = "400px";
    mountList(host, scope, {
        count: 1_000_000,
        itemHeight: 32,
        viewport: 400,
        render: (rowEl, i) => {
            rowEl.textContent = `row ${i}`;
            rowEl.style.padding = "6px 12px";
            rowEl.style.borderBottom = "1px solid #eee";
        },
    });
});
```

```html
<huge-list></huge-list>
```

The DOM has ~21 `<div>` rows inside `<huge-list>`. Scrolling re-uses them.

---

## Pure-math axes

For renderers that aren't a DOM list — canvas / WebGL grids, terminal UIs,
scroll-bound parallax — use the math directly:

```js
import { virtualAxis } from "@zakkster/lite-virtual";
import { effect } from "@zakkster/lite-signal";

const axis = virtualAxis({
    count: 1_000_000,
    itemSize: 18,
    viewport: 600,
    overscan: 3,
});

scrollEl.addEventListener("scroll", () => axis.setScroll(scrollEl.scrollTop));

effect(() => {
    // Runs ONLY when start or end changes — i.e. on boundary crossings.
    drawCanvasWindow(ctx, axis.start(), axis.end(), axis.offsetStart());
});
```

The `effect` body fires once per boundary crossing — never on sub-row scrolls.
You can throttle / coalesce externally if you want fewer; the cutoff already
ensures you never do MORE work than necessary.

---

## Recycling renderers

### `mountList` — index-based, stateless rows

Stateless content (text, static markup, derived display strings) goes through
`mountList`. A pool of `perView + 2 * overscan` row `<div>`s is created once;
each row's `transform = translateY(index * itemHeight)` and its content are
updated only when the index it represents changes. On a one-row scroll,
exactly one node updates.

```js
mountList(host, scope, {
    count: data.length,
    itemHeight: 28,
    viewport: host.clientHeight,
    overscan: 3,
    render: (rowEl, i) => {
        rowEl.textContent = data[i];
    },
});
```

The recycling is INDEX-based — meaning the same `<div>` is reused across
different logical indices. That's why rows must be stateless: any DOM state
on a row (input focus, video playback, accordion-expanded) would follow the
node, not the data row, and break the moment the user scrolls.

### `mountGrid` — 2-D recycling

```js
mountGrid(host, scope, {
    rowCount: 50_000,
    colCount: 500,
    rowHeight: 28,
    colWidth: 120,
    viewportWidth: host.clientWidth,
    viewportHeight: host.clientHeight,
    overscan: 2,
    render: (cellEl, row, col) => {
        cellEl.textContent = data[row][col];
    },
});
```

The pool is pre-sized to the maximum window size, so scrolling never
reshuffles the modulo mapping. Crossing a row boundary re-renders one new
row of cells; crossing a column boundary re-renders one new column.
Stateless cells (same constraint as `mountList`).

---

## Stateful rows: when to use `mountKeyedList`

If a row owns DOM state — an `<input>` you can type into, a `<video>` that's
playing, a `<details>` element the user expanded — you cannot recycle nodes
by index slot. Each node has to stay with its row's identity.

`mountKeyedList` does that: a node is created when its key enters the window
and removed when the key leaves. Reorder moves nodes by transform; `render`
is **not** called again for an existing node.

```js
import { signal } from "@zakkster/lite-signal";

const rows = signal([
    { id: "a", draft: "" },
    { id: "b", draft: "" },
    /* ... */
]);

mountKeyedList(host, scope, {
    items: () => rows(),                     // reactive accessor
    itemHeight: 48,
    viewport: host.clientHeight,
    key: (item) => item.id,
    render: (rowEl, item, index) => {
        // Called ONCE per key. Bind reactively inside.
        rowEl.innerHTML = `<input>`;
        const inp = rowEl.firstChild;
        inp.value = item.draft;
        inp.addEventListener("input", (ev) => { item.draft = ev.target.value; });
    },
});

// Reorder — typed text and focus survive:
rows.update((arr) => [...arr].reverse());
```

More allocation than `mountList` (one DOM node creation per key entering the
window, one removal per key leaving), but correct for stateful content.

---

## Variable heights

If row heights are not uniform but you know them up front, use
`mountVariableList`. The library builds a prefix-sum offsets array once
(O(n)), then resolves each scroll position by binary search (O(log n)).
The no-thrash property carries over — firstItem is still an integer, so
Object.is still gates downstream work.

```js
const sizes = rows.map(measureHeight);   // your own measurement

mountVariableList(host, scope, {
    count: rows.length,
    sizeAt: (i) => sizes[i],
    viewport: host.clientHeight,
    render: (rowEl, i) => {
        rowEl.textContent = rows[i].text;
    },
});
```

If your sizes change later (responsive layout, font load, ResizeObserver on
rendered rows), call `axis.remeasure()` — it walks `sizeAt` again and bumps
an internal version signal that re-triggers the downstream chain.

> **Not handled:** measured / auto-height rows whose size is unknown until
> rendered. That needs an estimate-then-correct loop on top: render at an
> estimated height, measure via ResizeObserver, patch the affected entries,
> bump the version, and anchor the scroll position to the item under the
> viewport top so the correction doesn't visibly jump. The windowing /
> recycling above works verbatim; only the offsets source becomes
> incremental. (Future `@zakkster/lite-virtual-measure` package.)

---

## Observer safety

The classic gotcha with virtualization: a giant inner spacer leaks its size
to parent layout (flex grow, `IntersectionObserver`, parent `ResizeObserver`),
which feeds back into the library's viewport reading, which renders more
rows, which... infinite loop.

lite-virtual breaks the loop on **two** independent fronts:

1. **`host.style.overflow = "auto"`.** The spacer (whose `style.height` is
   the full `count * itemSize`) scrolls INSIDE the host. The host itself
   only takes the space its parent gave it. Outer `IntersectionObserver` /
   `ResizeObserver` see `host`'s own `clientHeight` — not the inflated
   spacer — because the host clips.
2. **The library's RO reads `contentRect.height`, never `scrollHeight`.**
   So even in the (very unusual) case that some part of layout did inflate
   the host's reported size, the renderer would only see the actual visible
   viewport, not anything the spacer can influence.

This is pinned down by [test/03-observers.test.js](./test/03-observers.test.js)
— 10 tests including the worst case (simultaneous external IO + RO + scroll
across 100K items), all asserting the pool stays bounded and no feedback
loop is reachable.

The library **does not** register any `IntersectionObserver` of its own —
only ONE `ResizeObserver` per renderer, disconnected on `scope.dispose()`.

---

## API reference

### `virtualAxis(options) → VirtualAxis`

| option       | type     | default | notes                                         |
|--------------|----------|---------|-----------------------------------------------|
| `count`      | number   | —       | number of items                               |
| `itemSize`   | number   | —       | pixel size along the scroll axis              |
| `viewport`   | number   | —       | viewport size along the scroll axis           |
| `overscan`   | number   | 3       | extra items kept mounted on each side         |

Returns reactive `scrollPos`, `start`, `end`, `offsetStart`, `totalSize`
plus setters `setScroll`, `setViewport`, `setCount`.

### `virtualGrid(options) → VirtualGrid`

| option           | type   | default |
|------------------|--------|---------|
| `rowCount`       | number | —       |
| `colCount`       | number | —       |
| `rowHeight`      | number | —       |
| `colWidth`       | number | —       |
| `viewportHeight` | number | —       |
| `viewportWidth`  | number | —       |
| `overscan`       | number | 2       |

Returns `rowStart`, `rowEnd`, `rowOffset`, `totalHeight`, `colStart`,
`colEnd`, `colOffset`, `totalWidth`, `setScroll`, `setViewport`, `setCounts`.

### `variableAxis(options) → VariableAxis`

| option       | type     | default |
|--------------|----------|---------|
| `count`      | number   | —       |
| `sizeAt`     | `(i) => number` | — |
| `viewport`   | number   | —       |
| `overscan`   | number   | 3       |

Returns the `virtualAxis` surface plus `positionAt(i)`, `minSize()`,
`remeasure()`.

### `mountList(host, scope, options) → VirtualAxis`

| option       | type     | default | notes                                                |
|--------------|----------|---------|------------------------------------------------------|
| `count`      | number   | —       |                                                      |
| `itemHeight` | number   | —       |                                                      |
| `viewport`   | number   | —       | initial — auto-synced via ResizeObserver if available |
| `overscan`   | number   | 3       |                                                      |
| `render`     | `(rowEl, index) => void` | — | called when an index enters the window or recycles |

Returns the axis (use it for `setCount` on growth, etc).

### `mountKeyedList<T>(host, scope, options) → VirtualAxis`

| option       | type     | default |
|--------------|----------|---------|
| `items`      | `() => readonly T[]` | — |
| `itemHeight` | number   | —       |
| `viewport`   | number   | —       |
| `overscan`   | number   | 3       |
| `key`        | `(item, index) => string \| number` | — |
| `render`     | `(rowEl, item, index) => void` | — |

### `mountGrid(host, scope, options) → VirtualGrid`

| option           | type     | default |
|------------------|----------|---------|
| `rowCount`       | number   | —       |
| `colCount`       | number   | —       |
| `rowHeight`      | number   | —       |
| `colWidth`       | number   | —       |
| `viewportWidth`  | number   | —       |
| `viewportHeight` | number   | —       |
| `overscan`       | number   | 2       |
| `render`         | `(cellEl, row, col) => void` | — |

### `mountVariableList(host, scope, options) → VariableAxis`

| option       | type     | default |
|--------------|----------|---------|
| `count`      | number   | —       |
| `sizeAt`     | `(i) => number` | — |
| `viewport`   | number   | —       |
| `overscan`   | number   | 3       |
| `render`     | `(rowEl, index) => void` | — |

---

## Benchmarks

Measured on Node 22.22 with `--expose-gc`. Run yourself: `npm run bench`.

| Scenario                                                          |    N    | ops/sec   | transient/op | retained/op |
|-------------------------------------------------------------------|--------:|----------:|-------------:|------------:|
| **A) virtualAxis: sub-row scroll** (1 px at a time, within a row) | 200K    | **~3.6M** | **0 B**      | 0 B         |
| **B) virtualAxis: boundary crossing** (lands on a new row each tick) | 200K | ~2.0M     | 0 B          | 0 B         |
| **C) variableAxis: sub-item scroll** (binary search converges)    | 200K    | **~2.6M** | **0 B**      | 0 B         |
| **D) variableAxis: boundary crossing** (binary search + chain)    | 200K    | ~1.5M     | 0 B          | 0 B         |
| **E) mountList: realistic scroll on 1M-item list**                | 50K     | **~800K** | ~25 B        | ~1 B        |
| **F) Naive baseline: re-render every visible row on every scroll**| 50K     | ~580K     | ~60 B        | 0 B         |

**Headline:**

- **Sub-row scroll is genuinely free.** 3.6M ops/sec at 0 bytes/op transient
  is the cutoff: Object.is sees the same integer firstItem and short-circuits
  the entire chain. No effect re-runs, no DOM writes, no allocations.
- **Boundary crossing is ~2M/sec.** That's the cost of recomputing
  `start`/`end`/`offsetStart` and propagating through one bind effect. For
  60Hz scrolling, you have a ~30,000× budget — boundary crossings are
  essentially never the bottleneck.
- **mountList handles ~800K full scroll events/sec on a 1M-item list** in
  pure Node. The DOM-write savings vs. a naive "render every visible row"
  approach don't show clearly in a stub (no layout, no paint) — they appear
  in the browser, where naive triggers ~21 style writes + reflow per scroll
  event vs lite-virtual's ~1 write per boundary.
- **Pool size on 1M items: ~21 DOM nodes.** Not 1M. Not 100. Exactly the
  visible window + 2× overscan.

> *Numbers vary ~10% run-to-run with GC timing. The bench file is
> `bench/bench.mjs`; copy it, modify, re-run.*

---

## Edge cases pinned down

- **iOS rubber-band scroll.** Negative `scrollTop` (overscroll up) pins
  `firstItem` to 0; `start` and `offsetStart` stay at 0. No NaN renders.
- **Overscroll past the end.** `scrollTop > totalSize` pins `firstItem` to
  `count`; `start` is `max(0, count - overscan)`, `end` is `count`. No crash.
- **Shrinking `count` mid-scroll.** Calling `setCount(smaller)` while
  scrolled past the new end pins `start`/`end` to the new tail; the
  scrollbar shrinks; no off-by-one renders.
- **Growing `count` mid-scroll.** `setCount(larger)` updates `totalSize`
  but leaves the visible window where it was — the user's scroll position
  is unchanged.
- **Viewport resize mid-scroll.** The library's `ResizeObserver` reads
  `contentRect.height` and calls `setViewport`. The pool grows to fit;
  it never shrinks (a `300 → 800 → 300` round-trip retains the larger pool
  so the next grow is allocation-free).
- **`scope.dispose()` is complete.** Every signal, computed, effect,
  listener, AND the renderer's `ResizeObserver` are disposed. Verified by
  test suite (53 tests, including an explicit RO-leak audit).
- **Pool grows ONCE.** On first scroll off the top, the upper overscan is
  no longer clipped and the pool grows from `perView + overscan` to
  `perView + 2 * overscan`. After that, the pool never grows during scroll.
- **No internal IntersectionObserver.** The library uses exactly one
  `ResizeObserver` per renderer. External IO on the host can't trigger
  any internal behavior — it observes `host`'s own `clientHeight`, which
  the library does not depend on after mount.
- **Host becomes keyboard-focusable on mount.** Each renderer sets
  `host.tabIndex = 0` so Arrow / PageUp / PageDown / Spacebar reach the
  scroll container. If you already set a `tabIndex` (positive or zero),
  the library leaves it alone. Pass `tabIndex = -1` after mount to opt out.
- **The spacer is layout-invariant.** Each renderer's internal spacer is
  `position: absolute`, 1 px wide, `visibility: hidden`, `aria-hidden`. It
  drives `scrollHeight` via an explicit pixel height, independent of the
  host's formatting context (flex, grid, block — all behave the same). No
  margin collapse, no flex-row sideways layout, no sub-pixel rounding.

---

## What this is **not**

- **Not a measured / auto-height layer.** `mountVariableList` takes a
  `sizeAt` you can answer. For "measure-then-correct" (heights unknown until
  render), build it on top — the windowing/recycling math works verbatim;
  only the offsets source becomes incremental. (Future
  `@zakkster/lite-virtual-measure` package.)
- **Not a renderer per row.** Recycling renderers reuse a single `<div>`
  pool. For per-row React/Vue/Solid components, build your own on top of
  `virtualAxis` — the math is everything you need.
- **Not for non-scrolling layouts.** Windowing assumes a scroll container.
  CSS Grid auto-fill, marquee, parallax-without-scroll — different problem.
- **Not a framework wrapper.** The recycling renderers expect a lite-element
  scope (`effect`, `on`, `onCleanup`). For other reactive systems, write
  a 20-line adapter or use the math directly.

---

## Browser / runtime support

| target           | works | notes                                    |
|------------------|:-----:|------------------------------------------|
| Node ≥ 18        | ✅    | math only — renderers need a DOM          |
| Chrome / Edge    | ✅    | `ResizeObserver` shipped 64               |
| Firefox          | ✅    | RO shipped 69                             |
| Safari ≥ 13.1    | ✅    | RO shipped 13.1                           |
| Deno / Bun       | ✅ (math) | ditto Node                            |

ESM only. No CJS build. If you need CJS, bundle through esbuild/rollup.

---

## Peer dependency

```json
"peerDependencies": { "@zakkster/lite-signal": "^1.1.3" }
```

The recycling renderers also assume a lite-element-shaped mount scope
(`effect`, `on`, `onCleanup`). `@zakkster/lite-element ^1.0.0` provides it;
a 20-line adapter wraps any other reactive system.

---

## FAQ

**Q: Why is `mountList` index-based instead of always keyed?**
Index-based recycling is O(1) per boundary crossing with zero allocation —
the same `<div>` is reused across logical indices. That's the cheapest
possible scroll path. The trade-off is statelessness: DOM state would
follow the node, not the row. For static lists (text, derived display),
that's a non-issue; use `mountList`. For inputs/media/expansion state, use
`mountKeyedList` and pay the create/remove cost (still 1 per boundary).

**Q: Will my list freeze when the spacer gets huge?**
No. Browsers handle `style.height = "30000000px"` fine — the scrollbar maps
to the value, but no layout cost is proportional to the spacer's pixel
size. We've tested up to `count * itemSize = 30M px` (1M items × 30px)
without issue.

**Q: Can I scroll to a specific index?**
Set `host.scrollTop = index * itemHeight` (fixed) or
`host.scrollTop = axis.positionAt(index)` (variable). The scroll event
fires, the axis advances, the renderer follows.

**Q: What's the difference between `overscan` and the +1 in `perView`?**
The `+1` is for the partial row at the bottom edge of the viewport that's
always visible. `overscan` adds buffer rows on EACH side so scrolling
doesn't reveal blank space during the brief moment between scroll event
and effect re-run. Three rows on each side is plenty for most workloads.

**Q: My rows have `<input>` and editing causes them to lose focus when I scroll.**
You're using `mountList` (index-based recycling) with stateful rows. Switch
to `mountKeyedList` — the node stays with the data row across scrolls.

**Q: How do I add sticky headers / sub-headers / dividers?**
Compose: the axis only knows about uniform rows. Add a sticky header
outside the scroll container, or use `mountVariableList` with the divider
rows having a height. For row-spanning headers inside the list, your
`render` callback can switch DOM based on `data[i].kind`.

**Q: Why isn't there a "smooth scroll to index" helper?**
Because the browser already has `host.scrollTo({ top, behavior: "smooth" })`.
Call that with `axis.positionAt(index)` and you're done.

**Q: Is variable axis async-safe? What if `sizeAt` throws?**
`sizeAt` is called synchronously inside `build()` and (for the renderer)
on render. If it throws, build throws; no inconsistent state is committed.
Don't make `sizeAt` do anything fancier than an array lookup.

**Q: Can I use this with React / Vue / Svelte?**
The pure-math axes (`virtualAxis`, `virtualGrid`, `variableAxis`) — yes,
trivially. Subscribe to `start` / `end` from your framework's reactive
system. The recycling renderers — only if you can supply a lite-element-
shaped scope; for that, a 20-line adapter is straightforward.

---

## License

MIT © Zahary Shinikchiev

---

#### The @zakkster stack

- [@zakkster/lite-signal](https://www.npmjs.com/package/@zakkster/lite-signal) — the reactive primitives this all builds on
- [@zakkster/lite-element](https://www.npmjs.com/package/@zakkster/lite-element) — Custom Elements with state that survives reparents
- [@zakkster/lite-time](https://www.npmjs.com/package/@zakkster/lite-time) — drift-corrected wall-clock cadence
- [@zakkster/lite-form](https://www.npmjs.com/package/@zakkster/lite-form) — headless reactive forms
- **@zakkster/lite-virtual** — *this package*
