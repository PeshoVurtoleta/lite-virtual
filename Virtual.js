/**
 * @zakkster/lite-virtual -- thrash-free list/grid windowing on lite-signal.
 * -----------------------------------------------------------------------------
 * The visible range derives from floor(scrollTop / itemSize), so it changes ONLY when
 * you cross a row/column boundary -- not on every scroll pixel. lite-signal's Object.is
 * cutoff then halts propagation between boundaries, so a fast scroll inside one row
 * does zero reactive work and writes nothing to the DOM. Fixed-size in the core;
 * variable-size is a position-cache extension (sketched at the bottom).
 *
 * Headless: the windowing math is pure reactive state. Pair it with any renderer; a
 * lite-element recycling renderer is included.
 *
 * MIT (c) Zahary Shinikchiev
 */
import {signal, computed, effect} from "@zakkster/lite-signal";

// --- shared helpers ---------------------------------------------------------

/** Clamp a target scroll offset into the legal range [0, total - viewport]. */
function clampScroll(target, total, viewport) {
    if (target < 0) return 0;
    const max = total - viewport;
    if (max <= 0) return 0;
    return target > max ? max : target;
}

/**
 * Resolve the desired scroll offset for an item, given its top edge and size,
 * the viewport size, the current scroll, and an alignment mode. "auto" only
 * moves when the item is not already fully visible (nearest edge).
 */
function alignOffset(top, size, viewport, current, align) {
    if (align === "center") return top - viewport / 2 + size / 2;
    if (align === "end") return top - viewport + size;
    if (align === "auto" || align === "nearest") {
        if (top < current) return top;
        if (top + size > current + viewport) return top - viewport + size;
        return current;
    }
    return top; // "start" (default)
}

// Fenwick (binary indexed) tree over item sizes: O(log n) point update,
// prefix sum, and find-by-offset. Backs measuredAxis so a single row's measured
// height patches every downstream offset in log time instead of an O(n) rebuild.
function fenwickBuild(sizes) {
    const n = sizes.length;
    const t = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
        const j = i + 1;
        t[j] += sizes[i];
        const up = j + (j & -j);
        if (up <= n) t[up] += t[j];
    }
    return t;
}

function fenwickUpdate(t, i, delta) {
    for (let j = i + 1; j < t.length; j += j & -j) t[j] += delta;
}

function fenwickPrefix(t, i) {
    // sum of sizes[0..i-1]
    let s = 0;
    for (let k = i; k > 0; k -= k & -k) s += t[k];
    return s;
}

function fenwickFind(t, target) {
    // largest index i in [0, n] whose prefix sum is <= target
    const n = t.length - 1;
    let pos = 0;
    let rem = target;
    let pw = 1;
    while (pw << 1 <= n) pw <<= 1;
    for (; pw > 0; pw >>= 1) {
        const next = pos + pw;
        if (next <= n && t[next] <= rem) {
            rem -= t[next];
            pos = next;
        }
    }
    return pos;
}

/**
 * Fixed-height (or fixed-width) 1-D windowing.
 * @returns reactive handles: start, end (exclusive), offsetStart (px), totalSize (px),
 *          plus scrollTop and setters. start/end are integers, so they only fire on a
 *          boundary crossing.
 */
export function virtualAxis({count, itemSize, viewport, overscan = 3}) {
    const scrollPos = signal(0);
    const viewportSize = signal(viewport);
    const itemCount = signal(count);
    const sz = itemSize;

    // The single source of windowing truth: which item is first under the viewport edge.
    // Integer -> Object.is means sub-item scrolling does NOT propagate.
    const firstItem = computed(() => {
        const f = Math.floor(scrollPos() / sz);
        if (f < 0) return 0;                 // iOS/macOS rubber-band: negative scrollTop -> pin at top
        const c = itemCount();
        return f > c ? c : f;                // bottom overscroll past the end -> pin at the tail
    });
    const perView = computed(() => Math.ceil(viewportSize() / sz) + 1);   // +1 for the partial edge row

    const start = computed(() => Math.max(0, firstItem() - overscan));
    const end = computed(() => Math.min(itemCount(), firstItem() + perView() + overscan));
    const offsetStart = computed(() => start() * sz);
    const totalSize = computed(() => itemCount() * sz);

    return {
        scrollPos, start, end, offsetStart, totalSize,
        firstIndex: firstItem,
        count: () => itemCount(),
        offsetForIndex(index, align = "start") {
            const c = itemCount.peek();
            const i = index < 0 ? 0 : index > c ? c : index;
            const top = i * sz;
            const total = c * sz;
            const vp = viewportSize.peek();
            return clampScroll(alignOffset(top, sz, vp, scrollPos.peek(), align), total, vp);
        },
        setScroll(px) {
            scrollPos.set(px | 0);
        },
        setViewport(px) {
            viewportSize.set(px);
        },
        setCount(n) {
            itemCount.set(n);
        },
    };
}

