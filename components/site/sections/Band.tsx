import type { ReactNode } from "react";

/**
 * Full-bleed paper or ink band; content stays inside `.wrap`. Bleeds to the viewport edges even when
 * rendered inside a `main.wrap` (see `.band` in app/site.css).
 */
export function Band({ theme, children, id, className }: { theme: "ink" | "paper"; children: ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className={["band", `band-${theme}`, className].filter(Boolean).join(" ")}>
      <div className="wrap">{children}</div>
    </div>
  );
}
