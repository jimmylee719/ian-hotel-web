import type { ReactNode } from "react";
import { Frame } from "./Frame";

/*
 * Desktop slot widths inside a chapter body (<= 904px; .photo-split is capped at that width): columns 1.3fr / 1fr
 * with a 28px gap, so the large photo is 495px wide and the small one 381px.
 */
const LARGE = { w: 495, cap: 330 };
const SMALL = { w: 381, cap: 240 };

/** Large photo beside a column holding an optional small photo and the text (`children`). */
export function PhotoSplit({ large, small, children }: { large: { src: string; alt: string }; small?: { src: string; alt: string }; children: ReactNode }) {
  return (
    <div className="photo-split">
      <Frame className="split-large" src={large.src} alt={large.alt} slotWidth={LARGE.w} cap={LARGE.cap} sizes="(max-width: 700px) calc(100vw - 40px), 495px" />
      <div className="split-side">
        {small && <Frame className="split-small" src={small.src} alt={small.alt} slotWidth={SMALL.w} cap={SMALL.cap} sizes="(max-width: 700px) calc(100vw - 40px), 381px" />}
        <div className="split-text">{children}</div>
      </div>
    </div>
  );
}
