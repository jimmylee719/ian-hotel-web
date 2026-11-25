import { describe, expect, it } from "vitest";
import { headerTheme } from "@/lib/design/header-theme";

describe("headerTheme", () => {
  it("is ink on the home page and content pages", () => {
    for (const p of ["/", "/rooms", "/rooms/deluxe-room", "/faq", "/news/news-281"]) {
      expect(headerTheme(p), p).toBe("ink");
    }
  });

  it("is paper on the booking and manage flows", () => {
    for (const p of ["/book", "/book/details", "/book/return", "/manage", "/manage/NK-ABC123"]) {
      expect(headerTheme(p), p).toBe("paper");
    }
  });

  it("matches whole path segments only", () => {
    expect(headerTheme("/booking-terms")).toBe("ink");
    expect(headerTheme("/manager")).toBe("ink");
  });
});
