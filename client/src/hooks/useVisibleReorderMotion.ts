import { useEffect } from "react";
import type { RefObject } from "react";
import { useReducedMotion } from "./useReducedMotion";

const MOTION_SELECTOR = "[data-motion-layout-id]";
const MAX_ANIMATED_ITEMS = 24;
const SCROLL_SETTLE_MS = 140;

function visibleRects(root: HTMLElement): Map<string, DOMRect> {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const entries = Array.from(root.querySelectorAll<HTMLElement>(MOTION_SELECTOR))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth)
    .slice(0, MAX_ANIMATED_ITEMS);
  return new Map(entries.map(({ element, rect }) => [element.dataset.motionLayoutId ?? "", rect]));
}

export function useVisibleReorderMotion(rootRef: RefObject<HTMLElement | null>): void {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reducedMotion || typeof MutationObserver === "undefined") return;

    let previous = visibleRects(root);
    let frame = 0;
    let scrollSettleTimer = 0;
    let lastScrollAt = 0;
    const handleScroll = () => {
      lastScrollAt = performance.now();
      window.cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(scrollSettleTimer);
      scrollSettleTimer = window.setTimeout(() => {
        previous = visibleRects(root);
      }, SCROLL_SETTLE_MS);
    };
    const observer = new MutationObserver(() => {
      // Virtualized rows mutate while scrolling. Avoid any layout read until scrolling settles.
      if (performance.now() - lastScrollAt < SCROLL_SETTLE_MS) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (performance.now() - lastScrollAt < SCROLL_SETTLE_MS) return;
        const next = visibleRects(root);
        if (next.size >= MAX_ANIMATED_ITEMS) {
          previous = next;
          return;
        }

        let moved = 0;
        for (const [id, nextRect] of next) {
          const previousRect = previous.get(id);
          const element = root.querySelector<HTMLElement>(`[data-motion-layout-id="${CSS.escape(id)}"]`);
          if (!previousRect || !element) continue;
          const deltaX = previousRect.left - nextRect.left;
          const deltaY = previousRect.top - nextRect.top;
          if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;
          if (Math.abs(deltaX) > window.innerWidth || Math.abs(deltaY) > window.innerHeight) continue;
          moved += 1;
          if (typeof element.animate !== "function") continue;
          element.getAnimations?.().forEach((animation) => animation.cancel());
          element.animate(
            [{ transform: `translate(${deltaX}px, ${deltaY}px)` }, { transform: "translate(0, 0)" }],
            { duration: 210, easing: "cubic-bezier(.2, .75, .25, 1)" }
          );
        }
        if (moved <= MAX_ANIMATED_ITEMS) previous = next;
      });
    });

    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(scrollSettleTimer);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [reducedMotion, rootRef]);
}
