/**
 * Room details in four languages. zh-TW is the old site's text (rooms.php?id=*), lightly edited;
 * the old /en/ room pages carried the Chinese text, so en, ja and ko are machine translations
 * (listed in messages/_review.md).
 */
import type { I18n } from "@/lib/db/schema";

type RoomText = { description: I18n; bedType: I18n; sizeSqm: number | null };

const CAPSULE_ZH = `【公共衛浴與空間】
- 乾濕分離淋浴間，備有沐浴乳、洗髮乳、潤髮乳
- 公共空間備有飲水機、茶包、糖包、奶精

【房客注意事項】
- 為響應環保，不主動提供一次性備品。
- 床位房內禁止飲食（僅可帶水），請勿大聲交談或講電話；晚上 11 點後請放輕音量與腳步。
- 不接受 7 歲以下兒童入住床位。
- 房間與公共區域全面禁菸，僅可於公共露臺吸菸。
- 需要熨斗或燙衣板，請向櫃台借用。`;

const CAPSULE_EN = `Shared bathrooms and spaces
- Showers with separate wet and dry areas, body wash, shampoo and conditioner provided
- Water dispenser, tea, sugar and creamer in the common area

House rules
- To cut waste, single-use toiletries are not provided unless you ask.
- No food in the dorm rooms (water only), no loud talking or phone calls; please keep quiet after 11 pm.
- Children under 7 cannot stay in capsule beds.
- The whole building is non-smoking except the public terrace.
- Irons and ironing boards can be borrowed from the front desk.`;

const CAPSULE_JA = `共用バスルーム・共用スペース
- 洗い場と脱衣所を分けたシャワールーム（ボディソープ、シャンプー、コンディショナー付き）
- 共用スペースにウォーターサーバー、ティーバッグ、砂糖、ミルクをご用意

ご宿泊にあたって
- 環境配慮のため、使い捨てアメニティはご希望の方にのみお渡しします。
- 客室内での飲食（お水を除く）、大声での会話や通話はご遠慮ください。午後 11 時以降はお静かにお願いします。
- 7 歳未満のお子様はカプセルベッドにご宿泊いただけません。
- 館内は全面禁煙です。喫煙は共用テラスのみでお願いします。
- アイロン・アイロン台はフロントで貸し出しています。`;

const CAPSULE_KO = `공용 욕실 및 공간
- 건식·습식 구역이 분리된 샤워실(바디워시, 샴푸, 컨디셔너 제공)
- 공용 공간에 정수기, 티백, 설탕, 크리머 비치

이용 안내
- 환경 보호를 위해 일회용 어메니티는 요청 시에만 제공합니다.
- 도미토리 객실 내 음식물 섭취(물 제외), 큰 소리의 대화와 통화는 삼가 주세요. 밤 11시 이후에는 조용히 해 주세요.
- 7세 미만 어린이는 캡슐 침대에 투숙할 수 없습니다.
- 건물 전체 금연이며, 흡연은 공용 테라스에서만 가능합니다.
- 다리미와 다리미판은 프런트에서 대여해 드립니다.`;

const SUITE_ZH = `【房客注意事項】
- 晚上 11 點後請降低房內交談音量。
- 房間與公共區域全面禁菸，僅可於 14 樓頂樓吸菸。
- 需要熨斗或燙衣板，請向櫃台借用；需要兒童用品，請於訂房時告知。`;

const SUITE_EN = `House rules
- Please keep your voice down after 11 pm.
- The whole building is non-smoking except the 14th-floor rooftop.
- Irons and ironing boards can be borrowed from the front desk; tell us when you book if you need children's equipment.`;

const SUITE_JA = `ご宿泊にあたって
- 午後 11 時以降は客室内でもお静かにお願いします。
- 館内は全面禁煙です。喫煙は 14 階屋上のみでお願いします。
- アイロン・アイロン台はフロントで貸し出しています。お子様用品が必要な場合はご予約時にお知らせください。`;

