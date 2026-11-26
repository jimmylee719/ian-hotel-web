/**
 * Test availability and prices for the public preview (scripts/seed-preview-ari.ts): the same numbers as
 * scripts/seed-local.ts's fake ARI, for `days` days from `today` (a Taipei calendar date), for every active room type
 * and every active rate plan of its property, read from the database itself (no IDs are baked in):
 * - inventory_daily: 3 rooms of each type per night;
 * - ari_daily: 2000 + sort_order × 150 TWD a night, +400 on Friday and Saturday nights; the column defaults for
 *   min stay (1) and the closed / stop-sell flags (off).
 * Test data only, not the hotel's real prices. Idempotent: ON CONFLICT on each table's primary key DO NOTHING, so a
 * re-run only fills dates that are missing and never resets a night that a booking hold has already taken a room from.
 */
export const PREVIEW_ARI = { rooms: 3, basePrice: 2000, perSortOrder: 150, weekendExtra: 400 } as const;

/** Friday and Saturday nights (as seed-local: Date#getDay 5 and 6 of the night's date). */
function isWeekendNight(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

export function previewAriSql(today: string, days: number, syncedAt: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`bad date: ${today}`);
  if (!Number.isInteger(days) || days < 1) throw new Error(`bad day count: ${days}`);
  if (!Number.isSafeInteger(syncedAt)) throw new Error(`bad timestamp: ${syncedAt}`);
  const start = new Date(`${today}T00:00:00Z`);
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    // A plain calendar date: step whole UTC days, so no local time zone or DST can shift it.
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const extra = isWeekendNight(date) ? PREVIEW_ARI.weekendExtra : 0;
    lines.push(
      `INSERT INTO inventory_daily (property_id, unit_type_id, date, available, source, synced_at) ` +
        `SELECT property_id, id, '${date}', ${PREVIEW_ARI.rooms}, 'siteminder', ${syncedAt} FROM unit_types WHERE active = 1 ` +
        `ON CONFLICT (unit_type_id, date) DO NOTHING;`,
      `INSERT INTO ari_daily (property_id, unit_type_id, rate_plan_id, date, price, source, synced_at) ` +
        `SELECT u.property_id, u.id, r.id, '${date}', ${PREVIEW_ARI.basePrice} + u.sort_order * ${PREVIEW_ARI.perSortOrder} + ${extra}, 'siteminder', ${syncedAt} ` +
        `FROM unit_types u JOIN rate_plans r ON r.property_id = u.property_id WHERE u.active = 1 AND r.active = 1 ` +
        `ON CONFLICT (unit_type_id, rate_plan_id, date) DO NOTHING;`,
    );
  }
  return lines;
}
