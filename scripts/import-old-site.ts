/**
 * One-off content migration from the old site (https://www.nkhostel.com, zh-TW + /en/).
 *
 *   npx tsx scripts/import-old-site.ts            # scrape, download images, upload them to local R2
 *   npx tsx scripts/import-old-site.ts --no-upload
 *
 * Output: content/old-site.json and content/images/<key>. Both are committed: they are the content
 * source for lib/db/seed-content.ts. Fetched HTML is treated strictly as data: we only read text and
 * image URLs out of it, never follow or execute anything it says.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import type { Bilingual, OldSiteScrape } from "../lib/content/types";

const ORIGIN = "https://www.nkhostel.com";
const OUT_JSON = path.resolve("content/old-site.json");
const OUT_IMAGES = path.resolve("content/images");
const MAX_ROOM_IMAGES = 8;

/** Old-site room id -> our unit_types slug (matched by name: 男.女混合雙人旅艙 = MIXED CUBE, ...). */
export const ROOM_IDS: Record<number, string> = {
  15: "mixed-cube",
  23: "female-cube",
  22: "buddy-room",
  20: "buddy-room-six",
  19: "mini-room",
  18: "classic-room",
  17: "deluxe-room",
  291: "connecting-room",
};

/** Old-site amenity icon file -> amenity key (labels: messages `amenities.<key>`). */
export const AMENITY_ICONS: Record<string, string> = {
  "icon-1": "wifi",
  "icon-2": "usbAdapter",
  "icon-3": "towel",
  "icon-4": "outlet110v",
  "icon-5": "hanger",
  "icon-7": "bedsideLamp",
  "icon-8": "bedsideTable",
  "icon-9": "toiletries",
  "icon-10": "airCon",
  "icon-11": "keyCard",
  "icon-12": "slippers",
  "icon-13": "bathTowel",
  "icon-14": "hairDryer",
  "icon-15": "eLocker",
  "icon-16": "vanityMirror",
  "icon-18": "cookware",
  "icon-19": "tableware",
  "icon-20": "teaBags",
  "icon-21": "loveseat",
  "icon-22": "fullLengthMirror",
  "icon-23": "kettle",
  "icon-24": "safe",
  "icon-25": "bathtub",
  "icon-26": "miniFridge",
  "icon-28": "tv",
  "icon-29": "splitAirCon",
  "icon-30": "washlet",
  "icon-31": "cup",
  "icon-38": "plugAdapter",
  "icon-39": "desk",
  "icon-40": "sharedBathroom",
  "icon-41": "iron",
  "icon-42": "dressingRoom",
};

const PAGES: { slug: string; oldPath: string }[] = [
  { slug: "home", oldPath: "main.php" },
  { slug: "facilities", oldPath: "amenities.php" },
  { slug: "access", oldPath: "location.php" },
  { slug: "attractions", oldPath: "attractions.php" },
  { slug: "groups", oldPath: "group.php" },
  { slug: "long-stay", oldPath: "group2.php" },
  { slug: "reviews", oldPath: "review.php" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "nk-content-migration/1.0" } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function page(lang: "zh-TW" | "en", p: string): Promise<HTMLElement> {
  const url = `${ORIGIN}/${lang === "en" ? "en/" : ""}${p}`;
  const html = await fetchText(url);
  await sleep(300);
  return parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false } });
}

