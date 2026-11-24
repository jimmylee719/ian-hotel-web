import { roomImages } from "@/lib/content/old-site";
import type { Faq, Property, RoomDetail } from "@/lib/content-repo";
import type { I18n, Locale } from "@/lib/db/schema";
import { mediaUrl } from "@/lib/media";
import { localizedPath, SITE_URL } from "@/lib/seo";

/** schema.org structured data for the public site. Render with components/JsonLd. */

export const GEO = { latitude: 25.051499, longitude: 121.569652 };
export const MAP_URL = `https://www.google.com/maps/search/?api=1&query=${GEO.latitude},${GEO.longitude}`;
export const CHECK_IN_TIME = "15:00";
export const CHECK_OUT_TIME = "11:00";

/** The property's address split into PostalAddress parts (the DB keeps one line per locale). */
const ADDRESS: Record<Locale, { streetAddress: string; addressLocality: string; addressRegion: string }> = {
  "zh-TW": { streetAddress: "南京東路五段399號5樓", addressLocality: "松山區", addressRegion: "台北市" },
  en: { streetAddress: "5F, No. 399, Sec. 5, Nanjing E. Rd.", addressLocality: "Songshan District", addressRegion: "Taipei City" },
  ja: { streetAddress: "南京東路五段399號5樓", addressLocality: "松山區", addressRegion: "台北市" },
  ko: { streetAddress: "5F, No. 399, Sec. 5, Nanjing E. Rd.", addressLocality: "Songshan District", addressRegion: "Taipei City" },
};

/** Property-wide amenities, from the facilities page. */
const HOTEL_AMENITIES: I18n[] = [
  { "zh-TW": "免費 Wi-Fi", en: "Free Wi-Fi", ja: "無料 Wi-Fi", ko: "무료 Wi-Fi" },
  { "zh-TW": "24 小時櫃台", en: "24-hour front desk", ja: "24 時間フロント", ko: "24시간 프런트" },
  { "zh-TW": "共用廚房", en: "Shared kitchen", ja: "共用キッチン", ko: "공용 주방" },
  { "zh-TW": "自助洗衣房", en: "Self-service laundry", ja: "セルフランドリー", ko: "셀프 세탁실" },
  { "zh-TW": "露臺", en: "Terrace", ja: "テラス", ko: "테라스" },
  { "zh-TW": "全館禁菸", en: "Non-smoking rooms", ja: "全室禁煙", ko: "전 객실 금연" },
];

const abs = (path: string) => new URL(path, SITE_URL).toString();

export function hotelJsonLd(property: Property, locale: Locale): object {
  const images = ["deluxe-room", "classic-room", "mixed-cube"].map((s) => roomImages(s)[0]).filter(Boolean);
  return {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": abs("/#hotel"),
    name: property.name[locale],
    alternateName: property.name[locale === "en" ? "zh-TW" : "en"],
    url: abs(localizedPath(locale, "/")),
    telephone: property.phone,
    email: property.email,
    image: images.map((k) => abs(mediaUrl(k))),
    address: { "@type": "PostalAddress", ...ADDRESS[locale], postalCode: "105", addressCountry: "TW" },
    geo: { "@type": "GeoCoordinates", ...GEO },
    hasMap: MAP_URL,
    checkinTime: CHECK_IN_TIME,
    checkoutTime: CHECK_OUT_TIME,
    currenciesAccepted: property.currency,
    smokingAllowed: false,
    amenityFeature: HOTEL_AMENITIES.map((a) => ({ "@type": "LocationFeatureSpecification", name: a[locale], value: true })),
  };
}

export function roomJsonLd(room: RoomDetail, locale: Locale): object {
  return {
    "@context": "https://schema.org",
    "@type": "HotelRoom",
    name: room.name,
    description: room.summary || undefined,
    url: abs(localizedPath(locale, `/rooms/${room.slug}`)),
    image: room.images.map((k) => abs(mediaUrl(k))),
    bed: room.bedType || undefined,
    occupancy: { "@type": "QuantitativeValue", maxValue: room.maxOccupancy, unitCode: "C62" },
    ...(room.sizeSqm ? { floorSize: { "@type": "QuantitativeValue", value: room.sizeSqm, unitCode: "MTK" } } : {}),
    containedInPlace: { "@id": abs("/#hotel") },
    ...(room.fromPrice !== null
      ? {
          offers: {
            "@type": "Offer",
            price: room.fromPrice,
            priceCurrency: room.currency,
            availability: "https://schema.org/InStock",
            url: abs(`${localizedPath(locale, "/book")}?room=${room.slug}`),
          },
        }
      : {}),
  };
}

export function faqJsonLd(faqs: Faq[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };
}
