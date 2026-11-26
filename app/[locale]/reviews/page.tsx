import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHead } from "@/components/site/PageHead";
import { Photo } from "@/components/site/Photo";
import { RatingsStrip } from "@/components/site/sections/RatingsStrip";
import { AWARDS } from "@/lib/content/reviews";
import type { Locale } from "@/lib/db/schema";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "reviews" });
  return buildMetadata({ locale, path: "/reviews", title: t("title"), description: t("description"), image: "review/review_374.jpg" });
}

export default async function ReviewsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "reviews" });
  const ratings = AWARDS.flatMap((a) =>
    a.score !== null && a.scale !== null ? [{ platform: a.platform, score: String(a.score), scale: String(a.scale) }] : [],
  );

  return (
    <main id="main" className="wrap content-page reviews-page">
      <PageHead title={t("title")} lead={t("intro")} />
      <RatingsStrip awards={ratings} />
      <ul className="award-list">
        {AWARDS.map((a) => (
          <li key={a.platform}>
            <div className="award-text">
              <h2 lang="en">{a.platform}</h2>
              <p className="award-name">{[a.year, a.award ? t(a.award) : a.score !== null ? t("guestRating") : null].filter(Boolean).join(" ")}</p>
            </div>
            <Photo src={a.image} alt={t("badgeAlt", { platform: a.platform })} width={410} height={195} className="award-badge" />
          </li>
        ))}
      </ul>
      <p className="faq-contact">{t("leaveReview")}</p>
    </main>
  );
}
