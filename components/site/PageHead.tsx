import type { ReactNode } from "react";
import { Frame } from "./sections/Frame";

type Props = {
  title: string;
  /** Secondary line, e.g. the English name. */
  sub?: string;
  lead?: string;
  children?: ReactNode;
  /** `ink` (default): full-bleed ink band for content pages. `paper`: compact head for the booking and manage pages. */
  theme?: "ink" | "paper";
  /** Small-caps English label under the title. */
  en?: string;
  /** R2 key of one photo shown at the right of an ink head (<= 560px wide). */
  photo?: string;
};

/** Page title block: h1 with optional English label, secondary line, lead paragraph and (ink only) one photo. */
export function PageHead({ title, sub, lead, children, theme = "ink", en, photo }: Props) {
  const text = (
    <>
      <h1>{title}</h1>
      {en && (
        <p className="page-en" lang="en">
          {en}
        </p>
      )}
      {sub && (
        <p className="page-sub" lang="en">
          {sub}
        </p>
      )}
      {lead && <p className="page-lead">{lead}</p>}
      {children}
    </>
  );

  if (theme === "paper") return <header className="page-head page-head-paper">{text}</header>;

  return (
    <header className={["page-head-ink", "band", "band-ink", photo && "has-photo"].filter(Boolean).join(" ")}>
      <div className="wrap page-head-inner">
        <div className="page-head-text">{text}</div>
        {photo && <Frame className="page-head-photo" src={photo} alt="" slotWidth={560} cap={330} sizes="(max-width: 900px) calc(100vw - 40px), 560px" priority />}
      </div>
    </header>
  );
}
