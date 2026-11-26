CREATE TABLE `channel_leases` (
	`property_id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`until` integer NOT NULL,
	`cooldown_until` integer
);
--> statement-breakpoint
ALTER TABLE `reservations` ADD `channel_pushed_at` integer;--> statement-breakpoint
ALTER TABLE `reservations` ADD `last_sync_at` integer;--> statement-breakpoint
-- A refunded booking the earlier design queued for a channel check (its push may have landed) counts as pushed.
UPDATE `reservations` SET `channel_pushed_at` = `updated_at` WHERE `status` = 'confirm_failed_refunded' AND `sync_state` = 'pending' AND `channel_pushed_at` IS NULL;
