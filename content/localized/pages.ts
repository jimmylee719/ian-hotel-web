/**
 * Content pages. facilities / access / attractions / groups are edited down from the old site
 * (amenities.php, location.php, attractions.php, group.php, group2.php); privacy and booking-terms
 * are new drafts (the old site had neither). See messages/_review.md for what is machine-translated
 * and what needs the owner's sign-off.
 *
 * Body format: plain text, blank line between paragraphs, "## " for a heading, "- " for a list item.
 */
import type { I18n } from "@/lib/db/schema";

type Page = { title: I18n; body: I18n };

export const pageText: Record<string, Page> = {
  facilities: {
    title: { "zh-TW": "公共空間", en: "Shared spaces", ja: "共用スペース", ko: "공용 공간" },
    body: {
      "zh-TW": `## 5 樓
公共露臺：小花園種滿綠色植物。本館全面禁菸，吸菸請到這裡。

交誼廳：
- 24 小時服務櫃台
- 免費桌上型電腦
- NK BAR：現煮咖啡、啤酒與冷飲（付費）
- 閱讀區：文學小說、雜誌與旅遊資訊
- 55 吋液晶電視、沙發與用餐桌椅

共用廚房：開放式廚房，免費使用微波爐、烤箱、冰箱、電磁爐與鍋具，另有冷熱飲水機、茶包、糖包與奶精。

## 8 樓（僅限 8 樓住客）
交誼廳：沙發區、書架與旅遊資訊，可向櫃台預約使用投影機。

吧台區：冰箱、微波爐、冷熱飲水機；長桌可坐 10 至 12 人，開會、聊天、聚餐都合適。

自助洗衣房：
- 洗衣機 3 台，每次 NT$40
- 烘衣機 2 台，每 40 分鐘 NT$50
- 洗衣精每包 NT$10
- 洗衣袋、洗衣籃與手洗水槽

## 14 樓
頂樓露臺與花園，可遠眺城市景色；限景緻與經典雙人套房住客使用，吸菸請在此區。`,
      en: `## 5th floor
Terrace: a small garden full of plants. The building is non-smoking; this is where smokers can go.

Lounge:
- Front desk open 24 hours
- Free desktop computers
- NK BAR: fresh coffee, beer and soft drinks (paid)
- Reading corner with novels, magazines and travel information
- 55 inch TV, sofas and dining tables

Shared kitchen: an open kitchen with a free microwave, oven, fridge, induction hob and cookware, plus a hot and cold water dispenser, tea, sugar and creamer.

## 8th floor (8th-floor guests only)
Lounge: sofas, bookshelves and travel information. A projector can be booked at the front desk.

Bar table: fridge, microwave and water dispenser; the long table seats 10 to 12 for meetings, chats or dinner.

Self-service laundry:
- 3 washing machines, NT$40 a load
- 2 dryers, NT$50 per 40 minutes
- Detergent NT$10 a sachet
- Laundry bags, baskets and a hand-wash sink

## 14th floor
Rooftop terrace and garden with views over the city, for Deluxe and Classic Room guests. Smoking is allowed here.`,
      ja: `## 5 階
テラス：緑あふれる小さな庭です。館内は全面禁煙のため、喫煙はこちらでお願いします。

ラウンジ：
- 24 時間対応のフロント
- 無料のデスクトップパソコン
- NK BAR：淹れたてのコーヒー、ビール、ソフトドリンク（有料）
- 小説、雑誌、旅行情報をそろえた読書コーナー
- 55 インチテレビ、ソファ、ダイニングテーブル

共用キッチン：オープンキッチンで、電子レンジ、オーブン、冷蔵庫、IH コンロ、調理器具を無料でご利用いただけます。ウォーターサーバー、ティーバッグ、砂糖、ミルクもございます。

## 8 階（8 階にご宿泊のお客様専用）
ラウンジ：ソファ、本棚、旅行情報。プロジェクターはフロントでご予約いただけます。

バーテーブル：冷蔵庫、電子レンジ、ウォーターサーバー。10〜12 名様が座れる長テーブルは、打ち合わせや食事に最適です。

セルフランドリー：
- 洗濯機 3 台、1 回 NT$40
- 乾燥機 2 台、40 分 NT$50
- 洗剤 1 包 NT$10
- ランドリーバッグ、かご、手洗い用シンク

## 14 階
街を見渡せる屋上テラスとガーデン。デラックスルームとクラシックルームのお客様専用で、喫煙もこちらで可能です。`,
      ko: `## 5층
테라스: 초록 식물이 가득한 작은 정원입니다. 건물 전체가 금연이라 흡연은 이곳에서 해 주세요.

라운지:
- 24시간 프런트
- 무료 데스크톱 컴퓨터
- NK BAR: 갓 내린 커피, 맥주, 음료(유료)
- 소설, 잡지, 여행 정보가 있는 독서 공간
- 55인치 TV, 소파, 식탁

공용 주방: 오픈 키친으로 전자레인지, 오븐, 냉장고, 인덕션, 조리도구를 무료로 쓸 수 있으며 냉온수기, 티백, 설탕, 크리머도 있습니다.

## 8층(8층 투숙객 전용)
라운지: 소파, 책장, 여행 정보가 있으며 프로젝터는 프런트에서 예약할 수 있습니다.

바 테이블: 냉장고, 전자레인지, 냉온수기가 있고, 10~12명이 앉는 긴 테이블은 회의나 식사에 좋습니다.

셀프 세탁실:
- 세탁기 3대, 1회 NT$40
- 건조기 2대, 40분 NT$50
- 세제 1포 NT$10
- 세탁 가방, 바구니, 손빨래용 싱크대

## 14층
도시 전망을 즐길 수 있는 옥상 테라스와 정원으로, 디럭스룸과 클래식룸 투숙객 전용입니다. 이곳에서 흡연할 수 있습니다.`,
    },
  },

  access: {
    title: { "zh-TW": "交通資訊", en: "Getting here", ja: "アクセス", ko: "오시는 길" },
    body: {
      "zh-TW": `小公館位於台北市松山區南京東路五段 399 號「南京商務大樓」5 樓，請搭電梯至 5 樓櫃台。

## 捷運
搭松山新店線（綠線）至 G18 南京三民站，4 號出口出站左轉直行約 8 至 10 分鐘，到 399 號即看到小公館招牌。

## 公車
- 南松山（南京）站，就在樓下與對面：53、204、248、306、307、668、711，可直達松山車站、南港、內湖、東區、小巨蛋、中山站。
- 南松山（塔悠）站，在大樓側邊：63、286、286 副、307、棕 1、藍 27、民生幹線，可直達松山車站、民生社區、松山機場。下車後走到南京東路五段路口，約 30 秒即到大樓門口。

## 台鐵與高鐵
- 松山車站：出站往西門出口（松山路、虎林街），搭 63、204、306、668、711、民生幹線或棕 1 至南松山站下車；或在 B1 搭計程車，約 5 分鐘。步行約 15 分鐘：松山路右轉，八德路四段左轉，塔悠路右轉直行即到。
- 台北車站：轉搭台鐵一站到松山車站（約 6 至 8 分鐘），或搭捷運淡水信義線到中山站，再轉松山新店線到南京三民站；也可在新光三越站前店前的「台北車站（忠孝）」站牌搭 307 公車到南松山（南京）站，約 30 至 40 分鐘。
- 高鐵：台北站下車後轉台鐵到松山車站，或在南港站下車，再依上述方式前往。

## 桃園機場
- 機場捷運：搭到台北車站，沿地下通道步行 5 至 7 分鐘到捷運北門站，搭松山新店線到南京三民站 4 號出口。行李多的旅客可走有電梯的 1 號出口，步行約 10 至 15 分鐘。
- 機場巴士：
  - 長榮 5201 到南京復興站，轉搭 46、306、307、668、711 公車到南松山（南京）站，或轉捷運到南京三民站。
  - 大有 1960 到市府轉運站，轉搭藍 27 公車到南松山（塔悠）站。
  - 國光 1840 到松山機場，轉搭棕 1 公車到南松山（塔悠）站。
  - 國光 1819（24 小時）到台北車站，再依台北車站的方式前往。

## 松山機場
- 計程車：C 或 D 門出口右轉即有排班計程車，約 3.5 公里、10 分鐘。
- 捷運：C 門出口左轉進 1 號出口，搭文湖線到南京復興站，轉松山新店線到南京三民站，約 13 分鐘。
- 公車：C 門出口過馬路左轉到 1、2 號候車亭，搭棕 1 到南松山（塔悠）站，約 20 至 30 分鐘。

## 機場接送
小公館提供 24 小時機場接機與送機（出關處舉名牌迎接），每趟單程：
- 1 至 4 人 NT$1,600
- 5 至 8 人 NT$2,000

預約時請告知姓名、電話、抵達日期與時間、航班號碼、人數（嬰兒與兒童也算一位）與行李件數。另有一日遊包車服務，歡迎洽詢。

## 停車
- 本棟大樓 B2 機械式車位：每晚 NT$300，不限進出，可停到隔日 11 點退房。僅接受預約，數量有限，請先向櫃台預約，停車費直接付給大樓管理員。車輛限制：長 4,795、寬 1,800、高 1,750 公釐以內。
- 附近另有塔悠路 81 號、八德路四段 453 巷、塔悠路 36 號、八德路四段 580 號等收費停車場，步行 2 至 5 分鐘，收費以現場公告為準。`,
      en: `NK Hostel is on the 5th floor of the Nanjing Business Building, No. 399, Sec. 5, Nanjing E. Rd, Songshan District, Taipei. Take the lift to the 5th-floor front desk.

## MRT
Take the Songshan-Xindian line (green) to G18 Nanjing Sanmin. From exit 4, turn left and walk straight for 8 to 10 minutes to No. 399, where you will see our sign.

## Bus
- Nansongshan (Nanjing) stop, right outside and across the road: buses 53, 204, 248, 306, 307, 668 and 711 go to Songshan Station, Nangang, Neihu, the East District, Taipei Arena and Zhongshan.
- Nansongshan (Tayou) stop, beside the building: buses 63, 286, 286 Shuttle, 307, Brown 1, Blue 27 and Minsheng Main Line go to Songshan Station, Minsheng Community and Songshan Airport. Walk to the Nanjing E. Rd Sec. 5 junction; the entrance is 30 seconds away.

## Train and high-speed rail
- Songshan Station: leave by the west exit (Songshan Rd / Hulin St) and take bus 63, 204, 306, 668, 711, Minsheng Main Line or Brown 1 to a Nansongshan stop, or take a taxi from B1 (about 5 minutes). On foot it is about 15 minutes: right on Songshan Rd, left on Bade Rd Sec. 4, right on Tayou Rd and straight on.
- Taipei Main Station: take a TRA train one stop to Songshan (6 to 8 minutes), or the MRT Tamsui-Xinyi line to Zhongshan and change to the Songshan-Xindian line for Nanjing Sanmin. Bus 307 from the "Taipei Main Station (Zhongxiao)" stop in front of Shin Kong Mitsukoshi goes to Nansongshan (Nanjing) in 30 to 40 minutes.
- High-speed rail: get off at Taipei and change to a TRA train for Songshan, or get off at Nangang and continue as above.

## Taoyuan International Airport
- Airport MRT: ride to Taipei Main Station, follow the underground walkway for 5 to 7 minutes to MRT Beimen, then take the Songshan-Xindian line to Nanjing Sanmin, exit 4. With heavy luggage use exit 1, which has a lift (10 to 15 minutes' walk).
- Airport buses:
  - Evergreen 5201 to Nanjing Fuxing, then bus 46, 306, 307, 668 or 711 to Nansongshan (Nanjing), or the MRT to Nanjing Sanmin.
  - Dayou 1960 to Taipei City Hall Bus Station, then bus Blue 27 to Nansongshan (Tayou).
  - Kuo-Kuang 1840 to Songshan Airport, then bus Brown 1 to Nansongshan (Tayou).
  - Kuo-Kuang 1819 (24 hours) to Taipei Main Station, then as above.

## Songshan Airport
- Taxi: turn right out of gate C or D to the taxi rank; about 3.5 km, 10 minutes.
- MRT: turn left out of gate C to MRT exit 1, take the Wenhu line to Nanjing Fuxing and change to the Songshan-Xindian line for Nanjing Sanmin; about 13 minutes.
- Bus: from gate C cross the road and turn left to shelters 1 and 2, then take Brown 1 to Nansongshan (Tayou); 20 to 30 minutes.

## Airport transfers
We run airport pick-ups and drop-offs around the clock (we meet you at arrivals with a name sign). One way:
- 1 to 4 people NT$1,600
- 5 to 8 people NT$2,000

To book, send your name, phone number, arrival date and time, flight number, number of passengers (infants and children count) and number of bags. Day tours by private car are also available; just ask.

## Parking
- Mechanical parking on B2 of our building: NT$300 a night with unlimited exits, until 11 am check-out. By reservation only and spaces are limited, so book at the front desk first; pay the building manager directly. Vehicles up to 4,795 mm long, 1,800 mm wide and 1,750 mm high.
- Public car parks at Tayou Rd No. 81, Lane 453 Bade Rd Sec. 4, Tayou Rd No. 36 and Bade Rd Sec. 4 No. 580 are 2 to 5 minutes' walk away; charges as posted on site.`,
      ja: `小公館は台北市松山区南京東路五段 399 号「南京商務ビル」の 5 階にあります。エレベーターで 5 階フロントへお越しください。

## MRT
松山新店線（緑線）G18 南京三民駅で下車。4 番出口を出て左へ 8〜10 分ほど直進すると、399 号に当館の看板が見えます。

## バス
- 南松山（南京）バス停（ビルの前と向かい側）：53、204、248、306、307、668、711 番。松山駅、南港、内湖、東区、台北アリーナ、中山駅へ直通です。
- 南松山（塔悠）バス停（ビルの横）：63、286、286 副、307、棕 1、藍 27、民生幹線。松山駅、民生コミュニティ、松山空港へ直通です。下車後、南京東路五段の交差点まで歩けば 30 秒ほどでビルの入口です。

## 台湾鉄道・高速鉄道
- 松山駅：西口（松山路・虎林街方面）を出て、63、204、306、668、711、民生幹線、棕 1 番のバスで南松山バス停へ。B1 のタクシー乗り場からは約 5 分です。徒歩の場合は約 15 分：松山路を右へ、八徳路四段を左へ、塔悠路を右に曲がって直進します。
- 台北駅：台湾鉄道で一駅の松山駅へ（6〜8 分）。または MRT 淡水信義線で中山駅へ行き、松山新店線に乗り換えて南京三民駅へ。新光三越駅前店前の「台北車站（忠孝）」バス停から 307 番バスで南松山（南京）まで 30〜40 分です。
- 高速鉄道：台北駅で台湾鉄道に乗り換えて松山駅へ、または南港駅で下車し、上記の方法でお越しください。

## 桃園国際空港
- 空港 MRT：台北駅まで乗車し、地下通路を 5〜7 分歩いて MRT 北門駅へ。松山新店線で南京三民駅 4 番出口へ。お荷物が多い方はエレベーターのある 1 番出口が便利です（徒歩 10〜15 分）。
- 空港バス：
  - 長栄 5201 番で南京復興駅へ。46、306、307、668、711 番バスで南松山（南京）へ、または MRT で南京三民駅へ。
  - 大有 1960 番で市府バスターミナルへ。藍 27 番バスで南松山（塔悠）へ。
  - 国光 1840 番で松山空港へ。棕 1 番バスで南松山（塔悠）へ。
  - 国光 1819 番（24 時間運行）で台北駅へ。以降は台北駅からの方法と同じです。

## 松山空港
- タクシー：C または D 出口を出て右手のタクシー乗り場から約 3.5 km、10 分です。
- MRT：C 出口を出て左の MRT 1 番出口から文湖線で南京復興駅へ、松山新店線に乗り換えて南京三民駅へ。約 13 分です。
- バス：C 出口を出て道路を渡り、左手の 1・2 番乗り場から棕 1 番バスで南松山（塔悠）へ。20〜30 分です。

## 空港送迎
24 時間、空港への送迎を承ります（到着ロビーでお名前を掲げてお待ちします）。片道料金：
- 1〜4 名様 NT$1,600
- 5〜8 名様 NT$2,000

ご予約の際は、お名前、電話番号、到着日時、便名、人数（乳幼児・お子様も 1 名として）、お荷物の数をお知らせください。貸切車での日帰りツアーもご相談ください。

## 駐車場
- 当ビル B2 の機械式駐車場：1 泊 NT$300、出入り自由、翌日 11:00 のチェックアウトまで。予約制で台数に限りがあるため、事前にフロントへご予約ください。料金はビル管理人に直接お支払いください。車両制限は全長 4,795 mm、全幅 1,800 mm、全高 1,750 mm までです。
- 塔悠路 81 号、八徳路四段 453 巷、塔悠路 36 号、八徳路四段 580 号などに有料駐車場があります（徒歩 2〜5 分、料金は現地の表示に従います）。`,
      ko: `소공관은 타이베이시 쑹산구 난징동로 5단 399호 '난징상무빌딩' 5층에 있습니다. 엘리베이터를 타고 5층 프런트로 오세요.

## MRT
쑹산신뎬선(초록선) G18 난징싼민역에서 내려 4번 출구로 나와 왼쪽으로 8~10분 직진하면 399호에 소공관 간판이 보입니다.

## 버스
- 난쑹산(난징) 정류장(건물 앞과 맞은편): 53, 204, 248, 306, 307, 668, 711번. 쑹산역, 난강, 네이후, 둥취, 타이베이 아레나, 중산역으로 바로 갑니다.
- 난쑹산(타유) 정류장(건물 옆): 63, 286, 286 부선, 307, 갈색 1, 파랑 27, 민성간선. 쑹산역, 민성 커뮤니티, 쑹산공항으로 바로 갑니다. 내려서 난징동로 5단 교차로 쪽으로 걸으면 30초 만에 건물 입구입니다.

## 기차·고속철도
- 쑹산역: 서쪽 출구(쑹산로·후린가)로 나와 63, 204, 306, 668, 711, 민성간선, 갈색 1번 버스로 난쑹산 정류장까지 오시거나, B1 택시 승강장에서 택시로 약 5분입니다. 걸어서는 약 15분: 쑹산로에서 우회전, 바더로 4단에서 좌회전, 타유로에서 우회전해 직진합니다.
- 타이베이역: 대만철도로 한 정거장인 쑹산역(6~8분)으로 가거나, MRT 단수이신이선으로 중산역에서 쑹산신뎬선으로 갈아타 난징싼민역으로 오세요. 신광미쓰코시 역전점 앞 '타이베이역(중샤오)' 정류장에서 307번 버스를 타면 난쑹산(난징)까지 30~40분입니다.
- 고속철도: 타이베이역에서 대만철도로 갈아타 쑹산역으로 가거나, 난강역에서 내려 위 방법으로 오세요.

## 타오위안 국제공항
- 공항 MRT: 타이베이역까지 간 뒤 지하 통로를 5~7분 걸어 MRT 베이먼역에서 쑹산신뎬선을 타고 난징싼민역 4번 출구로 나오세요. 짐이 많으면 엘리베이터가 있는 1번 출구가 편합니다(도보 10~15분).
- 공항버스:
  - 에버그린 5201번으로 난징푸싱역 하차 후 46, 306, 307, 668, 711번 버스로 난쑹산(난징), 또는 MRT로 난징싼민역.
  - 다유 1960번으로 시청 버스터미널 하차 후 파랑 27번 버스로 난쑹산(타유).
  - 궈광 1840번으로 쑹산공항 하차 후 갈색 1번 버스로 난쑹산(타유).
  - 궈광 1819번(24시간)으로 타이베이역 하차 후 위 방법과 같습니다.

## 쑹산공항
- 택시: C 또는 D 출구로 나와 오른쪽 택시 승강장에서 약 3.5km, 10분입니다.
- MRT: C 출구로 나와 왼쪽 MRT 1번 출구에서 원후선으로 난징푸싱역, 쑹산신뎬선으로 갈아타 난징싼민역까지 약 13분입니다.
- 버스: C 출구에서 길을 건너 왼쪽 1·2번 승강장에서 갈색 1번 버스로 난쑹산(타유)까지 20~30분입니다.

## 공항 픽업
24시간 공항 픽업·샌딩 서비스를 운영합니다(입국장에서 이름판을 들고 기다립니다). 편도 요금:
- 1~4명 NT$1,600
- 5~8명 NT$2,000

예약 시 성함, 전화번호, 도착 날짜와 시간, 항공편명, 인원(유아·어린이 포함), 짐 개수를 알려 주세요. 전용 차량 일일 투어도 문의해 주세요.

## 주차
- 건물 B2 기계식 주차장: 1박 NT$300, 출입 자유, 다음 날 오전 11시 체크아웃까지. 예약제이며 자리가 한정되어 있으니 프런트에 미리 예약해 주시고, 요금은 건물 관리인에게 직접 내 주세요. 차량 제한: 길이 4,795mm, 너비 1,800mm, 높이 1,750mm 이하.
- 타유로 81호, 바더로 4단 453항, 타유로 36호, 바더로 4단 580호 등에 유료 주차장이 있습니다(도보 2~5분, 요금은 현장 안내 기준).`,
    },
  },

  attractions: {
    title: { "zh-TW": "周邊景點", en: "Nearby", ja: "周辺の観光スポット", ko: "주변 명소" },
    body: {
      "zh-TW": `## 饒河街觀光夜市
步行約 5 分鐘。入口就在松山慈祐宮旁，從胡椒餅到藥燉排骨，一路吃到底。

## 松山慈祐宮
饒河街口的百年媽祖廟，香火鼎盛，夜裡的燈火特別好看。

## 觀山與彩虹河濱公園
沿著基隆河散步或騎單車，傍晚看彩虹橋亮燈。

## 台北小巨蛋
演唱會與運動賽事的主要場館，搭捷運松山新店線兩站即到。

## 台北 101 與國父紀念館
信義區的地標與綠地，搭公車或計程車約 15 分鐘。

## 象山
從象山步道往上走約 20 分鐘，就能看到最經典的台北 101 夜景。

周邊另有銀行、電信門市、穆斯林友善餐廳與親子遊樂場，可向櫃台索取地圖。`,
      en: `## Raohe Street Night Market
About 5 minutes' walk. The gate is beside Songshan Ciyou Temple; eat your way from pepper buns to herbal pork-rib soup.

## Songshan Ciyou Temple
A centuries-old Mazu temple at the head of Raohe Street, at its most beautiful when lit up at night.

## GuanShan and Rainbow River Parks
Walk or cycle along the Keelung River and watch the Rainbow Bridge light up at dusk.

## Taipei Arena
The city's main venue for concerts and sport, two stops away on the Songshan-Xindian line.

## Taipei 101 and Sun Yat-sen Memorial Hall
The Xinyi District landmark and its park, about 15 minutes by bus or taxi.

## Elephant Mountain
A 20-minute climb up the trail gives the classic night view of Taipei 101.

Banks, mobile phone shops, Muslim-friendly restaurants and playgrounds are all nearby; ask the front desk for a map.`,
      ja: `## 饒河街観光夜市
徒歩約 5 分。入口は松山慈祐宮のすぐ横で、胡椒餅から薬膳スペアリブスープまで食べ歩きが楽しめます。

## 松山慈祐宮
饒河街の入口に建つ歴史ある媽祖廟。夜のライトアップは格別です。

## 観山・彩虹河浜公園
基隆河沿いを散歩やサイクリングで。夕暮れには虹橋が灯ります。

## 台北アリーナ（小巨蛋）
コンサートやスポーツの主要会場。MRT 松山新店線で 2 駅です。

## 台北 101・国父紀念館
信義エリアのランドマークと緑地。バスかタクシーで約 15 分です。

## 象山
登山道を 20 分ほど登れば、定番の台北 101 の夜景が広がります。

周辺には銀行、携帯ショップ、ムスリムフレンドリーなレストラン、子ども向けの遊び場もあります。地図はフロントでお渡しします。`,
      ko: `## 라오허제 야시장
걸어서 약 5분. 입구가 쑹산츠유궁 바로 옆이며, 후추빵부터 약재 갈비탕까지 먹으며 걷기 좋습니다.

## 쑹산츠유궁
라오허제 입구에 있는 유서 깊은 마조 사원으로, 밤 조명이 특히 아름답습니다.

## 관산·무지개 강변공원
지룽강을 따라 산책하거나 자전거를 타고, 해 질 녘 무지개다리에 불이 들어오는 모습을 볼 수 있습니다.

## 타이베이 아레나
콘서트와 스포츠 경기가 열리는 주요 공연장으로, MRT 쑹산신뎬선으로 두 정거장입니다.

## 타이베이 101·국부기념관
신이 지구의 랜드마크와 공원으로, 버스나 택시로 약 15분입니다.

## 샹산
등산로를 20분쯤 오르면 타이베이 101의 대표적인 야경이 펼쳐집니다.

주변에 은행, 통신사 매장, 무슬림 친화 식당, 어린이 놀이터도 있습니다. 지도는 프런트에서 받으실 수 있습니다.`,
    },
  },

  groups: {
    title: { "zh-TW": "團體與長住", en: "Groups and long stays", ja: "団体・長期滞在", ko: "단체·장기 투숙" },
    body: {
      "zh-TW": `班級旅行、畢業旅行、球隊比賽、員工訓練，需要一間能讓大家住在一起、又不犧牲品質與安全的旅館，小公館都準備好了。

## 為什麼適合團體
- 整層可入住 36 至 50 人，一人一床，衛浴乾淨寬敞
- 寬敞的交誼空間與開會設備，不必擠在房間裡開會
- 合法經營，可開立單據；每年兩次消防安全檢查，並投保公共意外險
- 捷運南京三民站、小巨蛋、松山車站都在附近，饒河夜市步行可到

## 團體活動（皆需預約）
- 烤餅乾，約一小時，每人材料費 NT$30
- 露天陽台烤肉，可遠眺台北 101，可代訂食材
- 密室逃脫，享住客優惠
- 騎單車探索民生社區

## 專車接送
團體入住可租用 NK 專屬巴士，最多可載 40 人，提供台北市區接送。

## 推薦房型
旅伴四人客房、六人行客房（皆可加床），以及混合與女性雙人旅艙。

## 長期住宿
提供半月租（15 晚）與月租（30 晚）方案，價格依房型而定。

團體訂房與長住方案，請來信或來電洽詢。`,
      en: `School trips, graduation trips, sports teams, staff training: when you need somewhere everyone can stay together without giving up comfort or safety, we are ready.

## Why groups choose us
- A whole floor sleeps 36 to 50, one bed each, with clean and spacious bathrooms
- Large lounges and meeting equipment, so nobody has to meet in a cramped bedroom
- Fully licensed with proper receipts; fire safety inspections twice a year and public liability insurance
- Close to Nanjing Sanmin MRT, Taipei Arena and Songshan Station, with Raohe Night Market in walking distance

## Group activities (booking required)
- Cookie baking, about an hour, NT$30 per person for ingredients
- Barbecue on the open terrace with a view of Taipei 101; we can order the food
- Escape room at a guest discount
- Cycling through the Minsheng Community

## Private coach
Groups can hire the NK coach, seating up to 40, for transfers around Taipei.

## Recommended rooms
Buddy Room and Buddy Room for Six (both take extra beds), and the mixed and female capsules.

## Long stays
Half-month (15 nights) and monthly (30 nights) rates are available; prices depend on the room type.

For group bookings and long stays, email or call us.`,
      ja: `修学旅行、卒業旅行、スポーツチームの遠征、社員研修。みんなで一緒に泊まれて、快適さも安全も妥協したくない。そんなご要望に小公館がお応えします。

## 団体におすすめの理由
- 1 フロアで 36〜50 名様まで、お一人様 1 ベッド。清潔で広々としたバスルーム
- 広いラウンジとミーティング設備で、狭い客室で打ち合わせをする必要はありません
- 正規の許可を得た宿泊施設で領収書も発行可能。年 2 回の消防安全検査と施設賠償責任保険に加入
- MRT 南京三民駅、台北アリーナ、松山駅に近く、饒河街夜市へも徒歩圏内

## グループアクティビティ（要予約）
- クッキー作り：約 1 時間、材料費お一人様 NT$30
- 台北 101 を望むテラスでのバーベキュー（食材の手配も承ります）
- 宿泊者割引のリアル脱出ゲーム
- 民生コミュニティのサイクリング

## 専用バス
団体のお客様は NK 専用バス（最大 40 名様）で台北市内の送迎をご利用いただけます。

## おすすめの客室
バディルーム、6 名様用バディルーム（いずれもエキストラベッド可）、男女混合・女性専用カプセル。

## 長期滞在
半月（15 泊）と 1 か月（30 泊）のプランがございます。料金は客室タイプによって異なります。

団体予約・長期滞在はメールまたはお電話でお問い合わせください。`,
      ko: `수학여행, 졸업여행, 스포츠 팀 원정, 직원 연수처럼 모두가 함께 묵으면서도 편안함과 안전을 포기하고 싶지 않을 때, 소공관이 준비되어 있습니다.

## 단체에 좋은 이유
- 한 층에 36~50명, 1인 1침대, 깨끗하고 넓은 욕실
- 넓은 라운지와 회의 설비로 좁은 객실에서 회의할 필요가 없습니다
- 정식 허가 숙소로 영수증 발행 가능, 연 2회 소방 안전 점검과 영업배상책임보험 가입
- MRT 난징싼민역, 타이베이 아레나, 쑹산역과 가깝고 라오허제 야시장은 걸어서 갈 수 있습니다

## 단체 활동(예약 필요)
- 쿠키 굽기: 약 1시간, 1인 재료비 NT$30
- 타이베이 101이 보이는 테라스 바비큐(식재료 주문 대행 가능)
- 투숙객 할인 방탈출 게임
- 민성 커뮤니티 자전거 투어

## 전용 버스
단체 투숙객은 최대 40명이 타는 NK 전용 버스로 타이베이 시내 이동을 이용할 수 있습니다.

## 추천 객실
버디룸, 6인 버디룸(모두 엑스트라 베드 가능), 혼성·여성 캡슐.

## 장기 투숙
보름(15박)과 한 달(30박) 요금이 있으며, 가격은 객실 타입에 따라 다릅니다.

단체 예약과 장기 투숙은 이메일이나 전화로 문의해 주세요.`,
    },
  },

  privacy: {
    title: { "zh-TW": "隱私權政策", en: "Privacy policy", ja: "プライバシーポリシー", ko: "개인정보 처리방침" },
    body: {
      "zh-TW": `小公館人文旅舍（以下稱「我們」）依《個人資料保護法》蒐集、處理與利用您的個人資料，說明如下。

## 我們蒐集的資料
訂房時您提供的姓名、Email、電話、國籍與特殊需求，以及訂房內容與付款結果。信用卡資料由收單銀行的付款頁面直接處理，我們不會取得或儲存完整卡號、有效期限與安全碼。

## 使用目的
辦理訂房、付款、退款與入住，寄送訂房確認與入住相關通知，回覆您的詢問，以及依法令保存交易紀錄。我們不會將您的資料用於行銷，除非您另行同意。

## 提供給第三方
僅在完成上述目的所必要的範圍內，提供給收單銀行、訂房通路管理系統與 Email 寄送服務；或依法令要求提供給主管機關。

## 保存期間
依法令規定的期間保存交易紀錄；其他資料於目的完成後刪除。

## 您的權利
您可以查詢、閱覽、複製、補充、更正、停止使用或刪除您的個人資料。請來信 info@nkhostel.com 或來電 +886 2 2769 0200。

## Cookie
本網站僅使用維持網站運作所必要的 Cookie，例如記住您選擇的語言。

本政策如有修改，將公布於此頁。`,
      en: `NK Hostel ("we") collects, processes and uses your personal data in accordance with Taiwan's Personal Data Protection Act, as follows.

## What we collect
The name, email, phone number, nationality and special requests you give us when booking, plus your booking details and payment result. Card details are handled directly by the acquiring bank's payment page; we never receive or store your full card number, expiry date or security code.

## Why we use it
To handle your booking, payment, refunds and stay; to send your confirmation and stay-related messages; to answer your questions; and to keep transaction records as the law requires. We do not use your data for marketing unless you agree separately.

## Who we share it with
Only as far as needed for these purposes: the acquiring bank, our channel manager and our email delivery service, or authorities when the law requires.

## How long we keep it
Transaction records for the period the law requires; everything else is deleted once its purpose is fulfilled.

## Your rights
You can ask to see, copy, complete, correct, stop the use of or delete your personal data. Email info@nkhostel.com or call +886 2 2769 0200.

## Cookies
This site only uses cookies it needs to work, such as remembering your language.

Any changes to this policy will be posted on this page.`,
      ja: `小公館人文旅舎（以下「当館」）は、台湾の個人情報保護法に基づき、お客様の個人情報を以下のとおり収集・処理・利用します。

## 収集する情報
ご予約時にご提供いただくお名前、メールアドレス、電話番号、国籍、ご要望、およびご予約内容とお支払い結果。カード情報はカード会社（アクワイアラー銀行）の決済画面で直接処理され、当館がカード番号の全桁、有効期限、セキュリティコードを取得・保存することはありません。

## 利用目的
ご予約、お支払い、返金、ご宿泊の手続き、予約確認やご宿泊に関するご連絡、お問い合わせへの回答、法令に基づく取引記録の保存のために利用します。別途同意をいただかない限り、マーケティングには利用しません。

## 第三者への提供
上記の目的に必要な範囲で、決済銀行、予約チャネル管理システム、メール配信サービスに提供するほか、法令に基づき行政機関に提供する場合があります。

## 保存期間
取引記録は法令で定められた期間保存し、その他の情報は目的達成後に削除します。

## お客様の権利
個人情報の照会、閲覧、複製、補充、訂正、利用停止、削除をご請求いただけます。info@nkhostel.com または +886 2 2769 0200 までご連絡ください。

## Cookie
当サイトでは、表示言語の記憶など、サイトの動作に必要な Cookie のみを使用します。

本ポリシーを変更する場合は、このページでお知らせします。`,
      ko: `소공관 인문여관(이하 '당사')은 대만 개인정보보호법에 따라 고객님의 개인정보를 다음과 같이 수집·처리·이용합니다.

## 수집하는 정보
예약 시 제공하시는 이름, 이메일, 전화번호, 국적, 요청 사항과 예약 내용 및 결제 결과. 카드 정보는 카드사(매입 은행)의 결제 페이지에서 직접 처리되며, 당사는 카드 번호 전체, 유효기간, 보안 코드를 받거나 저장하지 않습니다.

## 이용 목적
예약, 결제, 환불, 투숙 처리, 예약 확인 및 투숙 관련 안내 발송, 문의 응대, 법령에 따른 거래 기록 보관에 이용합니다. 별도로 동의하지 않으시면 마케팅에 이용하지 않습니다.

## 제3자 제공
위 목적에 필요한 범위에서 결제 은행, 예약 채널 관리 시스템, 이메일 발송 서비스에 제공하며, 법령이 요구하는 경우 관계 기관에 제공할 수 있습니다.

## 보관 기간
거래 기록은 법령이 정한 기간 동안 보관하고, 그 밖의 정보는 목적 달성 후 삭제합니다.

## 고객님의 권리
개인정보의 조회, 열람, 복제, 보완, 정정, 이용 중지, 삭제를 요청하실 수 있습니다. info@nkhostel.com 또는 +886 2 2769 0200으로 연락해 주세요.

## 쿠키
이 사이트는 선택한 언어를 기억하는 등 사이트 운영에 필요한 쿠키만 사용합니다.

이 방침이 변경되면 이 페이지에 게시합니다.`,
    },
  },

  "booking-terms": {
    title: { "zh-TW": "訂房條款", en: "Booking terms", ja: "予約規約", ko: "예약 약관" },
    body: {
      "zh-TW": `以下條款適用於在本網站直接預訂的訂單。

## 付款
訂房時以信用卡線上付清全額。付款完成並收到確認信後，訂房才算成立。房價已含稅金與服務費。

## 取消與退款（官網專屬・彈性取消方案）
依入住日（台北時間）計算：
- 入住日 3 天前（含）以前取消：全額退款
- 入住日前 1 至 2 天取消：退還已付金額的 50%
- 入住當天取消或未抵達：不退款

退款會退回原付款的信用卡，入帳時間依發卡銀行而定。請以訂房確認信上的條款為準。

## 更改訂房
如需更改日期或房型，請來信或來電，我們會視空房情況協助處理。

## 入住與退房
入住時間下午 3 點起，退房時間上午 11 點前。入住時請出示與訂房人姓名相符的身分證件或護照。

## 館內規定
全館禁菸；未滿 18 歲請攜帶家長同意書；床位房型不接受 7 歲以下兒童。完整規定請參考常見問題。

## 聯絡我們
info@nkhostel.com／+886 2 2769 0200`,
      en: `These terms apply to bookings made directly on this website.

## Payment
You pay the full amount online by card when you book. Your booking is confirmed once payment succeeds and you receive our confirmation email. Rates include tax and service.

## Cancellation and refunds (Direct Exclusive, Flexible)
Counted from the check-in date, Taipei time:
- Cancel 3 or more days before check-in: full refund
- Cancel 1 to 2 days before check-in: 50% of the amount paid is refunded
- Cancel on the day of check-in, or no-show: no refund

Refunds go back to the card you paid with; how long they take depends on your bank. The terms in your confirmation email apply.

## Changes
To change dates or room type, email or call us and we will help if rooms are available.

## Check-in and check-out
Check-in from 3 pm, check-out by 11 am. Please bring photo ID or a passport matching the name on the booking.

## House rules
The building is non-smoking; guests under 18 need a parental consent form; children under 7 cannot stay in capsule beds. See the FAQ for the full rules.

## Contact
info@nkhostel.com / +886 2 2769 0200`,
      ja: `以下の規約は、当サイトから直接ご予約いただいた場合に適用されます。

## お支払い
ご予約時にクレジットカードでオンラインにて全額お支払いいただきます。お支払いが完了し、予約確認メールが届いた時点でご予約成立となります。料金には税金とサービス料が含まれます。

## キャンセルと返金（公式サイト限定・フレキシブルプラン）
チェックイン日（台北時間）を基準とします。
- チェックイン 3 日前までのキャンセル：全額返金
- チェックイン 1〜2 日前のキャンセル：お支払い額の 50% を返金
- チェックイン当日のキャンセル、または不泊：返金なし

返金はお支払いに使われたカードに行われ、反映までの期間はカード会社によって異なります。予約確認メールに記載の規約が優先されます。

## ご予約の変更
日程や客室タイプの変更は、メールまたはお電話でご連絡ください。空室状況に応じて対応いたします。

## チェックイン・チェックアウト
チェックインは 15:00 から、チェックアウトは 11:00 までです。ご予約名と一致する身分証明書またはパスポートをご提示ください。

## 館内規則
館内は全面禁煙です。18 歳未満の方は保護者の同意書が必要です。7 歳未満のお子様はカプセルベッドにご宿泊いただけません。詳しくはよくある質問をご覧ください。

## お問い合わせ
info@nkhostel.com／+886 2 2769 0200`,
      ko: `아래 약관은 이 웹사이트에서 직접 예약하신 경우에 적용됩니다.

## 결제
예약 시 신용카드로 온라인에서 전액 결제합니다. 결제가 완료되고 예약 확인 메일을 받으시면 예약이 확정됩니다. 요금에는 세금과 봉사료가 포함되어 있습니다.

## 취소 및 환불(공식 홈페이지 전용·유연한 취소)
체크인 날짜(타이베이 시간) 기준:
- 체크인 3일 전까지 취소: 전액 환불
- 체크인 1~2일 전 취소: 결제 금액의 50% 환불
- 체크인 당일 취소 또는 노쇼: 환불 불가

환불은 결제하신 카드로 진행되며, 반영 기간은 카드사에 따라 다릅니다. 예약 확인 메일에 적힌 약관이 우선합니다.

## 예약 변경
날짜나 객실 타입을 바꾸시려면 이메일이나 전화로 연락해 주세요. 객실 상황에 따라 도와드리겠습니다.

## 체크인·체크아웃
체크인은 오후 3시부터, 체크아웃은 오전 11시까지입니다. 예약자 이름과 일치하는 신분증 또는 여권을 제시해 주세요.

## 이용 규칙
건물 전체 금연이며, 18세 미만은 보호자 동의서가 필요하고, 7세 미만 어린이는 캡슐 침대에 투숙할 수 없습니다. 자세한 내용은 자주 묻는 질문을 참고해 주세요.

## 문의
info@nkhostel.com / +886 2 2769 0200`,
    },
  },
};