/** Block-aware text: <br>, <p>, <li>, <div> become line breaks; whitespace collapsed. */
export function toText(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  const html = el.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6]|ul|section|tr)>/gi, "\n");
  const text = parse(html).textContent;
  return tidy(decode(text));
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function tidy(s: string): string {
  const lines = s.split("\n").map((l) => l.replace(/[ \t　]+/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    if (l !== "" && out.includes(l) && l.length < 40) continue; // repeated headings / nav duplicates
    out.push(l);
  }
  return out.join("\n").trim();
}

/** upload_image/... URLs from <img src> and inline background: url(...). */
function imagesIn(el: HTMLElement): string[] {
  const html = el.outerHTML;
  const found = [...html.matchAll(/upload_image\/([A-Za-z0-9_\-/]+\.(?:jpe?g|png|webp))/gi)].map((m) => m[1]);
  return [...new Set(found)].filter((k) => !k.endsWith(".png") || !k.startsWith("rooms/")); // room PNGs are nav icons
}

/** Main content of a generic page: everything except header/nav/footer chrome. */
function mainOf(doc: HTMLElement): HTMLElement {
  const body = doc.querySelector("body") ?? doc;
  for (const sel of ["header", "footer", ".menuIntro", ".menutext", "script", "style", "noscript", ".show-for-small-only", "[class*='mobile-']"])
    body.querySelectorAll(sel).forEach((n) => n.remove());
  return body;
}

function bi(zh: string, en: string): Bilingual {
  return { "zh-TW": zh, en };
}

async function scrapeRoom(oldId: number) {
  const [zh, en] = await Promise.all([page("zh-TW", `rooms.php?id=${oldId}`), page("en", `rooms.php?id=${oldId}`)]);
  const pick = (d: HTMLElement, sel: string) => toText(d.querySelector(sel));
  const name = (d: HTMLElement) => d.querySelector(".roomsClass .current .ch")?.text.trim() ?? "";
  const nameEn = (d: HTMLElement) => d.querySelector(".roomsClass .current .en")?.text.trim() ?? "";
  const amenities = zh
    .querySelectorAll(".roomsIcon .icon img")
    .map((i) => /svg\/(icon-\d+)\.svg/.exec(i.getAttribute("src") ?? "")?.[1])
    .filter((k): k is string => !!k)
    .map((k) => AMENITY_ICONS[k] ?? k);
  const main = zh.querySelector("#rooms-slider .image img")?.getAttribute("src") ?? "";
  const sliderImages = imagesIn(zh.querySelector("body")!).filter((k) => k.startsWith("rooms/"));
  const mainKey = /upload_image\/(.+)$/.exec(main)?.[1];
  const images = [...new Set([...(mainKey ? [mainKey] : []), ...sliderImages])].slice(0, MAX_ROOM_IMAGES);
  return {
    oldId,
    slug: ROOM_IDS[oldId],
    name: bi(name(zh), nameEn(en) || nameEn(zh)),
    description: bi(pick(zh, ".roomsContent2"), pick(en, ".roomsContent2")),
    notes: bi(pick(zh, ".roomsContent3 .roomsb-content"), pick(en, ".roomsContent3 .roomsb-content")),
    priceRange: zh.querySelector(".roomsPerson .price span.price")?.text.trim() ?? "",
    occupancy: zh.querySelector(".roomsPerson .person")?.text.trim() ?? "",
    amenities: [...new Set(amenities)],
    images,
  };
}

async function scrapeFaqs() {
  const [zh, en] = await Promise.all([page("zh-TW", "qa.php"), page("en", "qa.php")]);
  const blocks = (d: HTMLElement) =>
    d.querySelectorAll("[id^='qa-']").map((sec) => ({
      id: sec.id,
      category: sec.querySelector(".big_title h1")?.text.trim() ?? "",
      items: sec.querySelectorAll("ul").map((ul) => ({
        q: tidy(decode(ul.querySelector(".title")?.text ?? "")).replace(/^Q\d+\s*[.．、]\s*/i, ""),
        a: toText(ul.querySelector("li")),
      })),
    }));
  const zb = blocks(zh);
  const eb = blocks(en);
  const out: OldSiteScrape["faqs"] = [];
  for (const z of zb) {
    const e = eb.find((b) => b.id === z.id);
    z.items.forEach((item, i) => {
      if (!item.q) return;
      const ei = e?.items[i];
      out.push({
        slug: `${z.id}-${i + 1}`,
        category: bi(z.category, e?.category ?? ""),
        question: bi(item.q, ei?.q ?? ""),
        answer: bi(item.a, ei?.a ?? ""),
      });
    });
  }
  return out;
}

async function scrapePage(p: { slug: string; oldPath: string }) {
  const [zh, en] = await Promise.all([page("zh-TW", p.oldPath), page("en", p.oldPath)]);
  const title = (d: HTMLElement) => (d.querySelector("title")?.text ?? "").split(/[|｜]/)[0].trim();
  const zm = mainOf(zh);
  const em = mainOf(en);
  return { slug: p.slug, oldPath: p.oldPath, title: bi(title(zh), title(en)), body: bi(toText(zm), toText(em)), images: imagesIn(zm) };
}

async function scrapeNews(limit = 6) {
  const list = await page("zh-TW", "news.php");
  const ids = [...new Set(list.querySelectorAll("a[href^='news_detail.php?id=']").map((a) => Number(/id=(\d+)/.exec(a.getAttribute("href")!)![1])))].slice(0, limit);
  const out: OldSiteScrape["news"] = [];
  for (const id of ids) {
    const [zh, en] = await Promise.all([page("zh-TW", `news_detail.php?id=${id}`), page("en", `news_detail.php?id=${id}`).catch(() => null)]);
    const zm = mainOf(zh);
    const split = (text: string) => {
      // Body text starts "2024.12.28\n\n<title>\n\n<body>".
      const [dateLine = "", , title = "", ...rest] = text.split("\n");
      return { dateLine, title: title.trim(), body: rest.join("\n").trim() };
    };
    const z = split(toText(zm));
    const e = en ? split(toText(mainOf(en))) : { title: "", body: "" };
    const date = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(z.dateLine.trim());
    if (!date || date[1] === "1970" || !z.title) continue; // empty placeholder entries
    out.push({
      slug: `news-${id}`,
      oldId: id,
      date: `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`,
      title: bi(z.title, e.title),
      body: bi(z.body, e.body),
      images: imagesIn(zm),
    });
  }
  return out;
}

async function download(key: string) {
  const file = path.join(OUT_IMAGES, key);
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(`${ORIGIN}/upload_image/${key}`);
  if (!res.ok) throw new Error(`image ${res.status} ${key}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  await sleep(150);
}

function uploadLocal(key: string) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `nk-media/${key}`, "--file", path.join(OUT_IMAGES, key), "--local"], { stdio: "ignore" });
}

async function main() {
  const rooms = [];
  for (const id of Object.keys(ROOM_IDS).map(Number)) rooms.push(await scrapeRoom(id));
  const pages = [];
  for (const p of PAGES) pages.push(await scrapePage(p));
  const faqs = await scrapeFaqs();
  const news = await scrapeNews();

  const data: OldSiteScrape = { source: ORIGIN, scrapedAt: new Date().toISOString(), rooms, pages, faqs, news };
  const keys = [...new Set([...rooms, ...pages, ...news].flatMap((x) => x.images))];
  for (const k of keys) await download(k);

  mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(data, null, 2) + "\n");
  console.log(`rooms ${rooms.length}, pages ${pages.length}, faqs ${faqs.length}, news ${news.length}, images ${keys.length}`);
  for (const r of rooms) console.log(`  ${r.slug}: ${r.images.length} images, description ${r.description["zh-TW"].length}/${r.description.en.length} chars`);

  if (!process.argv.includes("--no-upload")) {
    for (const k of keys) uploadLocal(k);
    console.log(`uploaded ${keys.length} objects to local R2 bucket nk-media`);
  }
}

if (process.argv[1]?.endsWith("import-old-site.ts")) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
