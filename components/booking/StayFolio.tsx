import { useLocale, useTranslations } from "next-intl";
import { formatDate } from "./format";

/**
 * The stay at a glance, set like the folio a front desk hands you: arrival and departure in large
 * type with the nights between, then the room, rate and guests.
 */
export function StayFolio(p: {
  /** ISO dates. */
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  childCount: number;
  rooms: number;
  roomName: string;
  planName?: string;
  code?: string;
}) {
  const t = useTranslations("booking");
  const s = useTranslations("bookingStatus");
  const locale = useLocale();
  const day = (iso: string, label: string) => (
    <div>
      <small>{label}</small>
      <strong>{formatDate(iso, locale, { month: "short", day: "numeric" })}</strong>
      <small>{formatDate(iso, locale, { weekday: "long" })}</small>
    </div>
  );
  return (
    <div className="folio">
      {p.code && (
        <p className="folio-code">
          <span>{s("code")}</span> <strong>{p.code}</strong>
        </p>
      )}
      <div className="folio-dates">
        {day(p.checkIn, t("checkIn"))}
        <span className="folio-nights">{t("nights", { count: p.nights })}</span>
        {day(p.checkOut, t("checkOut"))}
      </div>
      <p className="folio-room">{p.roomName}</p>
      {p.planName && <p className="folio-plan">{p.planName}</p>}
      {p.adults > 0 && <p className="folio-guests">{t("guestSummary", { adults: p.adults, children: p.childCount, rooms: p.rooms })}</p>}
    </div>
  );
}
