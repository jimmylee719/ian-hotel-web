import Link from "next/link";
import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Header becomes a sort link (needs `sort` and `sortHref` on the table). */
  sortable?: boolean;
  align?: "left" | "right";
};

export type SortState = { key: string; dir: "asc" | "desc" };

/**
 * Server-rendered table. Sorting is URL-driven: `sortHref(key, dir)` returns the link a sortable header
 * points to, and `sort` marks the current column. An empty `rows` shows `empty` instead.
 */
export function DataTable<T>({
  columns, rows, rowKey, sort, sortHref, empty = "沒有符合條件的資料", caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: SortState;
  sortHref?: (key: string, dir: "asc" | "desc") => string;
  empty?: string;
  caption?: string;
}) {
  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        {caption ? <caption className="adm-sr">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th key={c.key} scope="col" aria-sort={ariaSort} className={c.align === "right" ? "adm-right" : undefined}>
                  {c.sortable && sortHref ? (
                    <Link href={sortHref(c.key, active && sort.dir === "asc" ? "desc" : "asc")} className="adm-sort">
                      {c.header}
                      <span aria-hidden="true">{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
                    </Link>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="adm-empty">{empty}</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "adm-right" : undefined}>{c.render(r)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
