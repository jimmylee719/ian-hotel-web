import type { ReactNode } from "react";

/** Page title block: h1, optional secondary line (English name) and lead paragraph. */
export function PageHead({ title, sub, lead, children }: { title: string; sub?: string; lead?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {sub && (
        <p className="page-sub" lang="en">
          {sub}
        </p>
      )}
      {lead && <p className="page-lead">{lead}</p>}
      {children}
    </header>
  );
}
