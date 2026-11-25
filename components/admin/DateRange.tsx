import { differenceInCalendarDays } from "date-fns";

/** Stay dates as `2026-11-26 至 2026-11-28（2 晚）`. Inputs are `yyyy-MM-dd` calendar dates. */
export function DateRange({ checkIn, checkOut }: { checkIn: string; checkOut: string }) {
  const nights = differenceInCalendarDays(new Date(`${checkOut}T00:00:00`), new Date(`${checkIn}T00:00:00`));
  return (
    <span className="adm-num">
      {checkIn} 至 {checkOut}
      {Number.isFinite(nights) && nights > 0 ? <span className="adm-muted">（{nights} 晚）</span> : null}
    </span>
  );
}
