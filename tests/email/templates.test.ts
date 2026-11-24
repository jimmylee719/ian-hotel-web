import { describe, expect, it } from "vitest";
import { LOCALES, type NotificationKind } from "@/lib/db/schema";
import { renderEmail, type EmailData } from "@/lib/email/templates";
import { MockEmailSender } from "@/lib/email/mock";

const data: EmailData = {
  hotelName: "Ian Hotel", code: "NK-1234", checkIn: "2026-12-01", checkOut: "2026-12-03",
  roomTypeName: "Deluxe Double", rooms: 1, nights: 2,
  roomSubtotal: 4400, addonSubtotal: 760, discount: 200, total: 4960, paid: 4960,
  cancellationText: "Free cancellation until 2026-11-28.",
  hotelPhone: "+886-2-1234-5678", hotelEmail: "hi@ian.test", hotelAddress: "1 Test Rd, Taipei",
  manageUrl: "https://hotel.test/en/booking/NK-1234", refundAmount: 4960,
};
const customerKinds: NotificationKind[] = ["booking_confirmed", "booking_failed_refunded", "cancelled", "pre_arrival"];

describe("renderEmail", () => {
  it("ja booking_confirmed has the code in the subject and formatted total in html", () => {
    const m = renderEmail("booking_confirmed", "ja", data);
    expect(m.subject).toContain("NK-1234");
    expect(m.html).toContain("NT$4,960");
    expect(m.text).toContain("NT$4,960");
    expect(m.html).toContain(data.manageUrl);
  });

  for (const kind of customerKinds) {
    it(`${kind}: every locale has a non-empty, distinct subject and body`, () => {
      const subjects = LOCALES.map((l) => renderEmail(kind, l, data).subject);
      expect(subjects.every((s) => s.length > 0)).toBe(true);
      expect(new Set(subjects).size).toBe(LOCALES.length);
      for (const l of LOCALES) {
        const m = renderEmail(kind, l, data);
        expect(m.html.length).toBeGreaterThan(50);
        expect(m.text.length).toBeGreaterThan(20);
      }
    });
  }

  it("shows the refund amount on refund-bearing emails", () => {
    expect(renderEmail("cancelled", "en", data).html).toContain("NT$4,960");
    expect(renderEmail("booking_failed_refunded", "ko", data).text).toContain("NT$4,960");
  });

  it("escapes html in user-supplied fields", () => {
    const m = renderEmail("booking_confirmed", "en", { ...data, roomTypeName: "<script>x</script>" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });

  it("renders staff kinds", () => {
    for (const k of ["staff_new_booking", "staff_sync_failed", "staff_payment_alert"] as const) {
      const m = renderEmail(k, "zh-TW", data);
      expect(m.subject).toContain("NK-1234");
      expect(m.html.length).toBeGreaterThan(0);
    }
  });
});

describe("MockEmailSender", () => {
  it("records sent mail", async () => {
    const s = new MockEmailSender();
    const r = await s.send({ to: "a@b.c", subject: "s", html: "h", text: "t" });
    expect(r.ok).toBe(true);
    expect(s.sent).toHaveLength(1);
  });
});
