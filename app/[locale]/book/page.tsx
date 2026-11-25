import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingDisabledNotice } from "@/components/booking/BookingDisabledNotice";
import { formatPrice, param, parseGuests, type SearchParams } from "@/components/booking/format";
import { BookingBar } from "@/components/layout/BookingBar";
import { INLINE_BOOKING_ID } from "@/components/site/BookingDock";
import { loadProperty, loadRoom } from "@/components/site/data";
import { PageHead } from "@/components/site/PageHead";
import { Photo } from "@/components/site/Photo";
import { Link } from "@/i18n/navigation";
import { defaultStay, nightsBetween } from "@/lib/booking-search";
import { photosOf } from "@/lib/content-repo";
import { searchAvailability, type RichOffer } from "@/lib/db/ari-repo";
import { getDb } from "@/lib/db/client";
import type { Locale } from "@/lib/db/schema";
import { bookingEnabled } from "@/lib/runtime/deps";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<SearchParams> };

/** Fewer rooms than this left shows "only N left". */
const SCARCE = 2;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "book" });
  return { ...buildMetadata({ locale, path: "/book", title: t("title"), description: t("description") }), robots: { index: false } };
}

export default async function BookPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = await searchParams;
  const [t, tb, tr] = await Promise.all([
    getTranslations({ locale, namespace: "book" }),
    getTranslations({ locale, namespace: "booking" }),
    getTranslations({ locale, namespace: "rooms" }),
  ]);

  const guests = parseGuests(q);
  const asked = { checkIn: param(q.checkIn), checkOut: param(q.checkOut) };
  const usingDefault = !asked.checkIn || !asked.checkOut;
  const stay = usingDefault ? defaultStay(new Date()) : asked;
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const wanted = param(q.room);

  if (!(await bookingEnabled())) {
    return (
      <main id="main" className="wrap book-page">
        <PageHead title={t("title")} />
        <BookingDisabledNotice locale={locale} />
      </main>
    );
  }

  const property = await loadProperty();
  const result = property
    ? await searchAvailability(await getDb(), { propertyId: property.id, ...stay, ...guests })
    : ({ ok: false, error: "PROPERTY_NOT_FOUND" } as const);

  const groups = new Map<string, RichOffer[]>();
  if (result.ok) for (const o of result.offers) groups.set(o.unitType.slug, [...(groups.get(o.unitType.slug) ?? []), o]);
  const ordered = [...groups.values()].sort((a, b) => Number(b[0].unitType.slug === wanted) - Number(a[0].unitType.slug === wanted));
  const wantedGone = wanted && result.ok && !groups.has(wanted);
  const guestLabel = tb("guestSummary", guests);

  const detailsHref = (o: RichOffer) => ({
    pathname: "/book/details" as const,
    query: { ...stay, ...Object.fromEntries(Object.entries(guests).map(([k, v]) => [k, String(v)])), room: o.unitType.slug, plan: o.ratePlan.slug },
  });

  return (
    <main id="main" className="wrap book-page">
      <PageHead title={t("title")} />
      <div id={INLINE_BOOKING_ID} className="book-search">
        <BookingBar initial={{ ...stay, ...guests }} />
      </div>
      {usingDefault && <p className="book-note">{t("defaultDates")}</p>}

      {!result.ok ? (
        <p className="book-message" role="alert">
          {result.error === "CHECKIN_IN_PAST" ? t("errorPast") : t("errorDates")}
        </p>
      ) : ordered.length === 0 ? (
        <div className="book-message">
          <p>{t("none", { guests: guestLabel })}</p>
          <Link className="text-link" href="/groups">
            {t("groupsLink")}
          </Link>
        </div>
      ) : (
        <>
          {wantedGone && (
            <p className="book-note" role="status">
              {t("roomGone", { room: (await loadRoom(wanted, locale))?.name ?? wanted })}
            </p>
          )}
          <ol className="offer-list">
            {ordered.map((offers) => {
              const u = offers[0].unitType;
              const name = u.name[locale];
              const image = photosOf(u)[0];
              return (
                <li key={u.slug} className="offer-room" aria-labelledby={`room-${u.slug}`}>
                  <div className="offer-photo">
                    {image && <Photo src={image} alt="" width={800} height={600} sizes="(max-width: 700px) 100vw, 360px" />}
                  </div>
                  <div className="offer-body">
                    {u.slug === wanted && <p className="offer-flag">{t("viewing")}</p>}
                    <h2 id={`room-${u.slug}`}>{name}</h2>
                    {name !== u.name.en && (
                      <p className="offer-en" lang="en">
                        {u.name.en}
                      </p>
                    )}
                    <p className="offer-facts">
                      <span>{tr("guestsValue", { count: u.maxOccupancy })}</span>
                      <Link href={`/rooms/${u.slug}`}>{t("roomDetails")}</Link>
                    </p>
                    <ul className="offer-plans" aria-label={t("plansFor", { room: name })}>
                      {offers.map((o) => (
                        <li key={o.ratePlan.slug} className="offer-plan">
                          <div className="plan-name">
                            <strong>{o.ratePlan.name[locale]}</strong>
                            <span>{o.ratePlan.includesBreakfast ? t("breakfast") : t("roomOnly")}</span>
                            {o.availableUnits <= SCARCE && <em className="scarce">{t("onlyLeft", { count: o.availableUnits })}</em>}
                          </div>
                          <div className="plan-price">
                            <span className="nightly">
                              {formatPrice(Math.round(o.roomSubtotal / nights))} <small>{t("perNight")}</small>
                            </span>
                            <span className="plan-total">
                              <small>{t("total", { nights, rooms: guests.rooms })}</small> {formatPrice(o.roomSubtotal * guests.rooms)}
                            </span>
                          </div>
                          <Link className="cta plan-select" href={detailsHref(o)} aria-label={`${t("select")}: ${name}, ${o.ratePlan.name[locale]}`}>
                            {t("select")}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </main>
  );
}

