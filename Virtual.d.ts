/**
 * @zakkster/lite-virtual - type declarations
 *
 * Thrash-free list/grid windowing on @zakkster/lite-signal. Reactive integer
 * indices gate downstream work: scrolling within a single row is allocation-
 * and DOM-write-free. Two layers:
 *
 *   - Pure math axes (`virtualAxis`, `virtualGrid`, `variableAxis`) -- headless
 *     reactive state. Pair with any renderer.
 *   - lite-element renderers (`mountList`, `mountKeyedList`, `mountGrid`,
 *     `mountVariableList`) -- opinionated recycling renderers built on the math.
 */

/** Read-only reactive value: call to read+track, `.peek()` for untracked. */
export interface ReadSignal<T> {
    (): T;
    peek(): T;
}

/** Writable reactive value (lite-signal's signal handle). */
export interface WritableSignal<T> extends ReadSignal<T> {
    set(value: T): void;
    update(fn: (prev: T) => T): void;
    subscribe(fn: (value: T) => void): () => void;
}

/**
 * The mounting scope (lite-element's `scope` API). The renderers need three
 * primitives: `effect` for reactive bindings, `on` for auto-removed listeners,
 * `onCleanup` for arbitrary teardown.
 */
export interface MountScope {
    effect(fn: () => void): () => void;
    on(el: EventTarget, type: string, handler: (ev: any) => void, opts?: AddEventListenerOptions | boolean): () => void;
    onCleanup(fn: () => void): void;
}

/** Alignment for scroll-to-index helpers. "auto"/"nearest" only move when off-screen. */
export type ScrollAlign = "start" | "center" | "end" | "auto" | "nearest";

// --- Fixed-size 1-D axis -----------------------------------------------------

export interface VirtualAxisOptions {
    /** Number of items in the list. */
    count: number;
    /** Pixel size of every item along the scroll axis (height for vertical, width for horizontal). */
    itemSize: number;
    /** Viewport size along the scroll axis (clientHeight / clientWidth). */
    viewport: number;
    /** Extra items to keep mounted on each side of the visible window. Default 3. */
    overscan?: number;
}

export interface VirtualAxis {
    /** Current scroll position in px (writable; integer-truncated on set). */
    readonly scrollPos: WritableSignal<number>;
    /** First visible index (inclusive). Object.is-gated -- only changes on boundary crossing. */
    readonly start: ReadSignal<number>;
    /** Last visible index (exclusive). */
    readonly end: ReadSignal<number>;
    /** Pixel offset of `start` (= start * itemSize). */
    readonly offsetStart: ReadSignal<number>;
    /** Total scroll length in px (= count * itemSize). */
    readonly totalSize: ReadSignal<number>;
    /** First visible index, Object.is-gated. Same value as `start` before overscan. */
    readonly firstIndex: ReadSignal<number>;
    /** Current item count (reactive read). */
    count(): number;
    /** Scroll offset (px) that brings `index` into view under `align`. Clamped to range. */
    offsetForIndex(index: number, align?: ScrollAlign): number;
    /** Present after mounting via a renderer: scroll the host to `index`. */
    scrollToIndex?(index: number, align?: ScrollAlign): void;
    setScroll(px: number): void;
    setViewport(px: number): void;
    setCount(n: number): void;
}

export function virtualAxis(options: VirtualAxisOptions): VirtualAxis;

// --- Fixed-size 2-D grid -----------------------------------------------------

export interface VirtualGridOptions {
    rowCount: number;
    colCount: number;
    rowHeight: number;
    colWidth: number;
    viewportHeight: number;
    viewportWidth: number;
    /** Extra rows AND columns to keep mounted on each side of the visible window. Default 2. */
    overscan?: number;
}

export interface VirtualGrid {
    readonly rowStart: ReadSignal<number>;
    readonly rowEnd: ReadSignal<number>;
    readonly rowOffset: ReadSignal<number>;
    readonly totalHeight: ReadSignal<number>;
    readonly colStart: ReadSignal<number>;
    readonly colEnd: ReadSignal<number>;
    readonly colOffset: ReadSignal<number>;
    readonly totalWidth: ReadSignal<number>;
    setScroll(left: number, top: number): void;
    setViewport(width: number, height: number): void;
    setCounts(rowCount: number, colCount: number): void;
    /** Underlying axes for advanced use (debugging, scroll-to-index). Treat as internal. */
    readonly _rows: VirtualAxis;
    readonly _cols: VirtualAxis;
    /** Present after mounting via mountGrid: scroll the host to cell (row, col). */
    scrollToCell?(row: number, col: number, align?: ScrollAlign): void;
}

