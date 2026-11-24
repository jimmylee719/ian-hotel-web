import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { loadNews } from "@/components/site/data";
import { JsonLd } from "@/components/site/JsonLd";
import { Photo } from "@/components/site/Photo";
import { RichText } from "@/components/site/RichText";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/db/schema";
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

  return (
    <main id="main" className="wrap news-item">
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
      <nav className="crumbs" aria-label={t("back")}>
        <Link href="/news">{t("back")}</Link>
      </nav>
      <article>
        <header className="page-head">
          {item.publishedAt && <time dateTime={date!.slice(0, 10)}>{format.dateTime(item.publishedAt, { dateStyle: "long" })}</time>}
          <h1>{item.title}</h1>
        </header>
        {item.images[0] && (
          <figure className="news-photo">
            <Photo src={item.images[0]} alt="" width={900} height={600} priority />
          </figure>
        )}
        <div className="content-plain">
          <RichText text={item.body} />
        </div>
      </article>
    </main>
  );
}
