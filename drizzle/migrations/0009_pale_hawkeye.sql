CREATE TABLE `reservation_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`property_id` text NOT NULL,
	`staff_email` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reservation_notes_reservation` ON `reservation_notes` (`reservation_id`,`created_at`);