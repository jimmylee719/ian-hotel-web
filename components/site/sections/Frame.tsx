import type { CSSProperties } from "react";
import { PHOTO_DIMENSIONS, frameBox } from "@/lib/design/photo-fit";
import { Photo } from "../Photo";

/**
 * A cover-fit photo frame that never shows its source softer than the sharpness rule. `slotWidth` is the slot's
 * desktop width, `cap` its design height maximum. The frame gets `--frame-h` (min(cap, source.h / tolerance)) and
 * `--frame-max-w` (source.w / tolerance) so it stays sharp at every viewport width.
 *
 * A source too narrow for the slot, or an unknown key, is a wrong photo pick: outside production it throws so
 * `next dev` and tests surface it. In production (a public page must not fail) a narrow source is shown at its largest
 * sharp size centred in the slot, and an unknown key renders nothing.
 */
export function Frame({ src, alt, slotWidth, cap, sizes, className, priority, tolerance = 1.5 }: {
  src: string;
  alt: string;
  slotWidth: number;
  cap: number;
  sizes: string;
  className: string;
  priority?: boolean;
  tolerance?: number;
}) {
  const box = frameBox(src, slotWidth, cap, tolerance);
  if (!box || !box.fits) {
    const why = box ? `is ${PHOTO_DIMENSIONS[src].w}px wide, below ${tolerance}x the ${slotWidth}px slot (max ${box.maxW}px)` : "has no recorded dimensions (unknown key)";
    if (process.env.NODE_ENV !== "production") throw new Error(`Photo "${src}" ${why}; put it in a smaller slot (.${className}).`);
    if (!box) return null;
  }
  const dims = PHOTO_DIMENSIONS[src];
  const style = { "--frame-h": `${box.h}px`, "--frame-max-w": `${box.maxW}px` } as CSSProperties;
  return (
    <div className={`frame ${className}`} style={style}>
      <Photo src={src} alt={alt} width={dims.w} height={dims.h} sizes={sizes} priority={priority} />
    </div>
  );
}
