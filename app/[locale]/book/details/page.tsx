import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookingDisabledNotice } from "@/components/booking/BookingDisabledNotice";
import { BookingForm } from "@/components/booking/BookingForm";
import { param, parseGuests, type SearchParams } from "@/components/booking/format";
import { PROPERTY_SLUG } from "@/components/site/data";
import { PageHead } from "@/components/site/PageHead";
import { Link } from "@/i18n/navigation";
import { cancellationText } from "@/lib/booking/notify";
import { priceStay } from "@/lib/booking/pricing";
import { getDb } from "@/lib/db/client";
import { addons, type Locale } from "@/lib/db/schema";
import { isTestSite } from "@/lib/runtime/env";
import { buildMetadata } from "@/lib/seo";
import { bookingEnabled, requestEnv } from "@/lib/runtime/request-env";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "checkout" });
  return { ...buildMetadata({ locale, path: "/book/details", title: t("title"), description: t("title") }), robots: { index: false } };
}

export default async function DetailsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const q = await searchParams;
  const t = await getTranslations({ locale, namespace: "checkout" });

  if (!(await bookingEnabled())) {
    return (
      <main id="main" className="wrap book-page">
        <PageHead title={t("title")} theme="paper" />
        <BookingDisabledNotice locale={locale} />
      </main>
    );
  }

  const guests = parseGuests(q);
  const stay = { checkIn: param(q.checkIn), checkOut: param(q.checkOut) };
  const backQuery = { ...stay, ...Object.fromEntries(Object.entries(guests).map(([k, v]) => [k, String(v)])), room: param(q.room) };
  const input = {
    propertySlug: PROPERTY_SLUG, ...stay, ...guests,
    unitTypeSlug: param(q.room), ratePlanSlug: param(q.plan), addons: [],
  };

  const db = await getDb();
  const priced = input.unitTypeSlug && input.ratePlanSlug ? await priceStay(db, input, new Date()) : null;
  if (!priced?.ok) {
    return (
      <main id="main" className="wrap book-page">
        <PageHead title={t("title")} theme="paper" />
        <div className="book-message" role="alert">
          <p>{t("gone")}</p>
          <Link className="text-link" href={{ pathname: "/book", query: backQuery }}>
            {t("goneAction")}
          </Link>
        </div>
      </main>
    );
  }
  const { offer, quote, propertyId } = priced.priced;
  const testNote = isTestSite(await requestEnv()) ? (await getTranslations({ locale, namespace: "testMode" }))("note") : undefined;
  const extras = await db.select().from(addons).where(and(eq(addons.propertyId, propertyId), eq(addons.active, true)));

  return (
    <main id="main" className="wrap book-page">
      <PageHead title={t("title")} theme="paper">
        <Link className="crumb-back" href={{ pathname: "/book", query: backQuery }}>
          {t("back")}
        </Link>
      </PageHead>
      <BookingForm
        stay={{
          propertySlug: PROPERTY_SLUG, ...stay, ...guests,
          unitTypeSlug: offer.unitType.slug, ratePlanSlug: offer.ratePlan.slug,
          roomName: offer.unitType.name[locale], planName: offer.ratePlan.name[locale],
          includesBreakfast: offer.ratePlan.includesBreakfast,
        }}
        addons={extras.map((a) => ({ id: a.id, slug: a.slug, name: a.name[locale], price: a.price, unit: a.unit }))}
        initialQuote={quote}
        policyText={cancellationText(offer.ratePlan.cancelPolicy, locale)}
        testNote={testNote}
      />
    </main>
  );
}