/** 2-D windowing: independent row and column axes sharing the same math. */
export function virtualGrid({rowCount, colCount, rowHeight, colWidth, viewportHeight, viewportWidth, overscan = 2}) {
    const rows = virtualAxis({count: rowCount, itemSize: rowHeight, viewport: viewportHeight, overscan});
    const cols = virtualAxis({count: colCount, itemSize: colWidth, viewport: viewportWidth, overscan});
    return {
        rowStart: rows.start, rowEnd: rows.end, rowOffset: rows.offsetStart, totalHeight: rows.totalSize,
        colStart: cols.start, colEnd: cols.end, colOffset: cols.offsetStart, totalWidth: cols.totalSize,
        setScroll(left, top) {
            cols.setScroll(left);
            rows.setScroll(top);
        },
        setViewport(w, h) {
            cols.setViewport(w);
            rows.setViewport(h);
        },
        setCounts(rc, cc) {
            rows.setCount(rc);
            cols.setCount(cc);
        },
        _rows: rows, _cols: cols,
    };
}

/**
 * lite-element recycling renderer. O(1) per boundary crossing during smooth scroll.
 *
 * Each row is absolutely positioned at translateY(index * itemHeight) -- there is NO
 * translated wrapper. A logical index maps to a physical node by `index % poolSize`,
 * and each node remembers the index it currently shows. On a one-row scroll the only
 * node whose mapped index changes is the one that wrapped from top to bottom, so the
 * `idx !== i` guard re-renders exactly that node and skips the rest. A jump re-renders
 * only the indices that newly entered the window. Warmed scrolling allocates nothing.
 * (Circular-buffer + absolute-rows technique -- same idea as a RecyclerView.)
 *
 * CONSTRAINT: recycling is INDEX-based, so rows must be stateless/presentation (text,
 * static markup). A node is reused across logical indices, so per-node DOM state --
 * input focus/value, media playback, accordion-expanded -- would follow the node, not
 * the row. For stateful rows use {@link mountKeyedList}, which binds a node to a stable
 * data key for its lifetime.
 *
 *   mountList(host, scope, {
 *     count: 100000, itemHeight: 32, viewport: host.clientHeight,
 *     render: (rowEl, index) => { rowEl.textContent = `row ${index}`; },
 *   });
 */
