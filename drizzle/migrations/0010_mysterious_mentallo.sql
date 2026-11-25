ALTER TABLE `payments` ADD `note` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `front_desk_refund_due` integer DEFAULT 0 NOT NULL;