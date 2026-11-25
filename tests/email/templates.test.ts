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
const customerKinds: NotificationKind[] = ["booking_confirmed", "booking_failed_refunded", "payment_refunded", "cancelled", "pre_arrival", "booking_modified"];

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
    expect(renderEmail("payment_refunded", "ja", data).text).toContain("NT$4,960");
  });

  it("booking_modified shows the new stay, the difference and how it is settled, in every locale", () => {
    const higher = { difference: 2000, refunded: 0, frontDeskRefundDue: 0, balanceDue: 2500 };
    const lower = { difference: -3000, refunded: 2000, frontDeskRefundDue: 1000, balanceDue: 0 };
    for (const l of LOCALES) {
      const up = renderEmail("booking_modified", l, { ...data, modification: higher }).text;
      expect(up).toContain("2026-12-01 → 2026-12-03");
      expect(up).toContain("NT$4,960"); // the new total
      expect(up).toContain("NT$2,000");
      expect(up).toContain("NT$2,500"); // the balance due at the desk
      const down = renderEmail("booking_modified", l, { ...data, modification: lower }).text;
      expect(down).toContain("-NT$3,000");
      expect(down).toContain("NT$2,000"); // refunded online
      expect(down).toContain("NT$1,000"); // at the front desk
      const same = renderEmail("booking_modified", l, { ...data, modification: { ...higher, difference: 0, balanceDue: 0 } }).text;
      expect(same).toContain("NT$0");
    }
    expect(renderEmail("booking_modified", "en", { ...data, modification: lower }).text)
      .toContain("NT$2,000 will be refunded to your original payment method; NT$1,000 will be returned to you at the front desk.");
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

  it("pre_arrival tells the guest how to get there, the check-in time and how to reach the hotel, in every locale", () => {
    const expected = { "zh-TW": "捷運南京三民站", en: "Nanjing Sanmin MRT", ja: "南京三民駅", ko: "난징싼민역" } as const;
    for (const l of LOCALES) {
      const m = renderEmail("pre_arrival", l, data);
      for (const out of [m.text, m.html]) {
        expect(out).toContain(expected[l]);
        expect(out).toContain("15:00");
        expect(out).toContain(data.hotelPhone);
        expect(out).toContain(data.hotelEmail);
      }
    }
    expect(renderEmail("booking_confirmed", "en", data).text).not.toContain("Nanjing Sanmin MRT");
  });
});
