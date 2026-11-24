PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ari_daily` (
	`property_id` text NOT NULL,
	`unit_type_id` text NOT NULL,
	`rate_plan_id` text NOT NULL,
	`date` text NOT NULL,
	`available` integer DEFAULT 0 NOT NULL,
	`price` integer DEFAULT 0 NOT NULL,
	`min_stay` integer DEFAULT 1 NOT NULL,
	`closed_to_arrival` integer DEFAULT false NOT NULL,
	`closed_to_departure` integer DEFAULT false NOT NULL,
	`stop_sell` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`unit_type_id`, `rate_plan_id`, `date`),
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_type_id`) REFERENCES `unit_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rate_plan_id`) REFERENCES `rate_plans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ari_available_nonnegative" CHECK("__new_ari_daily"."available" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_ari_daily`("property_id", "unit_type_id", "rate_plan_id", "date", "available", "price", "min_stay", "closed_to_arrival", "closed_to_departure", "stop_sell", "source", "synced_at") SELECT "property_id", "unit_type_id", "rate_plan_id", "date", "available", "price", "min_stay", "closed_to_arrival", "closed_to_departure", "stop_sell", "source", "synced_at" FROM `ari_daily`;--> statement-breakpoint
DROP TABLE `ari_daily`;--> statement-breakpoint
ALTER TABLE `__new_ari_daily` RENAME TO `ari_daily`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ari_property_date` ON `ari_daily` (`property_id`,`date`);