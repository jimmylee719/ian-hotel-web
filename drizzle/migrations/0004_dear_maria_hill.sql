ALTER TABLE `notifications` ADD `property_id` text DEFAULT '' NOT NULL REFERENCES properties(id);--> statement-breakpoint
ALTER TABLE `payment_events` ADD `property_id` text REFERENCES properties(id);--> statement-breakpoint
CREATE INDEX `payment_events_property_at` ON `payment_events` (`property_id`,`at`);