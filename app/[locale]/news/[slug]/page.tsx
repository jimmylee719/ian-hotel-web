import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { loadNews } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { PageHead } from "@/components/site/PageHead";
import { RichText } from "@/components/site/RichText";
import { Frame } from "@/components/site/sections/Frame";
import { Link } from "@/i18n/navigation";
import { READING_PHOTO } from "@/lib/content/sections";
import type { Locale } from "@/lib/db/schema";
import { pickFitting } from "@/lib/design/photo-fit";
import { mediaUrl } from "@/lib/media";
import { buildMetadata, localizedPath, SITE_URL } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale; slug: string }> };

const summary = (body: string) => (body.split("\n").find((l) => l.trim() && !l.startsWith("## ")) ?? "").slice(0, 160);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const item = await loadNews(slug, locale);
  if (!item) return {};
  return buildMetadata({ locale, path: `/news/${slug}`, title: item.title, description: summary(item.body), image: item.images[0] });
}

export default async function NewsItemPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const item = await loadNews(slug, locale);
  if (!item) notFound();
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: "news" }), getFormatter({ locale })]);
  const date = item.publishedAt ? new Date(item.publishedAt).toISOString() : undefined;
  const photo = pickFitting(item.images, READING_PHOTO);

  return (
    <main id="main" className="wrap content-page news-item">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "NewsArticle",
          headline: item.title,
          datePublished: date,
          image: item.images.map((k) => new URL(mediaUrl(k), SITE_URL).toString()),
          url: new URL(localizedPath(locale, `/news/${slug}`), SITE_URL).toString(),
          publisher: { "@id": new URL("/#hotel", SITE_URL).toString() },
        }}
      />
      <article>
        <PageHead title={item.title}>
          {item.publishedAt && <time dateTime={date!.slice(0, 10)}>{format.dateTime(item.publishedAt, { dateStyle: "long" })}</time>}
        </PageHead>
        <div className="reading">
          <nav className="crumbs" aria-label={t("back")}>
            <Link href="/news">{t("back")}</Link>
          </nav>
          {photo && (
            <Frame
              className="reading-photo"
              src={photo}
              alt=""
              slotWidth={READING_PHOTO.w}
              cap={READING_PHOTO.h}
              sizes="(max-width: 700px) calc(100vw - 40px), 420px"
              priority
            />
          )}
          <RichText text={item.body} />
        </div>
      </article>
    </main>
  );
}