export function virtualGrid(options: VirtualGridOptions): VirtualGrid;

// --- Variable-size 1-D axis --------------------------------------------------

export interface VariableAxisOptions {
    count: number;
    /** Returns the pixel size of item `i`. Called once per item at build time and on `remeasure()`. */
    sizeAt: (index: number) => number;
    viewport: number;
    overscan?: number;
}

export interface VariableAxis {
    readonly scrollPos: WritableSignal<number>;
    readonly start: ReadSignal<number>;
    readonly end: ReadSignal<number>;
    readonly offsetStart: ReadSignal<number>;
    readonly totalSize: ReadSignal<number>;
    /** First visible index, Object.is-gated. */
    readonly firstIndex: ReadSignal<number>;
    /** Current item count (reactive read). */
    count(): number;
    /** Scroll offset (px) that brings `index` into view under `align`. Clamped to range. */
    offsetForIndex(index: number, align?: ScrollAlign): number;
    /** Present after mounting via a renderer: scroll the host to `index`. */
    scrollToIndex?(index: number, align?: ScrollAlign): void;
    /** Pixel offset of item `i` from the top of the list. O(1). */
    positionAt(index: number): number;
    /** The smallest row size seen at build time. Used by renderers to size their pool. */
    minSize(): number;
    setScroll(px: number): void;
    setViewport(px: number): void;
    setCount(n: number): void;
    /** Re-walk `sizeAt` and rebuild the prefix-sum offsets. O(n). */
    remeasure(): void;
}

export function variableAxis(options: VariableAxisOptions): VariableAxis;

// --- Measured (auto-height) 1-D axis -----------------------------------------

export interface MeasuredAxisOptions {
    count: number;
    /** Per-item size used before a row has been measured. */
    estimateSize: number;
    viewport: number;
    overscan?: number;
}

export interface MeasuredAxis {
    readonly scrollPos: WritableSignal<number>;
    readonly start: ReadSignal<number>;
    readonly end: ReadSignal<number>;
    readonly offsetStart: ReadSignal<number>;
    readonly totalSize: ReadSignal<number>;
    readonly firstIndex: ReadSignal<number>;
    count(): number;
    /** Pixel offset of item `i` (Fenwick prefix sum). O(log n). */
    positionAt(index: number): number;
    /** Current (measured or estimated) size of item `i`. */
    sizeAt(index: number): number;
    /** Smallest size seen so far; renderers use it to size their pool. */
    minSize(): number;
    offsetForIndex(index: number, align?: ScrollAlign): number;
    scrollToIndex?(index: number, align?: ScrollAlign): void;
    /** Report a row's real measured size. O(log n); patches every downstream offset. */
    measure(index: number, size: number): void;
    setScroll(px: number): void;
    setViewport(px: number): void;
    setCount(n: number): void;
    /** Rebuild offsets from current sizes. */
    remeasure(): void;
}

/**
 * Measured (auto-height) axis: sizes are unknown until rendered. Rows start at
 * `estimateSize`; the renderer calls `measure(index, size)` once a row is laid
 * out. A Fenwick tree makes each correction and every offset query O(log n).
 * Pair with {@link mountMeasuredList}.
 */
export function measuredAxis(options: MeasuredAxisOptions): MeasuredAxis;

// --- Recycling renderers -----------------------------------------------------

export interface MountListOptions {
    count: number;
    /** Item size along the scroll axis (height when vertical). One of itemHeight/itemSize is required. */
    itemHeight?: number;
    /** Alias for itemHeight; clearer when `horizontal`. One of the two is required. */
    itemSize?: number;
    /** Scroll horizontally (scrollLeft + translateX) instead of vertically. Default false. */
    horizontal?: boolean;
    /** Initial viewport size along the scroll axis; auto-updated via ResizeObserver if available. */
    viewport: number;
    overscan?: number;
    /** Render callback. Called once per index when that index enters the window or its node is recycled. */
    render: (rowEl: HTMLElement, index: number) => void;
}

