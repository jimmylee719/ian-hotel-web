/**
 * FAQs (old site qa.php). zh-TW is the old site's text, lightly edited; the old /en/qa.php carried
 * the Chinese text, so en, ja and ko are machine translations (listed in messages/_review.md).
 * Keys are the scrape slugs `qa-<category>-<n>`.
 */
import type { I18n } from "@/lib/db/schema";

type Faq = { title: I18n; body: I18n };
const f = (title: I18n, body: I18n): Faq => ({ title, body });

export const faqText: Record<string, Faq> = {
  "qa-8-1": f(
    { "zh-TW": "訂房後可以取消或更改嗎？", en: "Can I cancel or change my booking?", ja: "予約のキャンセルや変更はできますか？", ko: "예약을 취소하거나 변경할 수 있나요?" },
    {
      "zh-TW": `可以，取消與更改依以下規定辦理：
- 入住日前 3 天（含）以前：免費更改或取消。例如 5/10 入住，5/7 提出取消，不收費用。
- 入住日前 1 至 2 天：收取第一晚房費 50% 作為取消費。例如 5/10 入住，5/8 至 5/9 提出取消。
- 入住當天取消或未抵達：收取第一晚全額房費。

在官網直接訂房，請以訂房確認信上的取消條款為準。`,
      en: `Yes. Cancellations and changes follow these rules:
- 3 or more days before check-in: free. For a 10 May check-in, cancelling on 7 May costs nothing.
- 1 to 2 days before check-in: 50% of the first night. For a 10 May check-in, cancelling on 8 or 9 May.
- On the day of check-in, or no-show: the full first night.

For bookings made on this website, the cancellation terms in your confirmation email apply.`,
      ja: `はい。キャンセル・変更は次の規定に従います。
- チェックイン 3 日前まで：無料。例：5 月 10 日チェックインの場合、5 月 7 日までのキャンセルは無料です。
- チェックイン 1〜2 日前：1 泊目の宿泊料金の 50%。例：5 月 8 日〜9 日のキャンセル。
- チェックイン当日のキャンセル、または不泊：1 泊目の宿泊料金の 100%。

当サイトでご予約の場合は、予約確認メールに記載のキャンセル規定が適用されます。`,
      ko: `네. 취소 및 변경은 다음 규정에 따릅니다.
- 체크인 3일 전까지: 무료. 예: 5월 10일 체크인이라면 5월 7일까지 취소 시 수수료가 없습니다.
- 체크인 1~2일 전: 첫날 숙박 요금의 50%. 예: 5월 8~9일 취소.
- 체크인 당일 취소 또는 노쇼: 첫날 숙박 요금 전액.

이 웹사이트에서 예약하신 경우 예약 확인 메일에 적힌 취소 규정이 적용됩니다.`,
    },
  ),
  "qa-8-2": f(
    { "zh-TW": "可以用哪些方式付款？可以刷國民旅遊卡嗎？", en: "How can I pay? Do you accept the National Travel Card?", ja: "支払い方法は？国民旅遊カードは使えますか？", ko: "어떤 결제 수단을 쓸 수 있나요? 국민여행카드도 되나요?" },
    {
      "zh-TW": "可以。我們接受匯款、刷卡與第三方支付：國民旅遊卡、Mastercard、VISA、JCB、銀聯卡、美國運通、支付寶、Apple Pay、LINE Pay、街口支付。",
      en: "Yes. We accept bank transfer, cards and mobile payments: the National Travel Card, Mastercard, VISA, JCB, UnionPay, American Express, Alipay, Apple Pay, LINE Pay and JKOPAY.",
      ja: "はい。銀行振込、クレジットカード、モバイル決済に対応しています：国民旅遊カード、Mastercard、VISA、JCB、銀聯カード、American Express、Alipay、Apple Pay、LINE Pay、街口支付（JKOPAY）。",
      ko: "네. 계좌이체, 카드, 모바일 결제를 받습니다: 국민여행카드, Mastercard, VISA, JCB, 은련카드, American Express, Alipay, Apple Pay, LINE Pay, JKOPAY.",
    },
  ),
  "qa-8-3": f(
    { "zh-TW": "沒有信用卡怎麼辦？", en: "What if I don't have a credit card?", ja: "クレジットカードを持っていない場合は？", ko: "신용카드가 없으면 어떻게 하나요?" },
    {
      "zh-TW": "可以來電訂房。訂房完成後，我們會以簡訊告知匯款帳號，請在期限內匯入全額，並來電告知帳號末五碼；確認收款後即完成訂房。",
      en: "Book by phone. We will text you our bank details; transfer the full amount before the deadline and call us with the last five digits of your account. Your booking is confirmed once we receive the payment.",
      ja: "お電話でご予約ください。振込先を SMS でお知らせしますので、期限内に全額をお振り込みのうえ、口座番号の下 5 桁をお電話でお知らせください。入金確認後、ご予約が確定します。",
      ko: "전화로 예약해 주세요. 입금 계좌를 문자로 보내 드리니 기한 내에 전액을 입금하신 뒤 계좌번호 끝 5자리를 전화로 알려 주세요. 입금이 확인되면 예약이 확정됩니다.",
    },
  ),
  "qa-8-4": f(
    { "zh-TW": "訂房後會先扣款嗎？", en: "Will I be charged when I book?", ja: "予約時に料金は引き落とされますか？", ko: "예약할 때 바로 결제되나요?" },
    {
      "zh-TW": `透過訂房平台預訂者，我們會在入住前 10 天以您提供的信用卡做預先授權，作為訂房擔保，並不會實際扣款。入住當天可用同一張卡付款，也可改付現金或其他信用卡；改用其他方式付款時，預先授權會於當晚取消（台灣發卡銀行約 2 至 3 天、國外發卡銀行約 7 至 14 個工作天歸還額度）。

在官網直接訂房，則於訂房時以線上刷卡付清。`,
      en: `For bookings made through booking platforms, we pre-authorise the card you gave us 10 days before arrival to guarantee the booking; nothing is charged yet. On arrival you can pay with that card, in cash or with another card. If you pay another way, the pre-authorisation is released that evening (2 to 3 days for cards issued in Taiwan, 7 to 14 working days for cards issued abroad).

Bookings made on this website are paid in full online when you book.`,
      ja: `予約サイト経由のご予約は、ご到着の 10 日前にご登録のクレジットカードで仮売上（与信枠の確保）を行います。実際の請求ではありません。ご到着日はそのカード、現金、または別のカードでお支払いいただけます。別の方法でお支払いの場合、仮売上は当日夜に取り消されます（台湾発行のカードは 2〜3 日、海外発行のカードは 7〜14 営業日で枠が戻ります）。

当サイトでのご予約は、ご予約時にオンラインで全額お支払いいただきます。`,
      ko: `예약 사이트를 통한 예약은 도착 10일 전에 등록하신 신용카드로 가승인을 진행합니다. 실제 청구는 아닙니다. 체크인 당일 같은 카드, 현금 또는 다른 카드로 결제하실 수 있으며, 다른 수단으로 결제하시면 가승인은 당일 밤 취소됩니다(대만 발행 카드 2~3일, 해외 발행 카드 영업일 기준 7~14일 후 한도 복구).

이 웹사이트에서 예약하시면 예약 시 온라인으로 전액 결제됩니다.`,
    },
  ),
  "qa-8-5": f(
    { "zh-TW": "可以加床嗎？", en: "Can I add an extra bed?", ja: "エキストラベッドは追加できますか？", ko: "엑스트라 베드를 추가할 수 있나요?" },
    {
      "zh-TW": `經典雙人套房、景緻雙人套房、旅伴四人客房、六人行客房可加床，費用每人每晚 NT$700 起，含早餐。
迷你雙人套房空間有限，無法加床。加床數量有限，需要時請於訂房時一併告知。`,
      en: `Extra beds are available in the Classic Room, Deluxe Room, Buddy Room and Buddy Room for Six, from NT$700 per person per night, breakfast included.
The Mini Room is too small for an extra bed. Extra beds are limited, so please ask when you book.`,
      ja: `クラシックルーム、デラックスルーム、バディルーム、6 名様用バディルームでエキストラベッドをご利用いただけます。料金は 1 名様 1 泊 NT$700 から（朝食付き）です。
ミニルームは客室が狭いためご利用いただけません。台数に限りがありますので、ご予約時にお申し付けください。`,
      ko: `클래식룸, 디럭스룸, 버디룸, 6인 버디룸에서 엑스트라 베드를 이용하실 수 있으며, 요금은 1인 1박 NT$700부터(조식 포함)입니다.
미니룸은 공간이 좁아 엑스트라 베드를 놓을 수 없습니다. 수량이 한정되어 있으니 예약 시 함께 요청해 주세요.`,
    },
  ),
  "qa-8-6": f(
    { "zh-TW": "兒童入住有什麼規定？", en: "What is your policy for children?", ja: "お子様連れの宿泊について教えてください", ko: "어린이 투숙 규정은 어떻게 되나요?" },
    {
      "zh-TW": `歡迎親子同行。
需要加床時：7 歲（含）以上每人每晚 NT$600，7 歲以下每人每晚 NT$400。
不加床時：7 歲以下免費，可免費提供床墊（數量有限，請於訂房時告知）；7 歲（含）以上視同成人，不加床仍需支付 NT$500。
以上費用皆含早餐。`,
      en: `Families are welcome.
With an extra bed: NT$600 per child per night aged 7 and over, NT$400 under 7.
Without an extra bed: children under 7 stay free, and we can lend a floor mattress (limited, please ask when you book); children aged 7 and over count as adults and pay NT$500 even without a bed.
All prices include breakfast.`,
      ja: `お子様連れのご旅行も歓迎しております。
エキストラベッドをご利用の場合：7 歳以上は 1 名様 1 泊 NT$600、7 歳未満は NT$400。
ご利用にならない場合：7 歳未満は無料で、マットレスを無料でお貸しします（数に限りがあるため、ご予約時にお知らせください）。7 歳以上は大人と同じ扱いとなり、ベッドなしでも NT$500 を頂戴します。
いずれも朝食込みの料金です。`,
      ko: `아이와 함께하는 여행을 환영합니다.
엑스트라 베드 이용 시: 7세 이상 1인 1박 NT$600, 7세 미만 NT$400.
이용하지 않을 경우: 7세 미만은 무료이며 매트리스를 무료로 빌려 드립니다(수량 한정, 예약 시 알려 주세요). 7세 이상은 성인과 동일하게 침대 없이도 NT$500가 부과됩니다.
모든 요금에는 조식이 포함됩니다.`,
    },
  ),
  "qa-8-7": f(
    { "zh-TW": "兒童可以入住背包床位嗎？", en: "Can children stay in the capsule beds?", ja: "子どもはカプセルベッドに泊まれますか？", ko: "어린이도 캡슐 침대에 투숙할 수 있나요?" },
    {
      "zh-TW": `床位為多人共宿環境，僅接受 7 歲（含）以上兒童在成人陪同下入住，且須依人數預訂床位，不可與成人同睡一床。
有 7 歲以下兒童同行，建議改訂雙人套房或四人房。`,
      en: `The capsule beds are in shared dorms, so we accept children aged 7 and over only, accompanied by an adult, with one bed booked per person; children cannot share an adult's bed.
If you are travelling with a child under 7, please book a private double or four-person room instead.`,
      ja: `カプセルベッドは相部屋のため、7 歳以上のお子様で大人の同伴がある場合に限り、人数分のベッドをご予約のうえご宿泊いただけます。大人との添い寝はできません。
7 歳未満のお子様とご一緒の場合は、ダブルルームまたは 4 名様用客室をおすすめします。`,
      ko: `캡슐 침대는 다인실이므로 성인과 동반한 7세 이상 어린이만 인원수대로 침대를 예약하여 투숙할 수 있으며, 성인과 한 침대를 쓸 수 없습니다.
7세 미만 어린이와 함께라면 더블룸이나 4인실을 권해 드립니다.`,
    },
  ),
  "qa-7-1": f(
    { "zh-TW": "入住規定", en: "House rules", ja: "館内のご利用規則", ko: "이용 규칙" },
    {
      "zh-TW": `- 未滿 18 歲入住，請攜帶家長同意書（可向我們索取）。
- 為保持環境整潔，床位房內請勿飲食，僅可帶水。
- 晚上 11 點後請降低音量，顧及其他旅客的安寧。
- 全館禁菸，房內吸菸將收取 NT$3,000 至 NT$10,000 罰金；5 樓與 14 樓設有露臺吸菸區。
- 館內禁止攜帶寵物、嚼檳榔，嚴禁賭博、偷竊、吸毒及色情交易等違法行為。
- 請勿破壞或攜出館內設備，違者將報警處理並依法求償。`,
      en: `- Guests under 18 need a parental consent form (ask us for one).
- To keep the dorms clean, no food in dorm rooms; water only.
- Please keep noise down after 11 pm.
- No smoking anywhere indoors; smoking in a room incurs a fine of NT$3,000 to NT$10,000. Smoking terraces are on the 5th and 14th floors.
- No pets, no betel nut, and no gambling, theft, drugs, prostitution or other illegal activity.
- Do not damage or remove our furnishings; we will call the police and seek compensation.`,
      ja: `- 18 歳未満の方は保護者の同意書が必要です（当館でお渡しできます）。
- 清潔を保つため、ドミトリー客室内での飲食はご遠慮ください（お水のみ可）。
- 午後 11 時以降は他のお客様のためお静かにお願いします。
- 館内は全面禁煙です。客室内での喫煙には NT$3,000〜NT$10,000 の罰金を申し受けます。喫煙は 5 階・14 階のテラスでお願いします。
- ペットの同伴、ビンロウの持ち込み、賭博・窃盗・薬物・売買春などの違法行為は固くお断りします。
- 備品の破損・持ち出しは警察に通報のうえ、損害賠償を請求いたします。`,
      ko: `- 18세 미만은 보호자 동의서가 필요합니다(저희에게 요청해 주세요).
- 청결 유지를 위해 도미토리 객실 내 음식물 섭취는 금지되며 물만 가능합니다.
- 밤 11시 이후에는 다른 투숙객을 위해 조용히 해 주세요.
- 건물 전체 금연이며, 객실 내 흡연 시 NT$3,000~NT$10,000의 벌금이 부과됩니다. 흡연은 5층과 14층 테라스에서만 가능합니다.
- 반려동물 동반, 빈랑 반입, 도박·절도·마약·성매매 등 불법 행위를 금지합니다.
- 비품을 파손하거나 반출하면 경찰에 신고하고 법에 따라 배상을 청구합니다.`,
    },
  ),
  "qa-7-2": f(
    { "zh-TW": "入住時要付押金嗎？", en: "Is there a deposit at check-in?", ja: "チェックイン時にデポジットは必要ですか？", ko: "체크인 시 보증금이 있나요?" },
    {
      "zh-TW": "不用。房價已含稅金、服務費與清潔費，辦理入住時不收押金。",
      en: "No. Room rates include tax, service and cleaning, and we take no deposit at check-in.",
      ja: "不要です。宿泊料金には税金、サービス料、清掃料が含まれており、チェックイン時にデポジットはいただきません。",
      ko: "없습니다. 객실 요금에 세금, 봉사료, 청소비가 포함되어 있으며 체크인 시 보증금을 받지 않습니다.",
    },
  ),
  "qa-7-3": f(
    { "zh-TW": "入住與退房時間", en: "Check-in and check-out times", ja: "チェックイン・チェックアウトの時間", ko: "체크인·체크아웃 시간" },
    {
      "zh-TW": "入住時間：下午 3 點（15:00）起。退房時間：上午 11 點（11:00）前。",
      en: "Check-in from 3 pm (15:00). Check-out by 11 am (11:00).",
      ja: "チェックインは 15:00 から、チェックアウトは 11:00 までです。",
      ko: "체크인은 오후 3시(15:00)부터, 체크아웃은 오전 11시(11:00)까지입니다.",
    },
  ),
  "qa-7-4": f(
    { "zh-TW": "可以提早入住嗎？", en: "Can I check in early?", ja: "アーリーチェックインはできますか？", ko: "얼리 체크인이 가능한가요?" },
    {
      "zh-TW": "提早入住需視當天房況與清掃進度而定，並依房型另收費用。",
      en: "It depends on availability and housekeeping on the day, and there is a charge that depends on your room type.",
      ja: "当日の空室状況と清掃の進み具合によります。客室タイプに応じて追加料金を頂戴します。",
      ko: "당일 객실 상황과 청소 진행에 따라 가능하며, 객실 타입에 따라 추가 요금이 있습니다.",
    },
  ),
  "qa-7-5": f(
    { "zh-TW": "有提供早餐嗎？", en: "Is breakfast included?", ja: "朝食はありますか？", ko: "조식이 제공되나요?" },
    {
      "zh-TW": "各房型皆提供早餐。",
      en: "Yes, breakfast is included with every room type.",
      ja: "すべての客室タイプに朝食が付いています。",
      ko: "모든 객실 타입에 조식이 포함되어 있습니다.",
    },
  ),
  "qa-7-6": f(
    { "zh-TW": "有每日打掃服務嗎？", en: "Do you clean the rooms daily?", ja: "毎日の清掃はありますか？", ko: "매일 청소해 주나요?" },
    {
      "zh-TW": `為減少能源浪費與環境污染，續住期間不主動打掃。
床位旅客：不更換床單、被套與毛巾，如需更換，酌收 NT$100。
套房旅客：住滿一週可免費更換一次床單；需要打掃時，請於每日下午 4 點前將打掃牌掛在門外。`,
      en: `To save energy and reduce waste, we do not clean during your stay unless you ask.
Capsule guests: sheets, duvet covers and towels are not changed; we can change them for NT$100.
Room guests: sheets are changed free once a week; for cleaning, hang the sign on your door before 4 pm.`,
      ja: `省エネと環境保護のため、連泊中の清掃はご希望の場合のみ行います。
カプセルのお客様：シーツ、布団カバー、タオルの交換はありません。ご希望の場合は NT$100 で交換いたします。
客室のお客様：1 週間以上のご滞在でシーツを 1 回無料で交換します。清掃をご希望の場合は、毎日 16 時までにドアの外に清掃カードを掛けてください。`,
      ko: `에너지 절약과 환경 보호를 위해 연박 중에는 요청 시에만 청소합니다.
캡슐 투숙객: 시트, 이불 커버, 수건은 교체하지 않으며, 원하시면 NT$100에 교체해 드립니다.
객실 투숙객: 1주일 이상 투숙 시 시트를 1회 무료로 교체해 드립니다. 청소를 원하시면 매일 오후 4시 전까지 문밖에 청소 카드를 걸어 주세요.`,
    },
  ),
  "qa-7-7": f(
    { "zh-TW": "可以寄放行李嗎？", en: "Can I leave my luggage?", ja: "荷物を預けられますか？", ko: "짐을 맡길 수 있나요?" },
    {
      "zh-TW": "可以。入住前與退房後當天可免費寄放行李，請告知櫃台人員。",
      en: "Yes. We store luggage free on your arrival and departure days; just ask at the front desk.",
      ja: "はい。チェックイン前とチェックアウト後の当日に限り、無料でお預かりします。フロントにお申し付けください。",
      ko: "네. 체크인 전과 체크아웃 후 당일에 한해 무료로 보관해 드립니다. 프런트에 말씀해 주세요.",
    },
  ),
  "qa-6-1": f(
    { "zh-TW": "可以延後退房嗎？", en: "Can I check out late?", ja: "レイトチェックアウトはできますか？", ko: "레이트 체크아웃이 가능한가요?" },
    {
      "zh-TW": `退房時間為上午 11 點，最晚可延至下午 2 點，並依房型另收費用：房間每小時 NT$400，床位每小時 NT$100（是否提供由我們視當天狀況決定）。
退房時請至櫃台繳回房卡，遺失房卡酌收製卡費 NT$300。`,
      en: `Check-out is at 11 am and can be extended to 2 pm at the latest, for NT$400 per hour for a room or NT$100 per hour for a capsule (subject to availability on the day).
Please return your key card at the front desk; a lost card costs NT$300.`,
      ja: `チェックアウトは 11:00 で、最長 14:00 まで延長できます。料金は客室 1 時間 NT$400、カプセル 1 時間 NT$100 です（当日の状況によりお受けできない場合があります）。
チェックアウト時はフロントにカードキーをご返却ください。紛失の場合は再発行料 NT$300 を頂戴します。`,
      ko: `체크아웃은 오전 11시이며 최대 오후 2시까지 연장할 수 있습니다. 요금은 객실 시간당 NT$400, 캡슐 시간당 NT$100입니다(당일 상황에 따라 어려울 수 있습니다).
체크아웃 시 프런트에 카드 키를 반납해 주세요. 분실 시 NT$300의 재발급 비용이 있습니다.`,
    },
  ),
  "qa-5-1": f(
    { "zh-TW": "什麼是公共衛浴？", en: "What are the shared bathrooms like?", ja: "共用バスルームはどのようなものですか？", ko: "공용 욕실은 어떤가요?" },
    {
      "zh-TW": `混合與女性雙人旅艙、旅伴四人客房、六人行客房的衛浴在客房外，由同樓層旅客共用。
男女分開，設有乾濕分離的更衣空間與花灑淋浴區，備有沐浴乳、洗髮乳、潤髮乳、TOTO 免治馬桶、吹風機與盥洗區。
床位不主動提供牙刷、漱口杯等備品，需要時請向櫃台詢問。`,
      en: `The capsules, Buddy Room and Buddy Room for Six use bathrooms outside the room, shared by guests on the same floor.
They are separate for men and women, with a dry changing area and rain showers, body wash, shampoo, conditioner, TOTO washlet toilets, hair dryers and wash basins.
Toothbrushes and cups are not provided for capsule guests unless you ask at the front desk.`,
      ja: `カプセル、バディルーム、6 名様用バディルームは客室外のバスルームを同じフロアのお客様と共用します。
男女別で、脱衣スペースとレインシャワーを分けた造りです。ボディソープ、シャンプー、コンディショナー、TOTO 温水洗浄便座、ドライヤー、洗面台を備えています。
カプセルのお客様には歯ブラシやコップはお渡ししていません。必要な方はフロントにお尋ねください。`,
      ko: `캡슐, 버디룸, 6인 버디룸은 객실 밖 욕실을 같은 층 투숙객과 함께 사용합니다.
남녀가 분리되어 있고 탈의 공간과 레인 샤워 구역이 나뉘어 있으며, 바디워시, 샴푸, 컨디셔너, TOTO 비데, 헤어드라이어, 세면대를 갖추고 있습니다.
캡슐 투숙객에게는 칫솔과 컵을 기본 제공하지 않으니 필요하시면 프런트에 문의해 주세요.`,
    },
  ),
  "qa-5-2": f(
    { "zh-TW": "還有哪些額外服務？", en: "What other services do you offer?", ja: "その他のサービスはありますか？", ko: "그 밖에 어떤 서비스가 있나요?" },
    {
      "zh-TW": `- 代叫宅配與計程車、機場與旅遊接送
- 飲品點心代售、伴手禮代購
- 傳真與影印、電風扇、手機充電線
- 單車租借、熨斗與燙衣板
- 兒童用品：兒童澡盆、奶瓶消毒鍋、床圍、兒童床墊、兒童高腳椅（數量有限，請於訂房時告知）`,
      en: `- Courier and taxi booking, airport and sightseeing transfers
- Drinks and snacks for sale, souvenir shopping service
- Fax and photocopying, electric fans, phone charging cables
- Bicycle rental, iron and ironing board
- For children: baby bath, bottle steriliser, bed rail, child mattress and high chair (limited, please ask when you book)`,
      ja: `- 宅配便・タクシーの手配、空港送迎・観光送迎
- 飲み物・軽食の販売、お土産の購入代行
- FAX・コピー、扇風機、スマートフォン充電ケーブル
- レンタサイクル、アイロン・アイロン台
- お子様用品：ベビーバス、哺乳瓶消毒器、ベッドガード、子ども用マットレス、ハイチェア（数に限りがあるため、ご予約時にお知らせください）`,
      ko: `- 택배·택시 호출, 공항 및 관광 픽업
- 음료·간식 판매, 기념품 구매 대행
- 팩스·복사, 선풍기, 휴대폰 충전 케이블
- 자전거 대여, 다리미·다리미판
- 유아용품: 아기 욕조, 젖병 소독기, 침대 가드, 어린이 매트리스, 하이체어(수량 한정, 예약 시 알려 주세요)`,
    },
  ),
  "qa-5-3": f(
    { "zh-TW": "有提供機場接送嗎？", en: "Do you offer airport transfers?", ja: "空港送迎はありますか？", ko: "공항 픽업이 있나요?" },
    {
      "zh-TW": "有，請參考「交通資訊」頁面的接機服務。",
      en: "Yes. See the pick-up service on the Getting here page.",
      ja: "はい。「アクセス」ページの送迎サービスをご覧ください。",
      ko: "네. '오시는 길' 페이지의 픽업 서비스를 참고해 주세요.",
    },
  ),
};
