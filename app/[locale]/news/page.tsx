import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { loadNewsList } from "@/components/site/data";
import { PageHead } from "@/components/site/PageHead";
import { Photo } from "@/components/site/Photo";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/lib/db/schema";
import { buildMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "news" });
  return buildMetadata({ locale, path: "/news", title: t("title"), description: t("description") });
}

export default async function NewsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, format, items] = await Promise.all([getTranslations({ locale, namespace: "news" }), getFormatter({ locale }), loadNewsList(locale)]);

  return (
    <main id="main" className="wrap">
      <PageHead title={t("title")} />
      {items.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <ol className="news-list">
          {items.map((n) => (
            <li key={n.slug}>
              <article>
                {n.images[0] && <Photo src={n.images[0]} alt="" width={600} height={400} />}
                <div>
                  {n.publishedAt && (
                    <time dateTime={new Date(n.publishedAt).toISOString().slice(0, 10)}>{format.dateTime(n.publishedAt, { dateStyle: "long" })}</time>
                  )}
                  <h2>
                    <Link href={`/news/${n.slug}`}>{n.title}</Link>
                  </h2>
                  <p>{n.body.split("\n").find((l) => l.trim() && !l.startsWith("## "))}</p>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