export function mountList(host, scope, {count, itemHeight, itemSize, viewport, overscan = 3, render, horizontal = false}) {
    const size = itemSize != null ? itemSize : itemHeight;
    const axis = virtualAxis({count, itemSize: size, viewport, overscan});
    const MAIN = horizontal ? "width" : "height";
    const CROSS = horizontal ? "height" : "width";
    const translate = (px) => (horizontal ? `translateX(${px}px)` : `translateY(${px}px)`);
    host.style.overflow = "auto";
    host.style.position = "relative";
    if (host.tabIndex < 0) host.tabIndex = 0;                 // arrow/page keys need focusability
    // Bulletproof spacer: absolute + 1px on the cross axis + hidden. Survives any
    // parent formatting context (flex, grid, block) without collapsing or rounding.
    const spacer = host.ownerDocument.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style[CROSS] = "1px";
    spacer.style.visibility = "hidden";
    spacer.setAttribute("aria-hidden", "true");
    host.appendChild(spacer);

    const pool = [];                                          // [{ el, idx }] -- idx = index currently shown
    scope.on(host, "scroll", () => axis.setScroll(horizontal ? host.scrollLeft : host.scrollTop));
    scope.effect(() => {
        spacer.style[MAIN] = axis.totalSize() + "px";
    });
    scope.effect(() => {
        const s = axis.start(), e = axis.end(), n = e - s;
        while (pool.length < n) {                             // grow pool only on (re)size
            const row = host.ownerDocument.createElement("div");
            row.style.position = "absolute";
            if (horizontal) {
                row.style.top = "0";
                row.style.bottom = "0";
            } else {
                row.style.left = "0";
                row.style.right = "0";
            }
            row.style[MAIN] = size + "px";
            host.appendChild(row);
            pool.push({el: row, idx: -1});
        }
        const psize = pool.length;
        for (let i = s; i < e; i++) {                         // touch only nodes whose index changed
            const p = pool[i % psize];
            if (p.idx !== i) {
                p.idx = i;
                p.el.style.transform = translate(i * size);
                p.el.style.display = "";
                render(p.el, i);
            }
        }
        for (let i = 0; i < psize; i++) {                     // park nodes that fell out of the window
            const p = pool[i];
            if (p.idx < s || p.idx >= e) {
                p.el.style.display = "none";
                p.idx = -1;
            }
        }
    });

    // Keep perView correct across rotation / window resize. contentRect avoids a
    // synchronous layout flush; onCleanup disconnects so there is zero leak.
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver((entries) => {
            const b = entries[0].contentRect;
            axis.setViewport(horizontal ? b.width : b.height);
        });
        ro.observe(host);
        scope.onCleanup(() => ro.disconnect());
    }
    axis.scrollToIndex = (index, align = "start") => {
        const target = axis.offsetForIndex(index, align);
        if (horizontal) host.scrollLeft = target; else host.scrollTop = target;
        axis.setScroll(target);
    };
    return axis;
}

/**
 * Keyed recycling renderer (sketch) -- for STATEFUL rows (inputs, media, expansion).
 * A node is bound to a stable data key for its lifetime and repositioned as its index
 * moves; nodes are created when their key enters the window and removed when it leaves.
 * State stays with the right row because identity is the key, not a pool slot. More
 * allocation than mountList (create/remove on churn), but correct for stateful content.
 *
 *   mountKeyedList(host, scope, {
 *     items: () => rows(),                 // reactive array accessor (signal/store)
 *     itemHeight: 48, viewport: host.clientHeight,
 *     key: (item) => item.id,              // stable identity
 *     render: (rowEl, item, index) => { ... bind once; node is this key's home ... },
 *   });
 */
export function mountKeyedList(host, scope, {items, itemHeight, viewport, overscan = 3, key, render}) {
    const axis = virtualAxis({count: items().length, itemSize: itemHeight, viewport, overscan});
    host.style.overflow = "auto";
    host.style.position = "relative";
    if (host.tabIndex < 0) host.tabIndex = 0;
    const spacer = host.ownerDocument.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.width = "1px";
    spacer.style.visibility = "hidden";
    spacer.setAttribute("aria-hidden", "true");
    host.appendChild(spacer);

    const byKey = new Map();                                  // key -> { el }
    scope.on(host, "scroll", () => axis.setScroll(host.scrollTop));
    scope.effect(() => axis.setCount(items().length));        // keep total size reactive to the data
    scope.effect(() => {
        spacer.style.height = axis.totalSize() + "px";
    });
    scope.effect(() => {
        const arr = items();
        const s = axis.start(), e = Math.min(axis.end(), arr.length);
        const live = new Set();
        for (let i = s; i < e; i++) {
            const item = arr[i];
            const k = key(item, i);
            live.add(k);
            let node = byKey.get(k);
            if (node === undefined) {                         // key entered the window -> create + bind once
                const el = host.ownerDocument.createElement("div");
                el.style.position = "absolute";
                el.style.left = "0";
                el.style.right = "0";
                el.style.height = itemHeight + "px";
                host.appendChild(el);
                node = {el, idx: -1};
                byKey.set(k, node);
                render(el, item, i);                          // bind once; node is this key's home for its lifetime
            }
            if (node.idx !== i) {                             // reposition ONLY on index change (scroll keeps it fixed; reorder moves it)
                node.idx = i;
                node.el.style.transform = `translateY(${i * itemHeight}px)`;
            }
        }
        for (const [k, node] of byKey) {                      // key left the window -> remove (1 per boundary)
            if (!live.has(k)) {
                node.el.remove();
                byKey.delete(k);
            }
        }
    });

    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver((entries) => {
            axis.setViewport(entries[0].contentRect.height);
        });
        ro.observe(host);
        scope.onCleanup(() => ro.disconnect());
    }
    axis.scrollToIndex = (index, align = "start") => {
        const target = axis.offsetForIndex(index, align);
        host.scrollTop = target;
        axis.setScroll(target);
    };
    return axis;
}

