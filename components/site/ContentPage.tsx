import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { assignPhotos, englishLabels, floorOf, listPhotos, photosByFloor, splitIntro, splitPhotos, splitSections } from "@/lib/content/sections";
import type { Locale } from "@/lib/db/schema";
import { buildMetadata } from "@/lib/seo";
import { loadPage } from "./data";
import { PageHead } from "./PageHead";
import { RichText } from "./RichText";
import { Band } from "./sections/Band";
import { Chapter } from "./sections/Chapter";
import { PhotoGrid3 } from "./sections/PhotoGrid3";
import { PhotoSplit } from "./sections/PhotoSplit";
import { Reveal } from "./sections/Reveal";

/** messages key under `pages.*` with each content page's meta description. */
type DescriptionKey =
  | "facilitiesDescription"
  | "locationDescription"
  | "attractionsDescription"
  | "groupsDescription"
  | "privacyDescription"
  | "termsDescription"
  | "aboutDescription"
  | "sustainabilityDescription"
  | "companyDescription"
  | "partnersDescription";

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
  /** Long legal pages: an ink head and a paper reading column, no photos. */
  plain?: boolean;
  /** Extra content beside the photos (list layout), or after the text when `plain`. */
  aside?: ReactNode;
  children?: ReactNode;
  /** Chapters layout: how many of the page's photos are distributed across the chapters. */
  maxPhotos?: number;
  /**
   * `chapters`: one numbered chapter per `## ` section, alternating paper and ink, each with up to two photos (pages
   * with 2–4 sections). `list` (default): one unnumbered chapter whose sections form a two-column list under a grid3.
   */
  layout?: "chapters" | "list";
  /** Chapters layout: each photo's floor; a chapter then gets the photos of the floor its English heading names. */
  photoFloors?: Record<string, number | null>;
  /** Chapters layout: extra content after the text of chapter i (by index), e.g. a link or a contact block. */
  chapterExtras?: ReactNode[];
};

/** A database content page laid out from its `## ` sections (spec §5.3): ink head, then chapters or a list. */
export async function ContentPage({ locale, slug, captions = {}, plain, aside, children, maxPhotos = 6, layout = "list", photoFloors, chapterExtras = [] }: Props) {
  setRequestLocale(locale);
  const [page, enPage] = await Promise.all([loadPage(slug, locale), plain || locale === "en" ? null : loadPage(slug, "en")]);
  if (!page) notFound();
  const t = await getTranslations({ locale, namespace: "pages" });

  if (plain) {
    return (
      <main id="main" className="wrap content-page">
        <PageHead title={page.title} />
        <div className="reading">
          <RichText text={page.body} />
          {aside}
        </div>
        {children}
      </main>
    );
  }

  const { lead, intro, sections } = splitIntro(splitSections(page.body));
  // On the English site the label would only repeat the heading.
  const enHeadings = enPage ? englishLabels(sections, splitSections(enPage.body)) : sections.map((s) => s.heading);
  const label = (i: number) => (enHeadings[i] && enHeadings[i] !== sections[i].heading ? enHeadings[i]! : undefined);
  const alt = (key: string) => captions[key] ?? t("photoAlt", { title: page.title, n: page.images.indexOf(key) + 1 });

  if (layout === "chapters") {
    const photos = page.images.slice(0, maxPhotos);
    const groups = photoFloors
      ? photosByFloor(
          photos,
          enHeadings.map((h) => (h === null ? null : floorOf(h))),
          photoFloors,
        )
      : assignPhotos(photos, sections.length);
    return (
      <main id="main" className="wrap content-page">
        <PageHead title={page.title} lead={lead ?? undefined} />
        {intro && (
          <Band theme="paper">
            <div className="content-intro">
              <RichText text={intro} />
            </div>
          </Band>
        )}
        {sections.map((s, i) => {
          const pick = splitPhotos(groups[i]);
          const text = (
            <>
              <RichText text={s.body} />
              {chapterExtras[i]}
            </>
          );
          return (
            <Band key={i} theme={i % 2 === 0 ? "paper" : "ink"}>
              <Chapter num={i + 1} title={s.heading ?? page.title} en={label(i)}>
                {pick ? (
                  <Reveal>
                    <PhotoSplit
                      large={{ src: pick.large, alt: alt(pick.large) }}
                      small={pick.small ? { src: pick.small, alt: alt(pick.small) } : undefined}
                      priority={i === 0}
                    >
                      {text}
                    </PhotoSplit>
                  </Reveal>
                ) : (
                  text
                )}
              </Chapter>
            </Band>
          );
        })}
        {children}
      </main>
    );
  }

  const photos = listPhotos(page.images);
  return (
    <main id="main" className="wrap content-page">
      <PageHead title={page.title} lead={lead ?? undefined} />
      <Band theme="paper">
        <Chapter title={page.title}>
          {intro && (
            <div className="content-intro">
              <RichText text={intro} />
            </div>
          )}
          {photos ? (
            <Reveal>
              <PhotoGrid3
                lead={{ src: photos.lead, alt: alt(photos.lead) }}
                items={photos.items.map((k) => ({ src: k, alt: captions[k] ? "" : alt(k), caption: captions[k] }))}
                priority
              >
                {aside}
              </PhotoGrid3>
            </Reveal>
          ) : (
            aside
          )}
          <div className="section-list">
            {sections.map((s, i) => (
              <section className="section-item" key={i}>
                <div className="section-item-head">
                  <h3>{s.heading}</h3>
                  {label(i) && (
                    <p className="chapter-en" lang="en">
                      {label(i)}
                    </p>
                  )}
                </div>
                <RichText text={s.body} />
              </section>
            ))}
          </div>
        </Chapter>
      </Band>
      {children}
    </main>
  );
}
