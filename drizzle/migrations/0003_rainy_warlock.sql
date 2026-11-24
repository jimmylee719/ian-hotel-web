CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`kind` text NOT NULL,
	`to` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unique_send` ON `notifications` (`reservation_id`,`kind`,`to`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text,
	`reservation_code` text,
	`raw_body` text NOT NULL,
	`verdict` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `reservations` ADD `hold_expires_at` integer;--> statement-breakpoint
ALTER TABLE `reservations` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `sync_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `next_sync_at` integer;--> statement-breakpoint
ALTER TABLE `reservations` ADD `last_sync_error` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `reservations` ADD `refunded_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `guest_email_lower` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_idempotency_key_unique` ON `reservations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `reservations_guest_email_lower` ON `reservations` (`guest_email_lower`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_ref_unique` ON `payments` (`provider_ref`);