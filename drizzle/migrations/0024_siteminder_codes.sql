-- Our SiteMinder codes (lib/channel/siteminder/codes.ts): a missing code becomes the slug upper-cased without hyphens,
-- at most 16 characters (smCodeFromSlug; slugs are [a-z0-9-]). A row whose code would clash with another row's code
-- (held or derived) in the same scope is left empty: fillMissingSmCodes gives it a suffixed code. Existing codes are kept.
UPDATE `properties` SET `sm_property_code` = NULL WHERE `sm_property_code` = '';--> statement-breakpoint
UPDATE `unit_types` SET `sm_room_code` = NULL WHERE `sm_room_code` = '';--> statement-breakpoint
UPDATE `rate_plans` SET `sm_rate_plan_code` = NULL WHERE `sm_rate_plan_code` = '';--> statement-breakpoint
UPDATE `properties` SET `sm_property_code` = UPPER(SUBSTR(REPLACE(`slug`, '-', ''), 1, 16))
WHERE `sm_property_code` IS NULL AND NOT EXISTS (
  SELECT 1 FROM `properties` AS o WHERE o.`id` <> `properties`.`id` AND (
    o.`sm_property_code` = UPPER(SUBSTR(REPLACE(`properties`.`slug`, '-', ''), 1, 16))
    OR (o.`sm_property_code` IS NULL AND UPPER(SUBSTR(REPLACE(o.`slug`, '-', ''), 1, 16)) = UPPER(SUBSTR(REPLACE(`properties`.`slug`, '-', ''), 1, 16)))
  )
);--> statement-breakpoint
UPDATE `unit_types` SET `sm_room_code` = UPPER(SUBSTR(REPLACE(`slug`, '-', ''), 1, 16))
WHERE `sm_room_code` IS NULL AND NOT EXISTS (
  SELECT 1 FROM `unit_types` AS o WHERE o.`property_id` = `unit_types`.`property_id` AND o.`id` <> `unit_types`.`id` AND (
    o.`sm_room_code` = UPPER(SUBSTR(REPLACE(`unit_types`.`slug`, '-', ''), 1, 16))
    OR (o.`sm_room_code` IS NULL AND UPPER(SUBSTR(REPLACE(o.`slug`, '-', ''), 1, 16)) = UPPER(SUBSTR(REPLACE(`unit_types`.`slug`, '-', ''), 1, 16)))
  )
);--> statement-breakpoint
UPDATE `rate_plans` SET `sm_rate_plan_code` = UPPER(SUBSTR(REPLACE(`slug`, '-', ''), 1, 16))
WHERE `sm_rate_plan_code` IS NULL AND NOT EXISTS (
  SELECT 1 FROM `rate_plans` AS o WHERE o.`property_id` = `rate_plans`.`property_id` AND o.`id` <> `rate_plans`.`id` AND (
    o.`sm_rate_plan_code` = UPPER(SUBSTR(REPLACE(`rate_plans`.`slug`, '-', ''), 1, 16))
    OR (o.`sm_rate_plan_code` IS NULL AND UPPER(SUBSTR(REPLACE(o.`slug`, '-', ''), 1, 16)) = UPPER(SUBSTR(REPLACE(`rate_plans`.`slug`, '-', ''), 1, 16)))
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_sm_property_code_unique` ON `properties` (`sm_property_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `rate_plans_property_sm_rate_plan_code` ON `rate_plans` (`property_id`,`sm_rate_plan_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `unit_types_property_sm_room_code` ON `unit_types` (`property_id`,`sm_room_code`);
