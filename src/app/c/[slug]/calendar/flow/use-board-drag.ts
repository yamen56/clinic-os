"use client";

/*
  Dragging a patient's card from one column of the Today board to another
  (Yamen, 2026-11-02): Coming → Waiting is "arrived", → In room is "called
  in", → Finished opens the finish sheet, and one column back is Undo.

  One hand-written drag for mouse, pen and finger, because the browser's own
  drag and drop does nothing on a phone, and most doctors are on one:

  - A mouse picks the card up once it moves a few pixels.
  - A finger picks it up after a short press and hold, so a swipe still
    scrolls the board; once it is up, the page stops scrolling under it and
    scrolls by itself near the top and bottom edges, to reach the phone's
    column tabs, which take a drop like the columns do.

  The card itself does not move; a copy of it follows the pointer, and where
  it can go is outlined. The buttons on the card stay what they were.
*/

import { useCallback, useEffect, useRef, useState } from "react";

const HOLD_MS = 350;
const SLOP = 8;
const EDGE = 72;

type Pending = { id: string; from: string; el: HTMLElement; x: number; y: number; touch: boolean; timer: number | null; pointerId: number };
export type DragState = { id: string; from: string; over: string | null };

export function useBoardDrag(opts: {
  /** Whether a card may go from one column to another. */
  canDrop: (id: string, from: string, to: string) => boolean;
  onDrop: (id: string, from: string, to: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<Pending | null>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const point = useRef({ x: 0, y: 0 });
  const live = useRef<DragState | null>(null);
  const justDropped = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const place = () => {
    const g = ghost.current;
    if (g) g.style.transform = `translate(${point.current.x - offset.current.x}px, ${point.current.y - offset.current.y}px) rotate(-1.5deg)`;
  };

  const target = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>("[data-drop-col]")?.dataset.dropCol ?? null;
  };

  const move = useCallback((x: number, y: number) => {
    point.current = { x, y };
    place();
    const d = live.current;
    if (!d) return;
    const col = target(x, y);
    const over = col && col !== d.from && optsRef.current.canDrop(d.id, d.from, col) ? col : null;
    if (over !== d.over) {
      live.current = { ...d, over };
      setDrag(live.current);
    }
  }, []);

  const end = useCallback((drop: boolean) => {
    const d = live.current;
    live.current = null;
    pending.current = null;
    ghost.current?.remove();
    ghost.current = null;
    document.documentElement.classList.remove("cursor-grabbing");
    setDrag(null);
    if (d) {
      // The click that ends a drag is not a tap on the card.
      justDropped.current = true;
      window.setTimeout(() => (justDropped.current = false), 0);
      if (drop && d.over) optsRef.current.onDrop(d.id, d.from, d.over);
    }
  }, []);

  const start = useCallback((p: Pending) => {
    const r = p.el.getBoundingClientRect();
    offset.current = { x: p.x - r.left, y: p.y - r.top };
    point.current = { x: p.x, y: p.y };
    const g = document.createElement("div");
    g.setAttribute("aria-hidden", "true");
    g.dataset.dragGhost = p.id;
    g.style.cssText = `position:fixed;left:0;top:0;width:${r.width}px;z-index:70;pointer-events:none;opacity:.92;box-shadow:0 12px 32px rgb(0 0 0 / .22);border-radius:12px;`;
    // A picture of the card, not a second card: nothing in it answers to the card's own hooks.
    const copy = p.el.cloneNode(true) as HTMLElement;
    for (const n of [copy, ...copy.querySelectorAll<HTMLElement>("*")])
      for (const a of [...n.attributes]) if (a.name.startsWith("data-") || a.name === "id") n.removeAttribute(a.name);
    g.appendChild(copy);
    document.body.appendChild(g);
    ghost.current = g;
    place();
    document.documentElement.classList.add("cursor-grabbing");
    live.current = { id: p.id, from: p.from, over: null };
    setDrag(live.current);
    if (p.touch) navigator.vibrate?.(15);
  }, []);

  /* While a card is up: follow the pointer or the finger, and scroll near the edges. */
  useEffect(() => {
    if (!drag) return;
    const onPointerMove = (e: PointerEvent) => move(e.clientX, e.clientY);
    const onPointerUp = () => end(true);
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (t) move(t.clientX, t.clientY);
    };
    const onTouchEnd = () => end(true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && end(false);
    let raf = 0;
    const scroll = () => {
      const y = point.current.y;
      const h = window.innerHeight;
      if (y < EDGE) window.scrollBy(0, -Math.ceil((EDGE - y) / 6));
      else if (y > h - EDGE) window.scrollBy(0, Math.ceil((y - (h - EDGE)) / 6));
      raf = requestAnimationFrame(scroll);
    };
    raf = requestAnimationFrame(scroll);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("keydown", onKey);
    };
    // Only when a drag starts or ends, not on every column it passes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, move, end]);

  /* Before a card is up: a mouse that moves, or a finger that holds still. */
  useEffect(() => {
    const cancel = () => {
      const p = pending.current;
      if (p?.timer) window.clearTimeout(p.timer);
      pending.current = null;
    };
    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || live.current || e.pointerId !== p.pointerId) return;
      const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP;
      if (!far) return;
      if (p.touch) return cancel(); // a swipe: the page scrolls
      start(p);
      move(e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [start, move]);

  /** Props for the wrapper around one card. */
  const handle = (id: string, from: string) => ({
    "data-drag-card": id,
    /*
      A phone decides when the finger goes down whether the page may scroll
      under it; a listener added once the card is up comes too late, and the
      board slides away beneath the drag. So each card listens from the start
      — and only stops the scroll once it has been picked up.
    */
    ref: (el: HTMLDivElement | null) => {
      if (!el) return;
      const hold = (e: TouchEvent) => {
        if (live.current && e.cancelable) e.preventDefault();
      };
      el.addEventListener("touchmove", hold, { passive: false });
      return () => el.removeEventListener("touchmove", hold);
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || live.current) return;
      const t = e.target as HTMLElement;
      // The card's own buttons, menus and fields stay buttons.
      if (t.closest("[data-no-drag], input, select, textarea, [role='menu']")) return;
      const touch = e.pointerType !== "mouse";
      const p: Pending = { id, from, el: e.currentTarget, x: e.clientX, y: e.clientY, touch, timer: null, pointerId: e.pointerId };
      if (touch) p.timer = window.setTimeout(() => pending.current === p && start(p), HOLD_MS);
      pending.current = p;
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (justDropped.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // A long press is a pick-up, not the phone's own menu.
    onContextMenu: (e: React.MouseEvent) => {
      if (pending.current?.touch || live.current) e.preventDefault();
    },
  });

  return { drag, handle };
}
