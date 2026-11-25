"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { mediaUrl } from "@/lib/media";

/**
 * Full-size photo viewer for the room gallery: any `button[data-viewer-index]` inside `children` (see Frame's `open`)
 * opens that photo at its full source size in a <dialog>, so focus is trapped and Esc closes it. Arrow keys and the
 * buttons move between photos; a click on the backdrop closes it. The full-size <img> is only rendered once the
 * viewer has been opened, so a room page never fetches the 1100px file up front.
 */
export function PhotoViewer({ photos, label, children }: { photos: { src: string; alt: string }[]; label: string; children: ReactNode }) {
  const t = useTranslations("rooms");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [opened, setOpened] = useState(false);
  const total = photos.length;

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

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button[data-viewer-index]");
    if (!button) return;
    const i = Number(button.dataset.viewerIndex);
    if (!Number.isInteger(i) || i < 0 || i >= total) return;
    setIndex(i);
    setOpened(true);
    dialogRef.current?.showModal();
  };

  const photo = photos[index];
  return (
    <div className="photo-viewer" onClick={onClick}>
      {children}
      {total > 0 && (
        <dialog
          ref={dialogRef}
          className="lightbox"
          aria-label={label}
          onClick={(e) => {
            if (e.target === e.currentTarget) dialogRef.current?.close();
          }}
        >
          <figure>
            {opened && (
              // eslint-disable-next-line @next/next/no-img-element -- R2 media, full source size
              <img src={mediaUrl(photo.src, 1100)} alt={photo.alt} />
            )}
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
      )}
    </div>
  );
}
