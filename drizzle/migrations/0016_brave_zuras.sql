ALTER TABLE `reservations` ADD `cancel_policy` text DEFAULT '{"rules":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `rate_plan_name` text DEFAULT '{"zh-TW":"","en":"","ja":"","ko":""}' NOT NULL;--> statement-breakpoint
-- Existing bookings take the terms of the plan they are on today (the best record there is).
UPDATE `reservations` SET
  `cancel_policy` = (SELECT rp.`cancel_policy` FROM `reservation_rooms` rr JOIN `rate_plans` rp ON rp.`id` = rr.`rate_plan_id` WHERE rr.`reservation_id` = `reservations`.`id` LIMIT 1),
  `rate_plan_name` = (SELECT rp.`name` FROM `reservation_rooms` rr JOIN `rate_plans` rp ON rp.`id` = rr.`rate_plan_id` WHERE rr.`reservation_id` = `reservations`.`id` LIMIT 1)
WHERE EXISTS (SELECT 1 FROM `reservation_rooms` rr WHERE rr.`reservation_id` = `reservations`.`id`);
