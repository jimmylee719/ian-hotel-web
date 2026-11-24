import type { Locale, NotificationKind } from "@/lib/db/schema";

export type EmailData = {
  hotelName: string;
  code: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string;
  roomTypeName: string;
  rooms: number;
  nights: number;
  roomSubtotal: number;
  addonSubtotal: number;
  discount: number;
  total: number;
  paid: number;
  cancellationText: string;
  hotelPhone: string;
  hotelEmail: string;
  hotelAddress: string;
  manageUrl: string;
  refundAmount?: number;
};

type CustomerKind = "booking_confirmed" | "booking_failed_refunded" | "cancelled" | "pre_arrival";

type Copy = {
  labels: {
    code: string; stay: string; room: string; rooms: string; nights: string; roomSubtotal: string;
    addons: string; discount: string; total: string; paid: string; refund: string; cancellation: string;
    contact: string; manage: string;
  };
  sign: string;
  kinds: Record<CustomerKind, { subject: (d: EmailData) => string; heading: string; intro: (d: EmailData) => string }>;
};

const copy: Record<Locale, Copy> = {
  "zh-TW": {
    labels: {
      code: "訂單代碼", stay: "入住期間", room: "房型", rooms: "間數", nights: "晚數", roomSubtotal: "房費",
      addons: "加購項目", discount: "優惠折抵", total: "訂單總額", paid: "已付金額", refund: "退款金額",
      cancellation: "取消規則", contact: "聯絡我們", manage: "查看或管理訂單",
    },
    sign: "期待與您相見",
    kinds: {
      booking_confirmed: {
        subject: (d) => `訂房確認：${d.code}｜${d.hotelName}`,
        heading: "您的訂房已確認",
        intro: (d) => `感謝您選擇${d.hotelName}。我們已為您保留房間，以下是您的訂房資訊。`,
      },
      booking_failed_refunded: {
        subject: (d) => `訂房未能完成，款項將退還：${d.code}｜${d.hotelName}`,
        heading: "很抱歉，這次訂房未能完成",
        intro: () => "付款完成時，房間已被預訂一空，我們無法為您保留。已付款項將全額退回原付款方式，銀行入帳時間依發卡行而定。",
      },
      cancelled: {
        subject: (d) => `訂單已取消：${d.code}｜${d.hotelName}`,
        heading: "您的訂單已取消",
        intro: () => "我們已為您取消這筆訂房，若有應退款項，將退回原付款方式。",
      },
      pre_arrival: {
        subject: (d) => `入住提醒：${d.code}｜${d.hotelName}`,
        heading: "入住在即，我們已準備好迎接您",
        intro: (d) => `提醒您，您將於 ${d.checkIn} 入住${d.hotelName}。如有任何需求，歡迎隨時與我們聯絡。`,
      },
    },
  },
  en: {
    labels: {
      code: "Booking code", stay: "Stay", room: "Room", rooms: "Rooms", nights: "Nights", roomSubtotal: "Room charges",
      addons: "Add-ons", discount: "Discount", total: "Total", paid: "Paid", refund: "Refund",
      cancellation: "Cancellation policy", contact: "Contact us", manage: "View or manage your booking",
    },
    sign: "We look forward to welcoming you",
    kinds: {
      booking_confirmed: {
        subject: (d) => `Booking confirmed: ${d.code} | ${d.hotelName}`,
        heading: "Your booking is confirmed",
        intro: (d) => `Thank you for choosing ${d.hotelName}. Your room is reserved, and the details are below.`,
      },
      booking_failed_refunded: {
        subject: (d) => `We could not complete your booking, refund issued: ${d.code} | ${d.hotelName}`,
        heading: "We're sorry, your booking could not be completed",
        intro: () => "The room was taken just as your payment went through, so we were unable to hold it for you. Your payment is being refunded in full to your original payment method; timing depends on your bank.",
      },
      cancelled: {
        subject: (d) => `Booking cancelled: ${d.code} | ${d.hotelName}`,
        heading: "Your booking has been cancelled",
        intro: () => "We have cancelled this booking. Any refund due will be returned to your original payment method.",
      },
      pre_arrival: {
        subject: (d) => `Your stay is coming up: ${d.code} | ${d.hotelName}`,
        heading: "We're almost ready to welcome you",
        intro: (d) => `A quick reminder that you check in at ${d.hotelName} on ${d.checkIn}. If there is anything we can arrange beforehand, just let us know.`,
      },
    },
  },
  ja: {
    labels: {
      code: "ご予約番号", stay: "ご宿泊期間", room: "お部屋タイプ", rooms: "室数", nights: "泊数", roomSubtotal: "宿泊料金",
      addons: "オプション", discount: "割引", total: "合計金額", paid: "お支払い済み金額", refund: "ご返金額",
      cancellation: "キャンセルポリシー", contact: "お問い合わせ", manage: "ご予約の確認・変更",
    },
    sign: "ご来館を心よりお待ちしております",
    kinds: {
      booking_confirmed: {
        subject: (d) => `ご予約確認：${d.code}｜${d.hotelName}`,
        heading: "ご予約が確定いたしました",
        intro: (d) => `${d.hotelName}をお選びいただき、ありがとうございます。お部屋をお取りいたしました。ご予約内容は以下のとおりです。`,
      },
      booking_failed_refunded: {
        subject: (d) => `ご予約を完了できませんでした（ご返金手続き済み）：${d.code}｜${d.hotelName}`,
        heading: "誠に申し訳ございません。ご予約を完了できませんでした",
        intro: () => "お支払い手続きの直前にお部屋が満室となり、ご用意することができませんでした。お支払い済みの金額は、ご利用のお支払い方法へ全額ご返金いたします。反映時期はカード会社・金融機関により異なります。",
      },
      cancelled: {
        subject: (d) => `ご予約をキャンセルしました：${d.code}｜${d.hotelName}`,
        heading: "ご予約をキャンセルいたしました",
        intro: () => "こちらのご予約をキャンセルいたしました。ご返金が発生する場合は、元のお支払い方法へお戻しいたします。",
      },
      pre_arrival: {
        subject: (d) => `ご到着のご案内：${d.code}｜${d.hotelName}`,
        heading: "まもなくご到着、準備を整えてお待ちしております",
        intro: (d) => `${d.checkIn}に${d.hotelName}へご到着のご予定です。事前にご用意できることがございましたら、お気軽にご連絡ください。`,
      },
    },
  },
  ko: {
    labels: {
      code: "예약 번호", stay: "숙박 기간", room: "객실 유형", rooms: "객실 수", nights: "숙박 일수", roomSubtotal: "객실 요금",
      addons: "추가 옵션", discount: "할인", total: "총 금액", paid: "결제 금액", refund: "환불 금액",
      cancellation: "취소 규정", contact: "문의", manage: "예약 확인 및 관리",
    },
    sign: "뵙게 되기를 진심으로 기대합니다",
    kinds: {
      booking_confirmed: {
        subject: (d) => `예약 확정 안내: ${d.code} | ${d.hotelName}`,
        heading: "예약이 확정되었습니다",
        intro: (d) => `${d.hotelName}을(를) 선택해 주셔서 감사합니다. 객실을 확보해 두었으며, 예약 내용은 아래와 같습니다.`,
      },
      booking_failed_refunded: {
        subject: (d) => `예약을 완료하지 못했습니다 (환불 처리됨): ${d.code} | ${d.hotelName}`,
        heading: "죄송합니다. 예약을 완료하지 못했습니다",
        intro: () => "결제가 이루어지는 사이에 객실이 모두 예약되어 확보해 드리지 못했습니다. 결제하신 금액은 기존 결제 수단으로 전액 환불되며, 반영 시점은 카드사 및 은행에 따라 다릅니다.",
      },
      cancelled: {
        subject: (d) => `예약이 취소되었습니다: ${d.code} | ${d.hotelName}`,
        heading: "예약이 취소되었습니다",
        intro: () => "해당 예약을 취소했습니다. 환불 대상 금액이 있는 경우 기존 결제 수단으로 환불해 드립니다.",
      },
      pre_arrival: {
        subject: (d) => `투숙 안내: ${d.code} | ${d.hotelName}`,
        heading: "곧 뵙겠습니다. 맞이할 준비를 마쳤습니다",
        intro: (d) => `${d.checkIn}에 ${d.hotelName} 체크인 예정이십니다. 미리 준비해 드릴 사항이 있으면 언제든 연락해 주세요.`,
      },
    },
  },
};

