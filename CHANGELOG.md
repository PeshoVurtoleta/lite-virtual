# Changelog

All notable changes to `@zakkster/lite-virtual` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-06-09

Additive release. No breaking changes; pure surface growth on top of 1.0.

### Added

- **`measuredAxis({ count, estimateSize, viewport, overscan? })`** — measured /
  auto-height axis for rows whose size is unknown until rendered. Every item
  starts at `estimateSize`; the renderer reports each row's real height via
  `measure(index, size)`. A Fenwick (binary-indexed) tree over the size array
  makes each correction **O(log n)**, and `positionAt` / find-by-position queries
  **O(log n)** too — a single measured row patches every downstream offset
  without an O(n) rebuild. `firstIndex` is still an integer, so the Object.is
  no-thrash property carries over. Surface: `positionAt`, `sizeAt`, `minSize`,
  `measure`, `remeasure`, plus the standard axis methods.
- **`mountMeasuredList(host, scope, { count, estimateSize, viewport, overscan?, render })`**
  — measured-height list renderer. A `ResizeObserver` reports each row's real
  height, the axis is patched, and the scroll is re-anchored to the item under
  the viewport top so an above-the-fold correction does not visibly jump.
  Stateless rows; same recycling discipline as `mountList`. Returns the
  underlying `MeasuredAxis`.
- **`firstIndex` reactive accessor** on all axes (`virtualAxis`, `variableAxis`,
  `measuredAxis`). Same value the rest of the axis derives `start`/`end` from;
  exposed so consumers (e.g. `stickyHeader`) can read it without recomputing.
- **`MountListOptions.horizontal`** + **`MountListOptions.itemSize`** alias —
  `mountList` now scrolls horizontally when `horizontal: true` (uses
  `scrollLeft` + `translateX`); `itemSize` is an alias for `itemHeight` that
  reads more cleanly in horizontal lists.
- **Zero-GC contract test** in `test/zero-gc.test.js` — locks in the
  sub-row-scroll headline claim (< 1 B/op retained across 50k iterations).
  Auto-skipped without `--expose-gc`; full 70/70 run via `npm run test:gc`.

### Documentation

- Restructured test suite: split the original `virtual.test.js` into five
  focused files (`01-axis` through `05-variable`) plus the original suite
  renamed to `06-measured-and-helpers.test.js`. 66 deterministic tests across
  six files plus 4 zero-GC contract tests = **70 total**. See `llms.txt` for
  the per-file breakdown.

## [1.0.0] — 2026-04-XX

Initial release.

### Added

- **`virtualAxis({ count, itemSize, viewport, overscan? })`** — fixed-size
  1-D windowing. `floor(scrollPos / itemSize)` produces an integer
  `firstItem`, so Object.is gates `start` / `end` / `offsetStart` — sub-row
  scroll is allocation-free and DOM-write-free. Overscroll pinned at both
  ends (iOS rubber-band → top; scroll-past-end → tail). Surface:
  `scrollPos`, `start`, `end`, `offsetStart`, `totalSize`, `firstIndex`,
  `count()`, `offsetForIndex(index, align?)`, `setScroll`, `setViewport`,
  `setCount`.
- **`virtualGrid({ rowCount, colCount, rowHeight, colWidth, viewportHeight, viewportWidth, overscan? })`**
  — 2-D windowing. Independent row + column axes sharing the same math.
  Scrolling within a cell does nothing; scrolling along one axis does not
  retrigger the other.
- **`variableAxis({ count, sizeAt, viewport, overscan? })`** — variable-size
  1-D windowing for known heights. Prefix sums built once (O(n));
  scroll-to-item by binary search (O(log n)). Sub-item scroll still hits the
  Object.is cutoff. Surface adds `positionAt(i)` (O(1)), `minSize()`,
  `remeasure()`.
- **`mountList(host, scope, { count, itemHeight, viewport, overscan?, render })`**
  — index-based recycling renderer. Circular-buffer pool with absolute-
  positioned rows; the `idx !== i` guard re-renders exactly the freshly
  entered node. Pool size = `perView + 2*overscan` regardless of `count`.
  Stateless rows only.
- **`mountKeyedList(host, scope, { items, itemHeight, viewport, overscan?, key, render })`**
  — keyed renderer for stateful rows. A node is created when its key enters
  the window and removed when it leaves; identity stays with the data key.
  Reorder moves nodes by transform, `render()` is not called again.
- **`mountGrid(host, scope, { rowCount, colCount, rowHeight, colWidth, viewportWidth, viewportHeight, overscan?, render })`**
  — 2-D recycling renderer. Pool pre-sized to max window so scrolling
  never reshuffles the modulo mapping. Stateless cells.
- **`mountVariableList(host, scope, { count, sizeAt, viewport, overscan?, render })`**
  — variable-height list renderer. Pool pre-sized from the smallest row
  (`ceil(viewport/minSize) + 1 + 2*overscan`) so the recycling map never
  reshuffles mid-scroll.
- **`onEndReached(axis, { distance?, onReached })`** — infinite-loader trigger.
  Fires `onReached` once when the window comes within `distance` items of
  the end, and again only after `count()` grows. Headless: works with any
  axis exposing `count()` + `end`.
- **`stickyHeader(firstIndex, groupStarts)`** — sticky group-header resolver.
  Given an axis's `firstIndex` accessor and a sorted ascending array of
  group-start indices, returns a computed of the 0-based ordinal of the
  group at the top of the viewport (-1 before the first group).

### Architectural invariants

- **Boundary-only updates.** Sub-row scroll triggers zero reactive work
  (Object.is cutoff after the integer `firstItem`).
- **Bounded pool.** DOM node count is `perView + 2*overscan`, independent of
  `count`. Pool grows once on first off-top scroll, then stays put.
- **Observer-safe isolation.** Each renderer sets `host.style.overflow =
  "auto"` and `host.style.position = "relative"`, so the giant inner spacer
  scrolls INSIDE the host and never inflates the host's reported size to
  outer observers (IntersectionObserver / ResizeObserver / flex parents).
  The library's own `ResizeObserver` reads `contentRect`, never
  `scrollHeight` — no feedback loop is reachable.
- **No internal `IntersectionObserver`.** A single `ResizeObserver` per
  renderer keeps `viewport` synced. IO is the caller's business and won't
  see anything inflated.
- **`scope.dispose()` is complete.** All ROs disconnect, all effects stop,
  all listeners detach. Verified by the suite.
- **Host becomes keyboard-focusable.** Renderers set `host.tabIndex = 0`
  only if the caller has not pre-set one.
- **Internal spacer is layout-invariant** — `position: absolute`, 1 px on
  the cross axis, `visibility: hidden`, `aria-hidden`. Survives any parent
  formatting context (flex / grid / block) without margin-collapse or
  sub-pixel rounding.

### Tested

- Original `virtual.test.js` (13 tests) covering `offsetForIndex` alignment,
  `firstIndex` integer gating, `onEndReached` / `stickyHeader` reactivity,
  and basic `mountList` / `mountMeasuredList` flows. Retained in 1.1 as
  `test/06-measured-and-helpers.test.js`.
