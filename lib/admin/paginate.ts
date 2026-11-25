export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** A list query split in two: one page of rows, and the total (a separate `count()` query). */
export type PageableQuery<T> = {
  rows: (limit: number, offset: number) => PromiseLike<T[]>;
  total: () => PromiseLike<number>;
};

export type Page<T> = { rows: T[]; total: number; page: number; pageCount: number };

/** pageSize defaults to 20 and is capped at 100; an out-of-range page is clamped to the nearest real page. */
export async function paginate<T>(
  query: PageableQuery<T>,
  opts: { page: number; pageSize?: number },
): Promise<Page<T>> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
  const total = await query.total();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(opts.page) || 1));
  const rows = total === 0 ? [] : await query.rows(pageSize, (page - 1) * pageSize);
  return { rows, total, page, pageCount };
}