const SUITE_KO = `이용 안내
- 밤 11시 이후에는 객실 안에서도 조용히 해 주세요.
- 건물 전체 금연이며, 흡연은 14층 옥상에서만 가능합니다.
- 다리미와 다리미판은 프런트에서 대여해 드립니다. 유아용품이 필요하시면 예약 시 알려 주세요.`;

const DORM_ZH = `【公共衛浴與空間】
- 乾濕分離淋浴間，備有沐浴乳、洗髮乳、潤髮乳
- 公共空間備有飲水機與公共冰箱

【房客注意事項】
- 晚上 11 點後請降低 8 樓交誼廳與房內的交談音量。
- 房間與公共區域全面禁菸，僅可於公共露臺吸菸。
- 進入 8 樓交誼廳請換穿館內拖鞋。`;

const DORM_EN = `Shared bathrooms and spaces
- Showers with separate wet and dry areas, body wash, shampoo and conditioner provided
- Water dispenser and shared fridge in the common area

House rules
- Please keep quiet in the room and the 8th-floor lounge after 11 pm.
- The whole building is non-smoking except the public terrace.
- Please change into the slippers provided before entering the 8th-floor lounge.`;

const DORM_JA = `共用バスルーム・共用スペース
- 洗い場と脱衣所を分けたシャワールーム（ボディソープ、シャンプー、コンディショナー付き）
- 共用スペースにウォーターサーバーと共用冷蔵庫をご用意

ご宿泊にあたって
- 午後 11 時以降は客室内と 8 階ラウンジでお静かにお願いします。
- 館内は全面禁煙です。喫煙は共用テラスのみでお願いします。
- 8 階ラウンジへは備え付けのスリッパに履き替えてお入りください。`;

const DORM_KO = `공용 욕실 및 공간
- 건식·습식 구역이 분리된 샤워실(바디워시, 샴푸, 컨디셔너 제공)
- 공용 공간에 정수기와 공용 냉장고 비치

이용 안내
- 밤 11시 이후에는 객실과 8층 라운지에서 조용히 해 주세요.
- 건물 전체 금연이며, 흡연은 공용 테라스에서만 가능합니다.
- 8층 라운지에 들어가실 때는 비치된 실내 슬리퍼로 갈아 신어 주세요.`;

