ALTER TABLE `properties` ADD `check_in_time` text DEFAULT '15:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `check_out_time` text DEFAULT '11:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `directions` text DEFAULT '{"zh-TW":"","en":"","ja":"","ko":""}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `addons_property_slug` ON `addons` (`property_id`,`slug`);--> statement-breakpoint
-- Promo codes are stored UPPERCASE from now on. If two codes in one property differ only by case, this UPDATE
-- violates promo_codes_property_code and the whole migration aborts: resolve the duplicate by hand, then re-run.
UPDATE `promo_codes` SET `code` = upper(trim(`code`));--> statement-breakpoint
-- The directions the pre-arrival email used to hard-code, now the property's own setting.
UPDATE `properties` SET `directions` = '{"zh-TW": "捷運南京三民站 4 號出口步行約 8 分鐘，樓下就有公車站。饒河街夜市與松山車站都在步行範圍內，到松山機場搭計程車約 10 分鐘。", "en": "About 8 minutes'' walk from exit 4 of Nanjing Sanmin MRT station, with a bus stop right outside. Raohe Street Night Market and Songshan Station are within walking distance, and Songshan Airport is about 10 minutes by taxi.", "ja": "MRT 南京三民駅 4 番出口から徒歩約 8 分、建物の前にバス停があります。饒河街夜市と松山駅は徒歩圏内、松山空港へはタクシーで約 10 分です。", "ko": "MRT 난징싼민역 4번 출구에서 걸어서 약 8분, 건물 앞에 버스 정류장이 있습니다. 라오허제 야시장과 쑹산역은 걸어서 갈 수 있고, 쑹산공항까지는 택시로 약 10분입니다."}' WHERE `slug` = 'nk-hostel';
