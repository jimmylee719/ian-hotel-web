"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { mediaSrcSet, mediaUrl } from "@/lib/media";

/**
 * Room photos: a large first photo plus thumbnails; any photo opens a lightbox (<dialog>, so focus
 * is trapped and Esc closes it). Arrow keys and the buttons move between photos.
 */
export function RoomGallery({ images, roomName }: { images: string[]; roomName: string }) {
  const t = useTranslations("rooms");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const total = images.length;

  const open = (i: number) => {
    setIndex(i);
    dialogRef.current?.showModal();
  };
  const step = useCallback((d: number) => setIndex((i) => (i + d + total) % total), [total]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [step]);

  if (!total) return null;
  const alt = (i: number) => t("photoAlt", { room: roomName, n: i + 1 });

  return (
    <section className="gallery" aria-label={t("photos", { room: roomName })}>
      <ul>
        {images.map((key, i) => (
          <li key={key}>
            <button type="button" onClick={() => open(i)} aria-label={t("openPhoto", { n: i + 1 })} aria-haspopup="dialog">
              {/* eslint-disable-next-line @next/next/no-img-element -- R2 media */}
              <img
                className="photo-warm"
                src={mediaUrl(key, i === 0 ? 1100 : 400)}
                srcSet={i === 0 ? mediaSrcSet(key, 1100) : undefined}
                sizes={i === 0 ? "(max-width: 1240px) calc(100vw - 40px), 1144px" : undefined}
                alt={alt(i)}
                width={i === 0 ? 1100 : 400}
                height={i === 0 ? 528 : 300}
                loading={i === 0 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : undefined}
                decoding="async"
              />
            </button>
          </li>
        ))}
      </ul>
      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={t("photos", { room: roomName })}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialogRef.current?.close();
        }}
      >
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element -- R2 media */}
          <img src={mediaUrl(images[index], 1100)} alt={alt(index)} />
          <figcaption aria-live="polite">{t("counter", { n: index + 1, total })}</figcaption>
        </figure>
        <div className="lightbox-controls">
          <button type="button" onClick={() => step(-1)} aria-label={t("prev")}>
            ←
          </button>
          <button type="button" onClick={() => step(1)} aria-label={t("next")}>
            →
          </button>
          <button type="button" className="lightbox-close" onClick={() => dialogRef.current?.close()}>
            {t("close")}
          </button>
        </div>
      </dialog>
    </section>
  );
}
