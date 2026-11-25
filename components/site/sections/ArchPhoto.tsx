import { Frame } from "./Frame";

/** Hero arch: 440 wide x <=340 tall on desktop (<=300 tall on mobile), rounded top (radius = half its width). */
export function ArchPhoto({ src, alt, priority }: { src: string; alt: string; priority?: boolean }) {
  return (
    <Frame
      className="arch-photo"
      src={src}
      alt={alt}
      slotWidth={440}
      cap={340}
      tolerance={1.4}
      sizes="(max-width: 700px) calc(100vw - 40px), 440px"
      priority={priority}
    />
  );
}