export const roomText: Record<string, RoomText> = {
  "mixed-cube": {
    sizeSqm: 3,
    bedType: {
      "zh-TW": "雙人床位 140 × 188 公分",
      en: "Double capsule bed, 140 × 188 cm",
      ja: "ダブルカプセルベッド 140 × 188 cm",
      ko: "더블 캡슐 침대 140 × 188cm",
    },
    description: {
      "zh-TW": `男女混合的個人背包床位。艙內高 140、深 210、寬 140 公分，約 3 平方米；床位 140 × 188 公分，鋪好 350 織高級精梳棉寢具。個人電子置物櫃高 80、深 50、寬 45 公分，放得下 24 至 26 吋行李箱。單人入住另有優惠方案。

${CAPSULE_ZH}`,
      en: `A private capsule in a mixed dorm. Inside it is 140 cm high, 210 cm deep and 140 cm wide (about 3 m²), with a 140 × 188 cm bed made up with 350-thread-count combed cotton linen. Your own electronic locker (80 × 50 × 45 cm) fits a 24 to 26 inch suitcase. A single-occupancy rate is also available.

${CAPSULE_EN}`,
      ja: `男女混合ドミトリーの個室カプセルです。内部は高さ 140 cm・奥行 210 cm・幅 140 cm（約 3 m²）、ベッドは 140 × 188 cm で、350 番手の高級コーマ綿リネンをセットしてお待ちしています。専用の電子ロッカー（80 × 50 × 45 cm）には 24〜26 インチのスーツケースが入ります。お一人様向けのプランもございます。

${CAPSULE_JA}`,
      ko: `남녀 혼성 도미토리의 개인 캡슐입니다. 내부는 높이 140cm, 깊이 210cm, 너비 140cm(약 3㎡)이며, 140 × 188cm 침대에 350수 고급 코마 면 침구가 준비되어 있습니다. 개인 전자 사물함(80 × 50 × 45cm)에는 24~26인치 캐리어가 들어갑니다. 1인 이용 요금도 있습니다.

${CAPSULE_KO}`,
    },
  },
  "female-cube": {
    sizeSqm: 3,
    bedType: {
      "zh-TW": "雙人床位 140 × 188 公分",
      en: "Double capsule bed, 140 × 188 cm",
      ja: "ダブルカプセルベッド 140 × 188 cm",
      ko: "더블 캡슐 침대 140 × 188cm",
    },
    description: {
      "zh-TW": `女性專屬的個人背包床位，一室 14 床或 8 床，另設更衣間與修容鏡。艙內高 140、深 210、寬 140 公分，約 3 平方米；床位 140 × 188 公分，鋪好 350 織高級精梳棉寢具。個人電子置物櫃放得下 24 吋行李箱。單人入住另有優惠方案。

${CAPSULE_ZH}`,
      en: `A private capsule in a women-only dorm of 14 or 8 beds, with its own dressing room and vanity mirrors. Inside it is 140 cm high, 210 cm deep and 140 cm wide (about 3 m²), with a 140 × 188 cm bed made up with 350-thread-count combed cotton linen. Your own electronic locker fits a 24 inch suitcase. A single-occupancy rate is also available.

${CAPSULE_EN}`,
      ja: `女性専用ドミトリー（14 床または 8 床）の個室カプセルです。更衣室とドレッサーミラーを備えています。内部は高さ 140 cm・奥行 210 cm・幅 140 cm（約 3 m²）、ベッドは 140 × 188 cm で、350 番手の高級コーマ綿リネンをご用意しています。専用の電子ロッカーには 24 インチのスーツケースが入ります。お一人様向けのプランもございます。

${CAPSULE_JA}`,
      ko: `여성 전용 도미토리(14베드 또는 8베드)의 개인 캡슐로, 탈의실과 화장 거울이 따로 있습니다. 내부는 높이 140cm, 깊이 210cm, 너비 140cm(약 3㎡)이며, 140 × 188cm 침대에 350수 고급 코마 면 침구가 준비되어 있습니다. 개인 전자 사물함에는 24인치 캐리어가 들어갑니다. 1인 이용 요금도 있습니다.

${CAPSULE_KO}`,
    },
  },
  "buddy-room": {
    sizeSqm: 23,
    bedType: {
      "zh-TW": "兩組上下舖，四張單人床 100 × 200 公分",
      en: "Two bunk beds (four singles, 100 × 200 cm)",
      ja: "2 段ベッド 2 台（シングル 4 台、100 × 200 cm）",
      ko: "2층 침대 2개(싱글 4개, 100 × 200cm)",
    },
    description: {
      "zh-TW": `23 平方米的四人房，兩組上下舖共四張 100 × 200 公分單人床，鋪好 350 織高級精梳棉寢具。每人一個電子置物櫃（高 80、深 50、寬 45 公分），放得下 28 吋行李箱。房內有 32 吋液晶電視（無第四台頻道）。可加床，最多入住六人。

${DORM_ZH}`,
      en: `A 23 m² room for four, with two bunk beds (four 100 × 200 cm singles) made up with 350-thread-count combed cotton linen. Everyone gets an electronic locker (80 × 50 × 45 cm) that fits a 28 inch suitcase. 32 inch LCD TV (no cable channels). Extra beds can be added for up to six guests.

${DORM_EN}`,
      ja: `23 m² の 4 名様用客室です。2 段ベッド 2 台（100 × 200 cm のシングル 4 台）に 350 番手の高級コーマ綿リネンをご用意しています。お一人おひとりに 28 インチのスーツケースが入る電子ロッカー（80 × 50 × 45 cm）付き。32 インチ液晶テレビ（ケーブル放送なし）。エキストラベッドで最大 6 名様までご宿泊いただけます。

${DORM_JA}`,
      ko: `23㎡의 4인실로, 2층 침대 2개(100 × 200cm 싱글 4개)에 350수 고급 코마 면 침구가 준비되어 있습니다. 1인당 28인치 캐리어가 들어가는 전자 사물함(80 × 50 × 45cm)을 제공합니다. 32인치 LCD TV(케이블 채널 없음). 엑스트라 베드로 최대 6명까지 투숙할 수 있습니다.

${DORM_KO}`,
    },
  },
  "buddy-room-six": {
    sizeSqm: 33,
    bedType: {
      "zh-TW": "三組上下舖，六張單人床 100 × 200 公分",
      en: "Three bunk beds (six singles, 100 × 200 cm)",
      ja: "2 段ベッド 3 台（シングル 6 台、100 × 200 cm）",
      ko: "2층 침대 3개(싱글 6개, 100 × 200cm)",
    },
    description: {
      "zh-TW": `33 平方米的六人房，三組上下舖共六張 100 × 200 公分單人床，鋪好 350 織高級精梳棉寢具。每人一個電子置物櫃，放得下 28 吋行李箱。房內有 32 吋液晶電視（無第四台頻道）、沙發與茶几。可加床，最多入住八人，加床費另計。

${DORM_ZH}`,
      en: `A 33 m² room for six, with three bunk beds (six 100 × 200 cm singles) made up with 350-thread-count combed cotton linen. Everyone gets an electronic locker that fits a 28 inch suitcase. 32 inch LCD TV (no cable channels), sofa and coffee table. Extra beds (charged separately) take it up to eight guests.

${DORM_EN}`,
      ja: `33 m² の 6 名様用客室です。2 段ベッド 3 台（100 × 200 cm のシングル 6 台）に 350 番手の高級コーマ綿リネンをご用意しています。お一人おひとりに 28 インチのスーツケースが入る電子ロッカー付き。32 インチ液晶テレビ（ケーブル放送なし）、ソファ、ローテーブルを備えています。エキストラベッド（別料金）で最大 8 名様までご宿泊いただけます。

${DORM_JA}`,
      ko: `33㎡의 6인실로, 2층 침대 3개(100 × 200cm 싱글 6개)에 350수 고급 코마 면 침구가 준비되어 있습니다. 1인당 28인치 캐리어가 들어가는 전자 사물함을 제공합니다. 32인치 LCD TV(케이블 채널 없음), 소파, 티 테이블이 있습니다. 엑스트라 베드(별도 요금)로 최대 8명까지 투숙할 수 있습니다.

${DORM_KO}`,
    },
  },
  "mini-room": {
    sizeSqm: 17,
    bedType: {
      "zh-TW": "特殊尺寸雙人床 150 × 183 公分",
      en: "Double bed, 150 × 183 cm (shorter than standard)",
      ja: "ダブルベッド 150 × 183 cm（標準より短め）",
      ko: "더블 침대 150 × 183cm(표준보다 짧음)",
    },
    description: {
      "zh-TW": `17 平方米的雙人套房。特殊尺寸雙人床 150 × 183 公分，身高超過 180 公分的旅客請改選其他房型。鋪好 350 織高級精梳棉寢具，另有單人小沙發與 42 吋液晶電視（含第四台頻道）。房內有私人衛浴，乾濕分離淋浴間備有沐浴乳、洗髮乳、潤髮乳。因空間有限，不提供加床。

${SUITE_ZH}`,
      en: `A 17 m² double room. The bed is a shorter-than-standard 150 × 183 cm double, so guests over 180 cm tall may prefer another room. 350-thread-count combed cotton linen, an armchair and a 42 inch LCD TV with cable channels. Private bathroom with a separate shower area, body wash, shampoo and conditioner. No extra beds (the room is too small).

${SUITE_EN}`,
      ja: `17 m² のダブルルームです。ベッドは標準より短い 150 × 183 cm のダブルのため、身長 180 cm 以上の方は他の客室をおすすめします。350 番手の高級コーマ綿リネン、一人掛けソファ、42 インチ液晶テレビ（ケーブル放送あり）を備えています。専用バスルームには洗い場を分けたシャワールーム（ボディソープ、シャンプー、コンディショナー付き）があります。客室が狭いためエキストラベッドはご用意できません。

${SUITE_JA}`,
      ko: `17㎡의 더블룸입니다. 침대가 표준보다 짧은 150 × 183cm 더블이라 키 180cm 이상인 분께는 다른 객실을 권해 드립니다. 350수 고급 코마 면 침구, 1인용 소파, 42인치 LCD TV(케이블 채널)를 갖추고 있습니다. 전용 욕실에는 건식·습식 구역이 분리된 샤워실(바디워시, 샴푸, 컨디셔너)이 있습니다. 객실이 좁아 엑스트라 베드는 제공되지 않습니다.

${SUITE_KO}`,
    },
  },
  "classic-room": {
    sizeSqm: 27,
    bedType: {
      "zh-TW": "雙人床 150 × 188 公分，或兩張單人床 90 × 188 公分",
      en: "Double bed 150 × 188 cm, or two singles 90 × 188 cm",
      ja: "ダブルベッド 150 × 188 cm、またはシングル 2 台 90 × 188 cm",
      ko: "더블 침대 150 × 188cm 또는 싱글 2개 90 × 188cm",
    },
    description: {
      "zh-TW": `27 平方米的雙人套房，窗外是基隆河畔或台北 101（依當天排房，無法指定）。一張 150 × 188 公分雙人床，或兩張 90 × 188 公分單人床，請於訂房時告知。鋪好 350 織高級精梳棉寢具，房內有 42 吋液晶電視（含第四台頻道）、保險箱與小冰箱。私人衛浴，乾濕分離淋浴間備有沐浴乳、洗髮乳、潤髮乳。可加床。

${SUITE_ZH}`,
      en: `A 27 m² double room looking out over the Keelung River or towards Taipei 101 (assigned on the day; views cannot be requested). Choose one 150 × 188 cm double or two 90 × 188 cm singles when you book. 350-thread-count combed cotton linen, 42 inch LCD TV with cable channels, safe and mini fridge. Private bathroom with a separate shower area, body wash, shampoo and conditioner. Extra beds available.

${SUITE_EN}`,
      ja: `27 m² のダブルルームで、窓からは基隆河または台北 101 が見えます（当日の割り当てのため眺望の指定はできません）。150 × 188 cm のダブルベッド 1 台、または 90 × 188 cm のシングルベッド 2 台をご予約時にお選びください。350 番手の高級コーマ綿リネン、42 インチ液晶テレビ（ケーブル放送あり）、セーフティボックス、小型冷蔵庫を備えています。専用バスルームには洗い場を分けたシャワールーム（ボディソープ、シャンプー、コンディショナー付き）があります。エキストラベッドも承ります。

${SUITE_JA}`,
      ko: `27㎡의 더블룸으로, 창밖으로 지룽강 또는 타이베이 101이 보입니다(당일 배정되며 전망은 지정할 수 없습니다). 150 × 188cm 더블 침대 1개 또는 90 × 188cm 싱글 침대 2개 중에서 예약 시 선택해 주세요. 350수 고급 코마 면 침구, 42인치 LCD TV(케이블 채널), 금고, 소형 냉장고를 갖추고 있습니다. 전용 욕실에는 건식·습식 구역이 분리된 샤워실(바디워시, 샴푸, 컨디셔너)이 있습니다. 엑스트라 베드를 이용하실 수 있습니다.

${SUITE_KO}`,
    },
  },
  "deluxe-room": {
    sizeSqm: 30,
    bedType: {
      "zh-TW": "加大雙人床 170 × 200 公分",
      en: "King bed, 170 × 200 cm",
      ja: "キングベッド 170 × 200 cm",
      ko: "킹 침대 170 × 200cm",
    },
    description: {
      "zh-TW": `30 平方米的雙人套房，面向台北 101 景觀陽台或基隆河畔（隨機排房，無法指定）。加大雙人床 170 × 200 公分，鋪好 350 織高級精梳棉寢具；房內有雙人小沙發、書桌、小冰箱、熱水壺與 47 吋液晶電視（含第四台頻道）。私人衛浴有乾濕分離淋浴間與浴缸，備有沐浴乳、洗髮乳、潤髮乳。可加床，最多入住四人。

${SUITE_ZH}`,
      en: `A 30 m² double room facing a balcony with a view of Taipei 101, or the Keelung River (assigned on the day; views cannot be requested). King bed, 170 × 200 cm, with 350-thread-count combed cotton linen; loveseat, desk, mini fridge, kettle and a 47 inch LCD TV with cable channels. Private bathroom with a separate shower and a bathtub, body wash, shampoo and conditioner. Extra beds for up to four guests.

${SUITE_EN}`,
      ja: `30 m² のダブルルームで、台北 101 を望むバルコニー側、または基隆河側のお部屋です（当日の割り当てのため眺望の指定はできません）。170 × 200 cm のキングベッドに 350 番手の高級コーマ綿リネン、2 人掛けソファ、デスク、小型冷蔵庫、電気ケトル、47 インチ液晶テレビ（ケーブル放送あり）を備えています。専用バスルームには洗い場を分けたシャワールームとバスタブがあり、ボディソープ、シャンプー、コンディショナーをご用意しています。エキストラベッドで最大 4 名様までご宿泊いただけます。

${SUITE_JA}`,
      ko: `30㎡의 더블룸으로, 타이베이 101이 보이는 발코니 쪽 또는 지룽강 쪽 객실입니다(당일 배정되며 전망은 지정할 수 없습니다). 170 × 200cm 킹 침대에 350수 고급 코마 면 침구, 2인용 소파, 책상, 소형 냉장고, 전기 포트, 47인치 LCD TV(케이블 채널)를 갖추고 있습니다. 전용 욕실에는 건식·습식 구역이 분리된 샤워실과 욕조가 있으며 바디워시, 샴푸, 컨디셔너를 제공합니다. 엑스트라 베드로 최대 4명까지 투숙할 수 있습니다.

${SUITE_KO}`,
    },
  },
  "connecting-room": {
    sizeSqm: 66,
    bedType: {
      "zh-TW": "雙人床 160 × 188 公分＋上下舖兩張單人床 85 × 188 公分",
      en: "Double bed 160 × 188 cm plus a bunk bed (two singles, 85 × 188 cm)",
      ja: "ダブルベッド 160 × 188 cm と 2 段ベッド（シングル 2 台、85 × 188 cm）",
      ko: "더블 침대 160 × 188cm + 2층 침대(싱글 2개, 85 × 188cm)",
    },
    description: {
      "zh-TW": `兩間相通的房間，共約 66 平方米（約 20 坪），適合家庭或結伴同行。一張 160 × 188 公分雙人床，加一組 85 × 188 公分上下舖，鋪好 350 織高級精梳棉寢具。兩間各有液晶電視、獨立冷暖氣、乾濕分離衛浴與小冰箱。公共空間備有飲水機與公共冰箱。

${SUITE_ZH}`,
      en: `Two connecting rooms, about 66 m² in all, for families or friends travelling together. One 160 × 188 cm double bed plus a bunk bed with two 85 × 188 cm singles, made up with 350-thread-count combed cotton linen. Each room has its own LCD TV, heating and air conditioning, bathroom with a separate shower area, and mini fridge. Water dispenser and shared fridge in the common area.

${SUITE_EN}`,
      ja: `2 部屋がつながったコネクティングルームで、合わせて約 66 m²。ご家族やグループでのご旅行に最適です。160 × 188 cm のダブルベッド 1 台と、85 × 188 cm のシングル 2 台の 2 段ベッドに 350 番手の高級コーマ綿リネンをご用意しています。各部屋に液晶テレビ、個別空調、洗い場を分けたバスルーム、小型冷蔵庫を備えています。共用スペースにはウォーターサーバーと共用冷蔵庫があります。

${SUITE_JA}`,
      ko: `두 객실이 연결된 커넥팅룸으로 합계 약 66㎡이며, 가족이나 일행 여행에 알맞습니다. 160 × 188cm 더블 침대 1개와 85 × 188cm 싱글 2개로 된 2층 침대에 350수 고급 코마 면 침구가 준비되어 있습니다. 각 객실마다 LCD TV, 개별 냉난방, 건식·습식 구역이 분리된 욕실, 소형 냉장고가 있습니다. 공용 공간에 정수기와 공용 냉장고가 있습니다.

${SUITE_KO}`,
    },
  },
};