/**
 * 2-D recycling renderer for a windowed grid. Both axes derive from the same integer-
 * gated math, so scrolling within a cell does nothing; crossing a row boundary
 * re-renders only the one new ROW of cells, crossing a column boundary only the one new
 * COLUMN. Cells are absolutely positioned at translate(c*colWidth, r*rowHeight) and
 * recycled by a 2-D circular buffer (r % poolRows, c % poolCols); each cell remembers
 * its (r,c) and re-renders only when that pair changes. Stateless cells (same constraint
 * as mountList).
 *
 *   mountGrid(host, scope, {
 *     rowCount: 50000, colCount: 500, rowHeight: 28, colWidth: 120,
 *     viewportWidth: host.clientWidth, viewportHeight: host.clientHeight,
 *     render: (cellEl, row, col) => { cellEl.textContent = `${row},${col}`; },
 *   });
 */
export function mountGrid(host, scope, {rowCount, colCount, rowHeight, colWidth, viewportWidth, viewportHeight, overscan = 2, render}) {
    const grid = virtualGrid({rowCount, colCount, rowHeight, colWidth, viewportHeight, viewportWidth, overscan});
    host.style.overflow = "auto";
    host.style.position = "relative";
    if (host.tabIndex < 0) host.tabIndex = 0;
    // Bulletproof spacer -- absolute + 1px in BOTH dimensions; height/width are
    // assigned below by the totalHeight/totalWidth effects.
    const spacer = host.ownerDocument.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.visibility = "hidden";
    spacer.setAttribute("aria-hidden", "true");
    host.appendChild(spacer);

    // Pool is pre-sized to the MAX window (perView + 2*overscan on each axis) so scrolling
    // never resizes it -- the 2-D flat index (r%PR)*PC + c%PC restrides if PR/PC change, so a
    // grow-mid-scroll would re-render everything. Only a viewport RESIZE rebuilds (rare).
    const cells = [];
    let PR = 0, PC = 0, vw = viewportWidth, vh = viewportHeight;

    function ensurePool() {
        const needR = Math.min(Math.ceil(vh / rowHeight) + 1 + 2 * overscan, rowCount);
        const needC = Math.min(Math.ceil(vw / colWidth) + 1 + 2 * overscan, colCount);
        if (needR <= PR && needC <= PC) return;
        for (const cell of cells) cell.el.remove();
        cells.length = 0;
        PR = Math.max(PR, needR);
        PC = Math.max(PC, needC);
        for (let i = 0; i < PR * PC; i++) {
            const el = host.ownerDocument.createElement("div");
            el.style.position = "absolute";
            el.style.width = colWidth + "px";
            el.style.height = rowHeight + "px";
            el.style.display = "none";
            host.appendChild(el);
            cells.push({el, r: -1, c: -1});
        }
    }

    ensurePool();

    scope.on(host, "scroll", () => grid.setScroll(host.scrollLeft, host.scrollTop));
    scope.effect(() => {
        spacer.style.height = grid.totalHeight() + "px";
    });
    scope.effect(() => {
        spacer.style.width = grid.totalWidth() + "px";
    });
    scope.effect(() => {
        const rs = grid.rowStart(), re = grid.rowEnd(), cs = grid.colStart(), ce = grid.colEnd();
        for (let r = rs; r < re; r++) {
            for (let c = cs; c < ce; c++) {
                const cell = cells[(r % PR) * PC + (c % PC)];
                if (cell.r !== r || cell.c !== c) {           // only the freshly-entered row/col of cells changes
                    cell.r = r;
                    cell.c = c;
                    cell.el.style.transform = `translate(${c * colWidth}px, ${r * rowHeight}px)`;
                    cell.el.style.display = "";
                    render(cell.el, r, c);
                }
            }
        }
        for (let i = 0; i < cells.length; i++) {              // park cells that fell outside the window
            const cell = cells[i];
            if (cell.r !== -1 && (cell.r < rs || cell.r >= re || cell.c < cs || cell.c >= ce)) {
                cell.el.style.display = "none";
                cell.r = -1;
                cell.c = -1;
            }
        }
    });

    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver((entries) => {
            const b = entries[0].contentRect;
            vw = b.width;
            vh = b.height;
            grid.setViewport(vw, vh);
            ensurePool();                                     // grow pool only if the viewport grew
        });
        ro.observe(host);
        scope.onCleanup(() => ro.disconnect());
    }
    grid.scrollToCell = (row, col, align = "start") => {
        const top = grid._rows.offsetForIndex(row, align);
        const left = grid._cols.offsetForIndex(col, align);
        host.scrollTop = top;
        host.scrollLeft = left;
        grid.setScroll(left, top);
    };
    return grid;
}