export function formatTwd(n: number): string {
  return `NT$${new Intl.NumberFormat("en-US").format(n)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rows(kind: CustomerKind, c: Copy, d: EmailData): [string, string][] {
  const l = c.labels;
  const r: [string, string][] = [
    [l.code, d.code],
    [l.stay, `${d.checkIn} → ${d.checkOut}`],
    [l.room, d.roomTypeName],
    [l.rooms, String(d.rooms)],
    [l.nights, String(d.nights)],
  ];
  if (kind === "booking_confirmed" || kind === "pre_arrival") {
    r.push([l.roomSubtotal, formatTwd(d.roomSubtotal)]);
    if (d.addonSubtotal > 0) r.push([l.addons, formatTwd(d.addonSubtotal)]);
    if (d.discount > 0) r.push([l.discount, `-${formatTwd(d.discount)}`]);
    r.push([l.total, formatTwd(d.total)], [l.paid, formatTwd(d.paid)]);
  }
  if ((kind === "cancelled" || kind === "booking_failed_refunded") && d.refundAmount !== undefined) {
    r.push([l.refund, formatTwd(d.refundAmount)]);
  }
  if (kind === "booking_confirmed" || kind === "pre_arrival" || kind === "cancelled") {
    r.push([l.cancellation, d.cancellationText]);
  }
  return r;
}

const STYLE = {
  body: "margin:0;padding:24px;background:#f6f3ee;font-family:-apple-system,'Segoe UI','Noto Sans TC','Noto Sans JP','Noto Sans KR',Helvetica,Arial,sans-serif;color:#2b2622;",
  card: "max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;",
  h1: "margin:0 0 12px;font-size:20px;font-weight:600;",
  p: "margin:0 0 20px;font-size:15px;line-height:1.7;",
  td1: "padding:8px 0;font-size:14px;color:#7a7168;vertical-align:top;width:38%;border-top:1px solid #eee8df;",
  td2: "padding:8px 0;font-size:14px;vertical-align:top;border-top:1px solid #eee8df;",
  btn: "display:inline-block;margin:24px 0;padding:12px 24px;background:#2b2622;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;",
  foot: "margin:24px 0 0;font-size:13px;line-height:1.7;color:#7a7168;",
};

function renderCustomer(kind: CustomerKind, locale: Locale, d: EmailData) {
  const c = copy[locale];
  const k = c.kinds[kind];
  const table = rows(kind, c, d);
  const contact = [d.hotelPhone, d.hotelEmail, d.hotelAddress].filter(Boolean);

  const html = `<!doctype html><html lang="${locale}"><body style="${STYLE.body}"><div style="${STYLE.card}">
<h1 style="${STYLE.h1}">${esc(k.heading)}</h1>
<p style="${STYLE.p}">${esc(k.intro(d))}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${table
    .map(([a, b]) => `<tr><td style="${STYLE.td1}">${esc(a)}</td><td style="${STYLE.td2}">${esc(b)}</td></tr>`)
    .join("")}</table>
<a href="${esc(d.manageUrl)}" style="${STYLE.btn}">${esc(c.labels.manage)}</a>
<p style="${STYLE.foot}">${esc(c.sign)}<br>${esc(d.hotelName)}<br>${esc(c.labels.contact)}：${contact.map(esc).join(" / ")}</p>
</div></body></html>`;

  const text = [
    k.heading, "", k.intro(d), "",
    ...table.map(([a, b]) => `${a}: ${b}`), "",
    `${c.labels.manage}: ${d.manageUrl}`, "",
    c.sign, d.hotelName, `${c.labels.contact}: ${contact.join(" / ")}`,
  ].join("\n");

  return { subject: k.subject(d), html, text };
}

const STAFF_TITLE: Record<"staff_new_booking" | "staff_sync_failed" | "staff_payment_alert", string> = {
  staff_new_booking: "新訂單",
  staff_sync_failed: "通路同步失敗，需人工處理",
  staff_payment_alert: "付款異常，需人工確認",
};

function renderStaff(kind: keyof typeof STAFF_TITLE, d: EmailData) {
  const title = STAFF_TITLE[kind];
  const lines = [
    `訂單代碼：${d.code}`,
    `房型：${d.roomTypeName} × ${d.rooms}`,
    `入住：${d.checkIn} → ${d.checkOut}（${d.nights} 晚）`,
    `總額：${formatTwd(d.total)}，已付：${formatTwd(d.paid)}`,
    `管理：${d.manageUrl}`,
  ];
  const html = `<!doctype html><html lang="zh-TW"><body style="${STYLE.body}"><div style="${STYLE.card}"><h1 style="${STYLE.h1}">${esc(title)}</h1>${lines
    .map((l) => `<p style="margin:0 0 8px;font-size:14px;">${esc(l)}</p>`)
    .join("")}</div></body></html>`;
  return { subject: `[${d.hotelName}] ${title}：${d.code}`, html, text: [title, "", ...lines].join("\n") };
}

export function renderEmail(
  kind: NotificationKind,
  locale: Locale,
  data: EmailData,
): { subject: string; html: string; text: string } {
  if (kind === "staff_new_booking" || kind === "staff_sync_failed" || kind === "staff_payment_alert") {
    return renderStaff(kind, data);
  }
  return renderCustomer(kind, locale, data);
}
