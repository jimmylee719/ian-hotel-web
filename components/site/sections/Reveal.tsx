"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { revealEnabled } from "@/lib/design/motion";

/**
 * Gentle fade-up on first scroll into view (once, threshold 0.15). Server HTML is always visible; the hidden starting
 * state is only armed on the client when motion is allowed, so reduced-motion and no-JS visitors see it as-is.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || !revealEnabled((q) => window.matchMedia(q))) return;
    el.classList.add("is-armed");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.classList.add("is-visible");
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="reveal">
      {children}
    </div>
  );
}