/**
 * Variable-size axis. Item heights are not uniform: a prefix sum (offsets[i] = top of item
 * i, offsets[count] = total) is built once, and the visible range is found by binary search
 * instead of division. firstItem is still an integer index, so Object.is halts propagation
 * while scrolling WITHIN an item -- the no-thrash property carries over unchanged. Heights
 * are known up front via sizeAt(index); call setCount(n) or remeasure() if they change.
 *
 * Returns the same surface as virtualAxis plus positionAt(i) (= offsets[i]) and minSize()
 * (the smallest row -- a renderer uses it to pre-size its pool). Scrolling within a known
 * height range costs one binary search and zero downstream work.
 *
 * NOT handled here: MEASURED / auto-height rows whose size is unknown until rendered. That
 * needs an estimate-then-correct loop -- render with an estimated height, measure via
 * ResizeObserver, patch the affected prefix sums, bump the version, and anchor the scroll
 * position to the item under the viewport top so the correction doesn't visibly jump. The
 * windowing/recycling below is reused verbatim; only the offset source becomes incremental.
 */
export function variableAxis({count, sizeAt, viewport, overscan = 3}) {
    const itemCount = signal(count);
    const viewportSize = signal(viewport);
    const scrollPos = signal(0);
    const version = signal(0);                                // bumped when offsets are (re)built

    let offsets = new Float64Array(count + 1);
    let smallest = 0;
    const build = () => {
        const c = itemCount.peek();
        if (offsets.length !== c + 1) offsets = new Float64Array(c + 1);
        let acc = 0, min = Infinity;
        for (let i = 0; i < c; i++) {
            offsets[i] = acc;
            const sz = sizeAt(i);
            if (sz < min) min = sz;
            acc += sz;
        }
        offsets[c] = acc;
        smallest = min === Infinity ? 0 : min;
        version.set(version.peek() + 1);
    };
    build();

    const findItem = (pos) => {                               // largest i in [0,count] with offsets[i] <= pos
        const c = itemCount.peek();
        if (pos <= 0) return 0;
        if (pos >= offsets[c]) return c;
        let lo = 0, hi = c;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (offsets[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo;
    };

    const firstItem = computed(() => {
        version();
        return findItem(scrollPos());
    });
    const lastItem = computed(() => {
        version();
        return findItem(scrollPos() + viewportSize());
    });
    const start = computed(() => {
        const f = firstItem() - overscan;
        return f < 0 ? 0 : f;
    });
    const end = computed(() => {
        const c = itemCount();
        const e = lastItem() + 1 + overscan;
        return e > c ? c : e;
    });
    const offsetStart = computed(() => {
        version();
        return offsets[start()];
    });
    const totalSize = computed(() => {
        version();
        return offsets[itemCount()];
    });

    return {
        start, end, offsetStart, totalSize, scrollPos,
        firstIndex: firstItem,
        count: () => itemCount(),
        positionAt: (i) => offsets[i],
        minSize: () => smallest,
        offsetForIndex(index, align = "start") {
            const c = itemCount.peek();
            const i = index < 0 ? 0 : index > c ? c : index;
            const top = offsets[i];
            const size = i < c ? offsets[i + 1] - offsets[i] : 0;
            const vp = viewportSize.peek();
            return clampScroll(alignOffset(top, size, vp, scrollPos.peek(), align), offsets[c], vp);
        },
        setScroll: (p) => scrollPos.set(p),
        setViewport: (v) => viewportSize.set(v),
        setCount: (n) => {
            itemCount.set(n);
            build();
        },
        remeasure: () => build(),
    };
}

/**
 * Variable-height list renderer. Each row is positioned at its absolute offset and given its
 * own height; recycling is the same circular buffer as mountList. The pool is pre-sized from
 * the SMALLEST row (ceil(viewport/minSize) + 1 + 2*overscan) so the visible count never
 * exceeds it and the modulo mapping never reshuffles. Stateless rows (use a keyed variant for
 * stateful content, same as mountList -> mountKeyedList).
 */
export function mountVariableList(host, scope, {count, sizeAt, viewport, overscan = 3, render}) {
    const axis = variableAxis({count, sizeAt, viewport, overscan});
    host.style.overflow = "auto";
    host.style.position = "relative";
    if (host.tabIndex < 0) host.tabIndex = 0;
    const spacer = host.ownerDocument.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.width = "1px";
    spacer.style.visibility = "hidden";
    spacer.setAttribute("aria-hidden", "true");
    host.appendChild(spacer);
    scope.effect(() => {
        spacer.style.height = axis.totalSize() + "px";
    });
    scope.on(host, "scroll", () => axis.setScroll(host.scrollTop));

    const pool = [];
    let PS = 0, vh = viewport;
    const ensurePool = () => {
        const min = axis.minSize() || 1;
        const need = Math.min(count, Math.ceil(vh / min) + 1 + 2 * overscan);
        if (need <= PS) return;
        for (const p of pool) p.el.remove();
        pool.length = 0;
        PS = need;
        for (let i = 0; i < PS; i++) {
            const el = host.ownerDocument.createElement("div");
            el.style.position = "absolute";
            el.style.left = "0";
            el.style.right = "0";
            el.style.display = "none";
            host.appendChild(el);
            pool.push({el, idx: -1});
        }
    };
    ensurePool();

    scope.effect(() => {
        const s = axis.start(), e = axis.end();
        for (let i = s; i < e; i++) {
            const cell = pool[i % PS];
            if (cell.idx !== i) {
                cell.idx = i;
                cell.el.style.transform = `translateY(${axis.positionAt(i)}px)`;
                cell.el.style.height = sizeAt(i) + "px";
                cell.el.style.display = "";
                render(cell.el, i);
            }
        }
        for (let i = 0; i < PS; i++) {
            const p = pool[i];
            if (p.idx !== -1 && (p.idx < s || p.idx >= e)) {
                p.el.style.display = "none";
                p.idx = -1;
            }
        }
    });

    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver((entries) => {
            vh = entries[0].contentRect.height;
            axis.setViewport(vh);
            ensurePool();
        });
        ro.observe(host);
        scope.onCleanup(() => ro.disconnect());
    }
    axis.scrollToIndex = (index, align = "start") => {
        const target = axis.offsetForIndex(index, align);
        host.scrollTop = target;
        axis.setScroll(target);
    };
    return axis;
}

/**
 * Measured (auto-height) axis. Unlike variableAxis, item sizes are NOT known up
 * front: every item starts at `estimateSize`, and the renderer reports each row's
 * real height via measure(index, size) once it has been laid out. A Fenwick tree
 * over the size array makes each correction O(log n) for the update and for the
 * offset / find-by-position queries, so a single measured row patches every
 * downstream offset without an O(n) rebuild. firstItem stays an integer index, so
 * the Object.is no-thrash property is preserved while scrolling within an item.
 *
 * Same surface as variableAxis, plus measure(index, size). Pair with
 * {@link mountMeasuredList}, which measures rows and anchors the scroll so a
 * correction above the fold does not visibly jump.
 *
 * @param {object} opts
 * @param {number} opts.count
 * @param {number} opts.estimateSize  Initial per-item size before measurement.
 * @param {number} opts.viewport
 * @param {number} [opts.overscan=3]
 */
export function measuredAxis({count, estimateSize, viewport, overscan = 3}) {
    const itemCount = signal(count);
    const viewportSize = signal(viewport);
    const scrollPos = signal(0);
    const version = signal(0);

    let sizes = new Float64Array(count);
    let tree = null;
    let smallest = estimateSize;
    const init = () => {
        const c = itemCount.peek();
        if (sizes.length !== c) {
            const next = new Float64Array(c);
            next.fill(estimateSize);
            const overlap = sizes.length < c ? sizes.length : c;
            for (let i = 0; i < overlap; i++) next[i] = sizes[i];
            sizes = next;
        } else if (tree === null) {
            sizes.fill(estimateSize);
        }
        tree = fenwickBuild(sizes);
        smallest = estimateSize;
        for (let i = 0; i < sizes.length; i++) if (sizes[i] < smallest) smallest = sizes[i];
        version.set(version.peek() + 1);
    };
    init();

    const findItem = (pos) => {
        const c = itemCount.peek();
        if (pos <= 0) return 0;
        const total = fenwickPrefix(tree, c);
        if (pos >= total) return c;
        const f = fenwickFind(tree, pos);
        return f > c ? c : f;
    };

    const firstItem = computed(() => {
        version();
        return findItem(scrollPos());
    });
    const lastItem = computed(() => {
        version();
        return findItem(scrollPos() + viewportSize());
    });
    const start = computed(() => {
        const f = firstItem() - overscan;
        return f < 0 ? 0 : f;
    });
    const end = computed(() => {
        const c = itemCount();
        const e = lastItem() + 1 + overscan;
        return e > c ? c : e;
    });
    const offsetStart = computed(() => {
        version();
        return fenwickPrefix(tree, start());
    });
    const totalSize = computed(() => {
        version();
        return fenwickPrefix(tree, itemCount());
    });

    const positionAt = (i) => fenwickPrefix(tree, i < 0 ? 0 : i);
    const sizeAt = (i) => (i >= 0 && i < sizes.length ? sizes[i] : 0);

    return {
        scrollPos, start, end, offsetStart, totalSize,
        firstIndex: firstItem,
        count: () => itemCount(),
        positionAt,
        sizeAt,
        minSize: () => smallest,
        offsetForIndex(index, align = "start") {
            const c = itemCount.peek();
            const i = index < 0 ? 0 : index > c ? c : index;
            const top = fenwickPrefix(tree, i);
            const total = fenwickPrefix(tree, c);
            const vp = viewportSize.peek();
            return clampScroll(alignOffset(top, sizeAt(i), vp, scrollPos.peek(), align), total, vp);
        },
        measure(index, size) {
            if (index < 0 || index >= sizes.length) return;
            const delta = size - sizes[index];
            if (delta === 0) return;
            sizes[index] = size;
            fenwickUpdate(tree, index, delta);
            if (size < smallest) smallest = size;
            version.set(version.peek() + 1);
        },
        setScroll: (p) => scrollPos.set(p | 0),
        setViewport: (v) => viewportSize.set(v),
        setCount: (n) => {
            itemCount.set(n);
            init();
        },
        remeasure: () => init(),
    };
}

/**
 * Measured-height list renderer for rows whose size is unknown until rendered.
 * Rows start at the axis estimate; a ResizeObserver reports each row's real height,
 * the axis is patched, and the scroll position is re-anchored to the item under the
 * viewport top so corrections above the fold do not jump. Recycling is the same
 * circular buffer as mountList. Stateless rows (use a keyed variant for stateful
 * content). Pool is pre-sized from the smallest known size.
 *
 * @param {HTMLElement} host
 * @param {object} scope  lite-element scope ({ effect, on, onCleanup }).
 * @param {object} opts   { count, estimateSize, viewport, overscan?, render }
 */
export function mountMeasuredList(host, scope, {count, estimateSize, viewport, overscan = 3, render}) {
    const axis = measuredAxis({count, estimateSize, viewport, overscan});
    host.style.overflow = "auto";
    host.style.position = "relative";
    if (host.tabIndex < 0) host.tabIndex = 0;
    const spacer = host.ownerDocument.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.width = "1px";
    spacer.style.visibility = "hidden";
    spacer.setAttribute("aria-hidden", "true");
    host.appendChild(spacer);
    scope.effect(() => {
        spacer.style.height = axis.totalSize() + "px";
    });

    // Anchor: the item under the viewport top and its sub-item offset. A measurement
    // above the fold shifts offsets; re-pinning to the anchor keeps the view steady.
    let anchorIndex = 0;
    let anchorDelta = 0;
    const captureAnchor = () => {
        anchorIndex = axis.firstIndex.peek();
        anchorDelta = host.scrollTop - axis.positionAt(anchorIndex);
    };
    scope.on(host, "scroll", () => {
        axis.setScroll(host.scrollTop);
        captureAnchor();
    });

    const pool = [];
    let PS = 0;
    let vh = viewport;
    let ro = null;
    const ensurePool = () => {
        const min = axis.minSize() || 1;
        const need = Math.min(count, Math.ceil(vh / min) + 1 + 2 * overscan);
        if (need <= PS) return;
        for (const p of pool) p.el.remove();
        pool.length = 0;
        PS = need;
        for (let i = 0; i < PS; i++) {
            const el = host.ownerDocument.createElement("div");
            el.style.position = "absolute";
            el.style.left = "0";
            el.style.right = "0";
            el.style.display = "none";
            host.appendChild(el);
            pool.push({el, idx: -1});
            if (ro) ro.observe(el);
        }
    };

    if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
                for (let i = 0; i < pool.length; i++) {
                    const p = pool[i];
                    if (p.el === entry.target && p.idx >= 0) {
                        const h = entry.contentRect.height;
                        if (h > 0 && h !== axis.sizeAt(p.idx)) {
                            axis.measure(p.idx, h);
                            changed = true;
                        }
                        break;
                    }
                }
            }
            if (changed) {
                const top = clampScroll(axis.positionAt(anchorIndex) + anchorDelta, axis.totalSize.peek(), vh);
                host.scrollTop = top;
                axis.setScroll(top);
            }
        });
        const vpRo = new ResizeObserver((entries) => {
            vh = entries[0].contentRect.height;
            axis.setViewport(vh);
            ensurePool();
        });
        vpRo.observe(host);
        scope.onCleanup(() => {
            ro.disconnect();
            vpRo.disconnect();
        });
    }
    captureAnchor();
    ensurePool();

    scope.effect(() => {
        axis.totalSize();                                     // re-run when a measurement shifts offsets
        const s = axis.start(), e = axis.end();
        for (let i = s; i < e; i++) {
            const cell = pool[i % PS];
            const wasIdx = cell.idx;
            cell.idx = i;
            cell.el.style.transform = `translateY(${axis.positionAt(i)}px)`;
            cell.el.style.display = "";
            if (wasIdx !== i) render(cell.el, i);             // content re-render only on index change
        }
        for (let i = 0; i < PS; i++) {
            const p = pool[i];
            if (p.idx !== -1 && (p.idx < s || p.idx >= e)) {
                p.el.style.display = "none";
                p.idx = -1;
            }
        }
    });

    axis.scrollToIndex = (index, align = "start") => {
        const target = axis.offsetForIndex(index, align);
        host.scrollTop = target;
        axis.setScroll(target);
    };
    return axis;
}

