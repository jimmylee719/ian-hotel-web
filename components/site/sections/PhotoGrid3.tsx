import type { ReactNode } from "react";
import { Frame } from "./Frame";

type Item = { src: string; alt: string; caption?: string; captionEn?: string };

/*
 * Desktop slot widths inside a chapter body (<= 904px; .photo-grid3 is capped at that width): three 288px columns,
 * 20px gaps. The lead spans two columns (596px); items take one (288px).
 */
const LEAD = { w: 596, cap: 290 };
const ITEM = { w: 288, cap: 210 };

/** Wide lead photo + up to two captioned photos + a text slot (`children`). */
export function PhotoGrid3({ lead, items, children }: { lead: { src: string; alt: string }; items: Item[]; children?: ReactNode }) {
  return (
    <div className="photo-grid3">
      <Frame className="grid3-lead" src={lead.src} alt={lead.alt} slotWidth={LEAD.w} cap={LEAD.cap} sizes="(max-width: 700px) calc(100vw - 40px), 596px" />
      {items.slice(0, 2).map((item) => (
        <figure className="grid3-item" key={item.src}>
          <Frame className="grid3-photo" src={item.src} alt={item.alt} slotWidth={ITEM.w} cap={ITEM.cap} sizes="(max-width: 700px) calc(100vw - 40px), 288px" />
          {(item.caption || item.captionEn) && (
            <figcaption className="photo-cap">
              {item.caption}
              {item.captionEn && <small lang="en">{item.captionEn}</small>}
            </figcaption>
          )}
        </figure>
      ))}
      {children && <div className="grid3-text">{children}</div>}
    </div>
  );
}
