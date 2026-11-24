import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/db/schema";
import { buildMetadata } from "@/lib/seo";
import { loadPage } from "./data";
import { PageHead } from "./PageHead";
import { Photo } from "./Photo";
import { RichText } from "./RichText";

/** messages key under `pages.*` with each content page's meta description. */
type DescriptionKey =
  | "facilitiesDescription"
  | "locationDescription"
  | "attractionsDescription"
  | "groupsDescription"
  | "privacyDescription"
  | "termsDescription";

/** Metadata for a content page: title from the database, description from messages. */
export async function contentPageMetadata(locale: Locale, slug: string, path: string, description: DescriptionKey): Promise<Metadata> {
  const page = await loadPage(slug, locale);
  if (!page) return {};
  const t = await getTranslations({ locale, namespace: "pages" });
  return buildMetadata({ locale, path, title: page.title, description: t(description), image: page.images[0] });
}

type Props = {
  locale: Locale;
  slug: string;
  /** Captions for photos by R2 key; photos without one get a numbered alt text. */
  captions?: Record<string, string>;
  /** Long legal pages read better in a single narrow column without photos. */
  plain?: boolean;
  /** Extra content under the photos (or after the text when `plain`). */
  aside?: ReactNode;
  children?: ReactNode;
  maxPhotos?: number;
};

/** A database content page: title, body text and the old site's photos for it. */
export async function ContentPage({ locale, slug, captions = {}, plain, aside, children, maxPhotos = 6 }: Props) {
  setRequestLocale(locale);
  const page = await loadPage(slug, locale);
  if (!page) notFound();
  const t = await getTranslations({ locale, namespace: "pages" });
  const photos = plain ? [] : page.images.slice(0, maxPhotos);

  return (
    <main id="main" className="wrap">
      <PageHead title={page.title} />
      <div className={plain ? "content-plain" : "content-layout"}>
        <RichText text={page.body} />
        {(photos.length > 0 || aside) && (
          <div className="content-aside">
            {aside}
            {photos.map((key, i) => (
              <figure key={key}>
                <Photo src={key} alt={captions[key] ?? t("photoAlt", { title: page.title, n: i + 1 })} width={800} height={500} />
                {captions[key] && <figcaption>{captions[key]}</figcaption>}
              </figure>
            ))}
          </div>
        )}
      </div>
      {children}
    </main>
  );
}