/**
 * Infinite-loader trigger. Fires `onReached` once when the window comes within
 * `distance` items of the end, and again only after `count` grows (a load
 * resolves). Headless: works with any axis exposing `count()` and `end()`.
 * Returns a dispose function.
 *
 *   const stop = onEndReached(axis, {
 *     distance: 10,
 *     onReached: () => resource.loadMore(),   // e.g. @zakkster/lite-resource
 *   });
 *
 * @param {{ count: () => number, end: () => number }} axis
 * @param {{ distance?: number, onReached: () => void }} opts
 * @returns {() => void}
 */
export function onEndReached(axis, {distance = 0, onReached}) {
    let lastFired = -1;
    return effect(() => {
        const c = axis.count();
        const e = axis.end();
        if (c > 0 && c - e <= distance && lastFired !== c) {
            lastFired = c;
            onReached();
        }
    });
}

/**
 * Sticky group-header resolver. Given a reactive first-visible-index accessor and
 * a sorted ascending array of group start indices, returns a computed of the
 * ordinal (0-based) of the group currently at the top of the viewport, or -1 if
 * the first visible index precedes the first group. A renderer binds a pinned
 * header element to this and swaps its content as the ordinal changes.
 *
 *   const active = stickyHeader(axis.firstIndex, groupStarts);
 *   scope.effect(() => { headerEl.textContent = groups[active()]?.label ?? ""; });
 *
 * @param {() => number} firstIndex  Reactive accessor (e.g. axis.firstIndex).
 * @param {number[]} groupStarts     Sorted ascending item indices where groups begin.
 * @returns {() => number}  Computed group ordinal.
 */
export function stickyHeader(firstIndex, groupStarts) {
    return computed(() => {
        const f = firstIndex();
        let lo = 0, hi = groupStarts.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (groupStarts[mid] <= f) {
                ans = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        return ans;
    });
}
