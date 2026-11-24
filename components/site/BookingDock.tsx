"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BookingBar } from "@/components/layout/BookingBar";

/** Pages that render their own booking bar mark it with this id; the dock hides while it is on screen. */
export const INLINE_BOOKING_ID = "inline-booking";

/**
 * The booking bar, pinned to the bottom of the viewport on every page. Desktop shows the full
 * form; phones show one button that opens the form as a bottom sheet.
 */
export function BookingDock() {
  const t = useTranslations("booking");
  const [open, setOpen] = useState(false);
  // Starts hidden so the home page does not flash two booking bars before hydration; CSS shows
  // the dock straight away on pages without an inline bar (app/site.css).
  const [inlineVisible, setInlineVisible] = useState(true);

  useEffect(() => {
    const inline = document.getElementById(INLINE_BOOKING_ID);
    if (!inline) return setInlineVisible(false);
    const io = new IntersectionObserver(([e]) => setInlineVisible(e.isIntersecting));
    io.observe(inline);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="booking-dock" data-open={open} data-hidden={inlineVisible && !open} aria-hidden={inlineVisible && !open ? true : undefined} inert={inlineVisible && !open}>
      <div className="wrap">
        <div className="dock-sheet" id="booking-dock-form">
          <button type="button" className="dock-close" onClick={() => setOpen(false)}>
            {t("close")}
          </button>
          <BookingBar />
        </div>
        <button type="button" className="dock-toggle" aria-expanded={open} aria-controls="booking-dock-form" onClick={() => setOpen(true)}>
          {t("openSearch")}
        </button>
      </div>
    </div>
  );
}
