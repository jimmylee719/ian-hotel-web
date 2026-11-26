CREATE TABLE `channel_leases` (
	`property_id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`until` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `reservations` ADD `channel_pushed_at` integer;