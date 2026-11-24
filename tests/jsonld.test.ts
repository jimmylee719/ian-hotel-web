import { beforeAll, describe, expect, test } from "vitest";
import { oldSiteContent } from "@/lib/content/old-site";
import { getProperty, getRoomType, listFaqs } from "@/lib/content-repo";
import { seedContent } from "@/lib/db/seed-content";
import { seedNk } from "@/lib/db/seed-nk";
import { faqJsonLd, hotelJsonLd, roomJsonLd } from "@/lib/jsonld";
import { createTestDb, type TestDb } from "./helpers/test-db";
import { fillAri } from "./helpers/ari";

const NOW = new Date("2026-12-01T04:00:00Z");

describe("JSON-LD", () => {
  let db: TestDb;
  let propertyId: string;
  beforeAll(async () => {
    db = createTestDb();
    ({ propertyId } = await seedNk(db));
    await seedContent(db, propertyId, oldSiteContent());
  });

  test("hotelJsonLd is a schema.org Hotel with a postal address, geo and times", async () => {
    const property = (await getProperty(db, "nk-hostel"))!;
    const ld = hotelJsonLd(property, "en") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Hotel");
    expect(ld.name).toBe("NK Hostel");
    expect(ld.address["@type"]).toBe("PostalAddress");
    expect(ld.address.streetAddress.trim()).not.toBe("");
    expect(ld.address.addressCountry).toBe("TW");
    expect(ld.geo).toMatchObject({ "@type": "GeoCoordinates", latitude: 25.051499, longitude: 121.569652 });
    expect(ld.telephone).toBe("+886 2 2769 0200");
    expect(ld.url).toMatch(/\/en$/);
    expect(ld.checkinTime).toBe("15:00");
    expect(ld.checkoutTime).toBe("11:00");
    expect(ld.image.length).toBeGreaterThan(0);
    expect(ld.amenityFeature[0]).toMatchObject({ "@type": "LocationFeatureSpecification", value: true });
  });

  test("roomJsonLd has no offers without ARI", async () => {
    const room = (await getRoomType(db, "nk-hostel", "deluxe-room", "en", NOW))!;
    const ld = roomJsonLd(room, "en") as Record<string, unknown>;
    expect(ld["@type"]).toBe("HotelRoom");
    expect(ld.name).toBe("DELUXE ROOM");
    expect(ld).not.toHaveProperty("offers");
  });

  test("roomJsonLd offers the lowest price of the next 7 days", async () => {
    await fillAri(db, propertyId, "2026-12-01", 7, { price: 2980 });
    const room = (await getRoomType(db, "nk-hostel", "deluxe-room", "ja", NOW))!;
    const ld = roomJsonLd(room, "ja") as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ld.offers).toMatchObject({ "@type": "Offer", price: 2980, priceCurrency: "TWD" });
    expect(ld.offers.url).toMatch(/\/ja\/book\?room=deluxe-room$/);
    expect(ld.occupancy).toMatchObject({ "@type": "QuantitativeValue", maxValue: 2 });
  });

  test("faqJsonLd is a FAQPage", async () => {
    const faqs = await listFaqs(db, "nk-hostel", "en");
    const ld = faqJsonLd(faqs) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(18);
    expect(ld.mainEntity[0]).toMatchObject({ "@type": "Question", acceptedAnswer: { "@type": "Answer" } });
  });
});
