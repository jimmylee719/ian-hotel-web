import { describe, expect, test } from "vitest";
import { pageText } from "@/content/localized/pages";
import { PAGE_SOURCES, REQUIRED_PAGES } from "@/lib/content/old-site";
import { englishLabels, splitIntro, splitSections } from "@/lib/content/sections";
import { LOCALES } from "@/lib/db/schema";
import { mailtoWithSubject } from "@/lib/mailto";
import { STATIC_PATHS } from "@/lib/sitemap";
import zh from "@/messages/zh-TW.json";

/** The brand and company layer (docs/superpowers/specs/2026-11-26-brand-company-layer-design.md). */
const BRAND_PAGES = ["about", "sustainability", "company", "partners"] as const;
const LAYOUT = { about: "chapters", sustainability: "chapters", company: "list", partners: "chapters" } as const;

describe("brand and company pages", () => {
  test("are required content pages, seeded without old-site photos", () => {
    for (const slug of BRAND_PAGES) {
      expect(REQUIRED_PAGES, slug).toContain(slug);
      expect(PAGE_SOURCES[slug], slug).toEqual([]);
    }
  });

  test("have a title, a one-line lead and the same headed sections in all four languages", () => {
    for (const slug of BRAND_PAGES) {
      const page = pageText[slug];
      const counts = LOCALES.map((l) => {
        expect(page.title[l].trim(), `${slug} ${l} title`).not.toBe("");
        const { lead, sections } = splitIntro(splitSections(page.body[l]));
        expect(lead, `${slug} ${l} lead`).not.toBeNull();
        expect(sections.every((s) => s.heading && s.body), `${slug} ${l} sections`).toBe(true);
        return sections.length;
      });
      expect(new Set(counts).size, slug).toBe(1);
      // Same count, so every non-English section gets its English label.
      const en = splitSections(page.body.en);
      for (const l of LOCALES) expect(englishLabels(splitSections(page.body[l]), en).filter(Boolean).length, `${slug} ${l}`).toBe(counts[0]);
      // The chapters layout is meant for 2 to 4 sections.
      if (LAYOUT[slug] === "chapters") expect(counts[0], slug).toBeGreaterThanOrEqual(2);
      if (LAYOUT[slug] === "chapters") expect(counts[0], slug).toBeLessThanOrEqual(4);
    }
  });

  test("company keeps the facilities page's guest restrictions on 8F and 14F", () => {
    const body = pageText.company.body["zh-TW"];
    expect(body).toContain("- 8 樓（限 8 樓住客）：交誼廳、吧台區、自助洗衣房");
    expect(body).toContain("- 14 樓：頂樓露臺與花園（限景緻與經典雙人套房住客）");
    for (const l of LOCALES) expect(pageText.company.body[l].match(/^- 14.*$/m)?.[0], l).toMatch(/[（(].+[）)]$/);
  });

  test("partners names the email once, in the mailto block, not in the body", () => {
    for (const l of LOCALES) expect(pageText.partners.body[l], l).not.toContain("@");
  });

  test("company lists exactly the agreed facts", () => {
    const headings = splitSections(pageText.company.body["zh-TW"]).flatMap((s) => (s.heading ? [s.heading] : []));
    expect(headings).toEqual(["品牌名稱", "地址", "電話", "Email", "櫃台服務", "入住／退房時間", "房型", "公共空間樓層"]);
  });

  test("carry no placeholders, exclamation marks or emoji (no invented or pending facts)", () => {
    for (const slug of BRAND_PAGES)
      for (const l of LOCALES) {
        const text = `${pageText[slug].title[l]}\n${pageText[slug].body[l]}`;
        expect(text, `${slug} ${l}`).not.toMatch(/XXX|待補|TBD|TODO|[!！]|\p{Extended_Pictographic}/u);
      }
  });

  test("give the existing front-desk address and no other", () => {
    for (const slug of BRAND_PAGES)
      for (const l of LOCALES) {
        const emails = pageText[slug].body[l].match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
        expect(emails.every((e) => e === "info@nkhostel.com"), `${slug} ${l}`).toBe(true);
      }
  });

  test("are in the sitemap", () => {
    for (const slug of BRAND_PAGES) expect(STATIC_PATHS).toContain(`/${slug}`);
  });
});

describe("partners enquiry link", () => {
  test("is a mailto to the existing address with the localized subject", () => {
    expect(zh.pages.partnersMailSubject).toBe("投資與合作洽詢");
    const href = mailtoWithSubject("info@nkhostel.com", zh.pages.partnersMailSubject);
    expect(href.startsWith("mailto:info@nkhostel.com?subject=")).toBe(true);
    expect(decodeURIComponent(href.split("subject=")[1])).toBe("投資與合作洽詢");
  });
});
