import Link from "next/link";

/** Previous / next links plus the position. `hrefFor` builds the URL for a page so filters survive. */
export function Pagination({
  page, pageCount, total, hrefFor,
}: { page: number; pageCount: number; total: number; hrefFor: (page: number) => string }) {
  return (
    <nav className="adm-pagination" aria-label="分頁">
      <span className="adm-muted">共 {total} 筆，第 {page} / {pageCount} 頁</span>
      <span className="adm-pagination-links">
        {page > 1 ? <Link href={hrefFor(page - 1)} rel="prev">上一頁</Link> : <span aria-disabled="true">上一頁</span>}
        {page < pageCount ? <Link href={hrefFor(page + 1)} rel="next">下一頁</Link> : <span aria-disabled="true">下一頁</span>}
      </span>
    </nav>
  );
}
