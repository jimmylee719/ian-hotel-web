import type { CSSProperties } from "react";
import { PHOTO_DIMENSIONS, frameHeight } from "@/lib/design/photo-fit";
import { Photo } from "../Photo";

/**
 * A cover-fit photo frame. Its height is the sharp maximum for `slotWidth` (desktop layout width of the slot),
 * capped at `cap`; it is exposed as `--frame-h` so CSS can shrink it further on small screens. A source that cannot
 * fill the slot sharply (frameHeight 0) keeps the CSS default height; callers should move it to a smaller slot.
 */
export function Frame({ src, alt, slotWidth, cap, sizes, className, priority, tolerance }: {
  src: string;
  alt: string;
  slotWidth: number;
  cap: number;
  sizes: string;
  className: string;
  priority?: boolean;
  tolerance?: number;
}) {
  const h = frameHeight(src, slotWidth, cap, tolerance);
  const dims = PHOTO_DIMENSIONS[src] ?? { w: 1100, h: 440 };
  const style = h ? ({ "--frame-h": `${h}px` } as CSSProperties) : undefined;
  return (
    <div className={`frame ${className}`} style={style}>
      <Photo src={src} alt={alt} width={dims.w} height={dims.h} sizes={sizes} priority={priority} />
    </div>
  );
}
