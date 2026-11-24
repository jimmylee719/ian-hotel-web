import { mediaSrcSet, mediaUrl } from "@/lib/media";

type Props = {
  /** R2 key, e.g. "rooms/rooms_76.jpg". */
  src: string;
  alt: string;
  /** Intrinsic size used for layout (CSS sets the displayed aspect ratio). */
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
  /** With `sizes`, a srcset up to `width` lets phones fetch a smaller file. */
  sizes?: string;
};

/** A warm-toned photo from R2. Sources are at most 1100px wide, so they are never upscaled. */
export function Photo({ src, alt, width, height, className, priority, sizes }: Props) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- served from R2 via /media (Cloudflare Images in production)
    <img
      className={["photo-warm", className].filter(Boolean).join(" ")}
      src={mediaUrl(src, width)}
      srcSet={sizes ? mediaSrcSet(src, width) : undefined}
      sizes={sizes}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
    />
  );
}
