// _setup.js — minimal DOM stubs and a real-shape lite-element scope for tests.
// Idempotent: importing twice is fine. Captures global observer callbacks so
// tests can drive RO/IO firings manually (and assert when they DON'T fire).
import { effect } from "@zakkster/lite-signal";

// ─── DOM stub ────────────────────────────────────────────────────────────────
if (typeof globalThis.HTMLElement === "undefined") {
    class Style {
        constructor() { this._m = new Map(); }
        get height() { return this._m.get("height") || ""; }
        set height(v) { this._m.set("height", v); }
        get width() { return this._m.get("width") || ""; }
        set width(v) { this._m.set("width", v); }
        get overflow() { return this._m.get("overflow") || ""; }
        set overflow(v) { this._m.set("overflow", v); }
        get position() { return this._m.get("position") || ""; }
        set position(v) { this._m.set("position", v); }
        get transform() { return this._m.get("transform") || ""; }
        set transform(v) { this._m.set("transform", v); }
        get display() { return this._m.get("display") || ""; }
        set display(v) { this._m.set("display", v); }
        get left() { return this._m.get("left") || ""; }
        set left(v) { this._m.set("left", v); }
        get right() { return this._m.get("right") || ""; }
        set right(v) { this._m.set("right", v); }
        get top() { return this._m.get("top") || ""; }
        set top(v) { this._m.set("top", v); }
        get visibility() { return this._m.get("visibility") || ""; }
        set visibility(v) { this._m.set("visibility", v); }
    }
    class HTMLElementStub {
        constructor() {
            this.style = new Style();
            this.children = [];
            this.parent = null;
            this._listeners = {};
            this._scrollTop = 0;
            this._scrollLeft = 0;
            this._clientHeight = 0;
            this._clientWidth = 0;
            this._writes = 0;            // diagnostic: count style.transform writes
            this._attrs = {};
            this.tabIndex = -1;          // browsers default to -1 for non-form, non-link elements
            this.ownerDocument = globalThis.document;
        }
        appendChild(c) { this.children.push(c); c.parent = this; return c; }
        removeChild(c) {
            const i = this.children.indexOf(c);
            if (i >= 0) this.children.splice(i, 1);
            c.parent = null;
            return c;
        }
        remove() { if (this.parent) this.parent.removeChild(this); }
        setAttribute(k, v) { this._attrs[k] = v; }
        getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
        removeAttribute(k) { delete this._attrs[k]; }
        addEventListener(t, h) { (this._listeners[t] || (this._listeners[t] = [])).push(h); }
        removeEventListener(t, h) {
            const a = this._listeners[t] || []; const i = a.indexOf(h); if (i >= 0) a.splice(i, 1);
        }
        dispatchEvent(t) { for (const h of (this._listeners[t] || [])) h({ target: this, type: t }); }
        get scrollTop() { return this._scrollTop; }
        set scrollTop(v) { this._scrollTop = v; this.dispatchEvent("scroll"); }
        get scrollLeft() { return this._scrollLeft; }
        set scrollLeft(v) { this._scrollLeft = v; this.dispatchEvent("scroll"); }
        get clientHeight() { return this._clientHeight; }
        get clientWidth() { return this._clientWidth; }
        firstChild() { return this.children[0]; }
        // For ResizeObserver simulation
        getBoundingClientRect() {
            return { width: this._clientWidth, height: this._clientHeight, top: 0, left: 0, right: this._clientWidth, bottom: this._clientHeight };
        }
    }
    globalThis.HTMLElement = HTMLElementStub;
    globalThis.document = {
        createElement(_tag) { return new HTMLElementStub(); },
    };
}

// Patch HTMLElement to count style.transform writes for recycling assertions.
{
    const proto = globalThis.HTMLElement.prototype;
    if (proto && !proto._stylePatched) {
        proto._stylePatched = true;
    }
}

// ─── ResizeObserver stub (captures observers so tests can fire them) ─────────
if (!globalThis.__roRegistry) {
    globalThis.__roRegistry = [];                                 // [{ cb, targets: [el] }]
    globalThis.ResizeObserver = class {
        constructor(cb) { this._cb = cb; this._targets = []; globalThis.__roRegistry.push(this); }
        observe(el) { this._targets.push(el); }
        unobserve(el) { const i = this._targets.indexOf(el); if (i >= 0) this._targets.splice(i, 1); }
        disconnect() { this._targets.length = 0; }
    };
}
export function fireResize(el, width, height) {
    el._clientWidth = width; el._clientHeight = height;
    for (const ro of globalThis.__roRegistry) {
        if (ro._targets.includes(el)) {
            ro._cb([{ target: el, contentRect: { width, height, top: 0, left: 0, right: width, bottom: height } }]);
        }
    }
}
export function roCallbackCount() {
    // Total observers active across the suite (used to detect leaks).
    let n = 0;
    for (const ro of globalThis.__roRegistry) n += ro._targets.length;
    return n;
}

// ─── IntersectionObserver stub ───────────────────────────────────────────────
if (!globalThis.__ioRegistry) {
    globalThis.__ioRegistry = [];
    globalThis.IntersectionObserver = class {
        constructor(cb, opts) { this._cb = cb; this._opts = opts; this._targets = []; globalThis.__ioRegistry.push(this); }
        observe(el) { this._targets.push(el); }
        unobserve(el) { const i = this._targets.indexOf(el); if (i >= 0) this._targets.splice(i, 1); }
        disconnect() { this._targets.length = 0; }
        takeRecords() { return []; }
    };
}
export function fireIntersection(el, isIntersecting, rect) {
    for (const io of globalThis.__ioRegistry) {
        if (io._targets.includes(el)) {
            io._cb([{
                target: el,
                isIntersecting,
                intersectionRatio: isIntersecting ? 1 : 0,
                boundingClientRect: rect || el.getBoundingClientRect(),
                intersectionRect: isIntersecting ? (rect || el.getBoundingClientRect()) : { width: 0, height: 0 },
                rootBounds: null,
                time: performance.now(),
            }]);
        }
    }
}

// ─── lite-element-shaped scope ───────────────────────────────────────────────
// Real shape: { effect(fn), on(el, type, handler), onCleanup(fn) } plus
// `dispose()` to tear everything down. Mirrors the lite-element production
// surface so the renderers behave identically against this scope.
export function makeScope() {
    const stops = [];      // effect handles
    const cleans = [];     // listener removers + onCleanup callbacks
    return {
        effect(fn) { const h = effect(fn); stops.push(h); return h; },
        on(el, type, handler, opts) {
            el.addEventListener(type, handler, opts);
            const off = () => el.removeEventListener(type, handler, opts);
            cleans.push(off);
            return off;
        },
        onCleanup(fn) { cleans.push(fn); },
        dispose() {
            for (let i = stops.length - 1; i >= 0; i--) stops[i]();
            for (let i = cleans.length - 1; i >= 0; i--) { try { cleans[i](); } catch (_) {} }
            stops.length = 0; cleans.length = 0;
        },
    };
}

// ─── Helper: build a sized host ──────────────────────────────────────────────
export function makeHost(width, height) {
    const h = document.createElement("div");
    h._clientWidth = width;
    h._clientHeight = height;
    return h;
}
