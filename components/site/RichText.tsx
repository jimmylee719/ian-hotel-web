import { Fragment, type ReactNode } from "react";

/**
 * Renders the content body format used in content/localized/*: blank line between paragraphs,
 * "## " for a heading, "- " for a list item ("  - " nested one level).
 */
export function RichText({ text, headingLevel = 2 }: { text: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { text: string; sub: string[] }[] | null = null;

  const flushPara = () => {
    if (para.length)
      out.push(
        <p key={out.length}>
          {para.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {l}
            </Fragment>
          ))}
        </p>,
      );
    para = [];
  };
  const flushList = () => {
    if (list)
      out.push(
        <ul key={out.length}>
          {list.map((item, i) => (
            <li key={i}>
              {item.text}
              {item.sub.length > 0 && (
                <ul>
                  {item.sub.map((s, j) => (
                    <li key={j}>{s}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>,
      );
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (line.startsWith("## ")) {
      flushPara();
      flushList();
      out.push(<H key={out.length}>{line.slice(3)}</H>);
    } else if (/^\s{2,}- /.test(line) && list?.length) {
      list[list.length - 1].sub.push(line.trim().slice(2));
    } else if (line.startsWith("- ")) {
      flushPara();
      (list ??= []).push({ text: line.slice(2), sub: [] });
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="prose">{out}</div>;
}
