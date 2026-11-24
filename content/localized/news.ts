/**
 * News carried over from the old site (news_detail.php). Only items still relevant are kept;
 * an item without an entry here is not seeded. zh-TW is the old text, lightly edited; en, ja and ko
 * are machine translations (listed in messages/_review.md).
 */
import type { I18n } from "@/lib/db/schema";

export const newsText: Record<string, { title: I18n; body: I18n }> = {
  "news-281": {
    title: {
      "zh-TW": "2025 旅宿業減塑元年：一次性備品改為自取付費",
      en: "From 2025: single-use toiletries on request",
      ja: "2025 年から使い捨てアメニティは有料・セルフサービスに",
      ko: "2025년부터 일회용 어메니티는 유료 셀프 서비스로",
    },
    body: {
      "zh-TW": `配合環境部的旅宿業減塑規定，自 2025 年 1 月 1 日起，一次性備品改放在大廳，採誠實商店自取付費：
- 牙膏牙刷組 NT$10
- 浴帽 NT$10
- 刮鬍刀 NT$10
- 梳子 NT$10

房內不再提供瓶裝水，改放冷水瓶，各樓層飲水機都可以裝水。謝謝您和我們一起，讓旅行更永續。`,
      en: `In line with Taiwan's Ministry of Environment rules on plastic reduction in hotels, from 1 January 2025 single-use toiletries are kept in the lobby on an honesty-box basis:
- Toothbrush and toothpaste NT$10
- Shower cap NT$10
- Razor NT$10
- Comb NT$10

Rooms no longer have bottled water; instead there is a jug, and every floor has a water dispenser for refills. Thank you for helping us travel more sustainably.`,
      ja: `環境部の宿泊施設におけるプラスチック削減規定に基づき、2025 年 1 月 1 日より使い捨てアメニティはロビーに置き、セルフサービスの料金箱方式とします。
- 歯ブラシ・歯磨き粉セット NT$10
- シャワーキャップ NT$10
- カミソリ NT$10
- くし NT$10

客室のペットボトル入りの水は廃止し、ピッチャーをご用意しています。各階のウォーターサーバーでご自由にお汲みください。持続可能な旅へのご協力に感謝いたします。`,
      ko: `환경부의 숙박업 플라스틱 감축 규정에 따라 2025년 1월 1일부터 일회용 어메니티는 로비에 비치하고, 무인 계산함 방식으로 유료 제공합니다.
- 칫솔·치약 세트 NT$10
- 샤워캡 NT$10
- 면도기 NT$10
- 빗 NT$10

객실에는 생수병 대신 물병을 두며, 층마다 있는 정수기에서 물을 받으실 수 있습니다. 지속 가능한 여행에 함께해 주셔서 감사합니다.`,
    },
  },
  "news-184": {
    title: {
      "zh-TW": "小公館獲得 Booking.com 住客評分獎",
      en: "NK Hostel wins a Booking.com Guest Review Award",
      ja: "Booking.com のゲストレビューアワードを受賞しました",
      ko: "Booking.com 게스트 리뷰 어워드를 받았습니다",
    },
    body: {
      "zh-TW": `非常感謝 Booking.com 頒發的住客評分獎，也謝謝每一位旅客的指教與支持。我們會繼續把這裡打理成讓你安心停靠的地方，為你的旅程多留一些美好的回憶。`,
      en: `Thank you to Booking.com for the Guest Review Award, and to every guest for your feedback and support. We will keep making this a place where you can rest easy, and add a few more good memories to your trip.`,
      ja: `Booking.com からゲストレビューアワードをいただきました。ご意見と応援をくださったすべてのお客様に感謝いたします。これからも安心してくつろげる場所であり続け、皆様の旅にすてきな思い出を添えられるよう努めてまいります。`,
      ko: `Booking.com으로부터 게스트 리뷰 어워드를 받았습니다. 소중한 의견과 응원을 보내 주신 모든 손님께 감사드립니다. 앞으로도 편히 쉬어 갈 수 있는 곳이 되어 여러분의 여행에 좋은 추억을 더하겠습니다.`,
    },
  },
};
