CREATE TABLE `channel_ari_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`property_id` text,
	`message_type` text NOT NULL,
	`echo_token` text,
	`days` integer NOT NULL,
	`outcome` text NOT NULL,
	`error_code` integer,
	`error_text` text,
	`rejected_codes` text DEFAULT '[]' NOT NULL,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_ari_messages_at` ON `channel_ari_messages` (`at`);--> statement-breakpoint
ALTER TABLE `ari_daily` ADD `max_stay` integer;--> statement-breakpoint
ALTER TABLE `ari_daily` ADD `min_stay_through` integer;--> statement-breakpoint
ALTER TABLE `ari_daily` ADD `max_stay_through` integer;--> statement-breakpoint
ALTER TABLE `ari_daily` ADD `restrictions_source_ts` integer;--> statement-breakpoint
ALTER TABLE `ari_daily` ADD `price_source_ts` integer;--> statement-breakpoint
ALTER TABLE `inventory_daily` ADD `source_ts` integer;