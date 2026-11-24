import { describe, expect, test } from "vitest";
import { buildMetadata, SITE_URL } from "@/lib/seo";

describe("buildMetadata", () => {
  const meta = buildMetadata({ locale: "ja", path: "/rooms", title: "客室", description: "客室一覧" });

  test("hreflang alternates cover all four locales plus x-default (zh-TW)", () => {
    const langs = meta.alternates?.languages as Record<string, string>;
    expect(Object.keys(langs).sort()).toEqual(["en", "ja", "ko", "x-default", "zh-TW"].sort());
    expect(langs["en"]).toBe("/en/rooms");
    expect(langs["ko"]).toBe("/ko/rooms");
    expect(langs["x-default"]).toBe("/zh-TW/rooms");
  });

  test("canonical is the locale-prefixed path", () => {
    expect(meta.alternates?.canonical).toBe("/ja/rooms");
  });

  test("root path has no trailing slash", () => {
    const home = buildMetadata({ locale: "en", path: "/", title: "Home", description: "d" });
    expect(home.alternates?.canonical).toBe("/en");
    expect((home.alternates?.languages as Record<string, string>)["x-default"]).toBe("/zh-TW");
  });

  test("openGraph and twitter carry title, description, locale and image", () => {
    const m = buildMetadata({ locale: "ko", path: "/rooms", title: "객실", description: "설명", image: "rooms/rooms_4.jpg" });
    expect(m.metadataBase?.toString()).toBe(`${SITE_URL}/`);
    expect(m.openGraph).toMatchObject({ title: "객실", description: "설명", url: "/ko/rooms", locale: "ko_KR", type: "website" });
    expect(JSON.stringify(m.openGraph)).toContain("/media/rooms/rooms_4.jpg");
    expect(m.twitter).toMatchObject({ card: "summary_large_image", title: "객실", description: "설명" });
  });
});
