import type { ReactNode } from "react";

/**
 * Numbered chapter: a left rail (two-digit Newsreader numeral, zh title, small-caps English label) beside the content.
 * The rail moves above the content at <=900px. No numeral when `num` is undefined.
 */
export function Chapter({ num, title, en, children, headingLevel = 2 }: { num?: number; title: string; en?: string; children: ReactNode; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section className="chapter">
      <div className="chapter-rail">
        {num !== undefined && (
          <span className="chapter-num" aria-hidden="true">
            {String(num).padStart(2, "0")}
          </span>
        )}
        <Heading className="chapter-title">{title}</Heading>
        {en && (
          <p className="chapter-en" lang="en">
            {en}
          </p>
        )}
      </div>
      <div className="chapter-body">{children}</div>
    </section>
  );
}
