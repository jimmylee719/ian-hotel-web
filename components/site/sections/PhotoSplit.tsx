import type { ReactNode } from "react";
import { Frame } from "./Frame";

/*
 * Desktop slot widths inside a chapter body (<= 904px; .photo-split is capped at that width): columns 1.3fr / 1fr
 * with a 28px gap, so the large photo is 495px wide and the small one 381px.
 */
const LARGE = { w: 495, cap: 330 };
const SMALL = { w: 381, cap: 240 };

type Photo = { src: string; alt: string; open?: { index: number; label: string } };

/** Large photo beside a column holding an optional small photo and the text (`children`). `priority` loads the large photo first (LCP). */
export function PhotoSplit({ large, small, children, priority }: { large: Photo; small?: Photo; children: ReactNode; priority?: boolean }) {
  return (
    <div className="photo-split">
      <Frame className="split-large" src={large.src} alt={large.alt} slotWidth={LARGE.w} cap={LARGE.cap} sizes="(max-width: 700px) calc(100vw - 40px), 495px" priority={priority} open={large.open} />
      <div className="split-side">
        {small && <Frame className="split-small" src={small.src} alt={small.alt} slotWidth={SMALL.w} cap={SMALL.cap} sizes="(max-width: 700px) calc(100vw - 40px), 381px" open={small.open} />}
        <div className="split-text">{children}</div>
      </div>
    </div>
  );
}