/**
 * Index-based recycling list. O(1) per boundary crossing during smooth scroll;
 * zero work between crossings. Stateless rows only (a node is reused across
 * logical indices). For stateful rows use `mountKeyedList`.
 *
 * Returns the underlying axis so callers can read `start`/`end`/scroll, or set
 * counts externally (e.g. tail-following a growing log).
 */
export function mountList(
    host: HTMLElement,
    scope: MountScope,
    options: MountListOptions,
): VirtualAxis;

export interface MountKeyedListOptions<T> {
    /** Reactive array accessor -- must read from a signal/store and return the current array. */
    items: () => readonly T[];
    itemHeight: number;
    viewport: number;
    overscan?: number;
    /** Stable identity per item. The node bound to a key is that key's home for its lifetime. */
    key: (item: T, index: number) => string | number;
    /** Render callback -- called ONCE when a key enters the window. Bind reactively inside. */
    render: (rowEl: HTMLElement, item: T, index: number) => void;
}

/**
 * Keyed renderer for STATEFUL rows (inputs, media, expanded state). A node is
 * created when its key enters the window and removed when the key leaves; the
 * node's identity stays with the data row, so per-node DOM state survives
 * reordering.
 */
export function mountKeyedList<T>(
    host: HTMLElement,
    scope: MountScope,
    options: MountKeyedListOptions<T>,
): VirtualAxis;

export interface MountGridOptions {
    rowCount: number;
    colCount: number;
    rowHeight: number;
    colWidth: number;
    viewportWidth: number;
    viewportHeight: number;
    overscan?: number;
    render: (cellEl: HTMLElement, row: number, col: number) => void;
}

/**
 * 2-D recycling grid renderer. Crossing a row boundary re-renders one new row
 * of cells; crossing a column boundary re-renders one new column. Stateless
 * cells only.
 */
export function mountGrid(
    host: HTMLElement,
    scope: MountScope,
    options: MountGridOptions,
): VirtualGrid;

export interface MountVariableListOptions {
    count: number;
    sizeAt: (index: number) => number;
    viewport: number;
    overscan?: number;
    render: (rowEl: HTMLElement, index: number) => void;
}

/**
 * Variable-height list renderer. Pool is pre-sized from the smallest row so
 * the recycling map never reshuffles mid-scroll. Stateless rows only.
 */
export function mountVariableList(
    host: HTMLElement,
    scope: MountScope,
    options: MountVariableListOptions,
): VariableAxis;

export interface MountMeasuredListOptions {
    count: number;
    estimateSize: number;
    viewport: number;
    overscan?: number;
    render: (rowEl: HTMLElement, index: number) => void;
}

/**
 * Measured-height list renderer for rows whose size is unknown until rendered.
 * A ResizeObserver reports each row's height, the axis is patched, and the scroll
 * is re-anchored to the item under the viewport top so above-the-fold corrections
 * do not jump. Stateless rows only.
 */
export function mountMeasuredList(
    host: HTMLElement,
    scope: MountScope,
    options: MountMeasuredListOptions,
): MeasuredAxis;

// --- Headless helpers --------------------------------------------------------

export interface OnEndReachedOptions {
    /** Fire when the window comes within this many items of the end. Default 0. */
    distance?: number;
    /** Called when the end is reached; again only after the count grows. */
    onReached: () => void;
}

/**
 * Infinite-loader trigger. Works with any axis exposing `count()` and `end()`
 * (e.g. wire `onReached` to @zakkster/lite-resource's loadMore). Returns a dispose.
 */
export function onEndReached(
    axis: { count(): number; end: ReadSignal<number> },
    options: OnEndReachedOptions,
): () => void;

/**
 * Sticky group-header resolver. Given a reactive first-visible-index accessor and
 * a sorted ascending array of group start indices, returns a computed of the
 * 0-based ordinal of the group at the top of the viewport (-1 before the first).
 */
export function stickyHeader(
    firstIndex: () => number,
    groupStarts: number[],
): ReadSignal<number>;
