import type { CSSProperties } from "react";
import { PHOTO_DIMENSIONS, frameBox } from "@/lib/design/photo-fit";
import { Photo } from "../Photo";

/**
 * A cover-fit photo frame that never shows its source softer than the sharpness rule. `slotWidth` is the slot's
 * desktop width, `cap` its design height maximum. The frame gets `--frame-h` (min(cap, source.h / tolerance)) and
 * `--frame-max-w` (source.w / tolerance) so it stays sharp at every viewport width.
 *
 * A key with no recorded dimensions is a staff upload: it is shown at the slot's own box (slotWidth x cap), which
 * also serves as its intrinsic size for layout. A known old-site photo too narrow for the slot is a wrong photo pick:
 * outside production it throws so `next dev` and tests surface it; in production it is shown at its largest sharp
 * size centred in the slot.
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
  if (!box.fits && process.env.NODE_ENV !== "production") {
    throw new Error(`Photo "${src}" is ${PHOTO_DIMENSIONS[src].w}px wide, below ${tolerance}x the ${slotWidth}px slot (max ${box.maxW}px); put it in a smaller slot (.${className}).`);
  }
  const dims = box.known ? PHOTO_DIMENSIONS[src] : { w: slotWidth, h: cap };
  const style = { "--frame-h": `${box.h}px`, "--frame-max-w": `${box.maxW}px` } as CSSProperties;
  return (
    <div className={`frame ${className}`} style={style}>
      <Photo src={src} alt={alt} width={dims.w} height={dims.h} sizes={sizes} priority={priority} />
    </div>
  );
}
