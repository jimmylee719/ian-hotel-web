DROP INDEX `notifications_unique_send`;--> statement-breakpoint
ALTER TABLE `notifications` ADD `ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unique_send` ON `notifications` (`reservation_id`,`kind`,`to`,`ref`);--> statement-breakpoint
ALTER TABLE `payments` ADD `refund_of` text;