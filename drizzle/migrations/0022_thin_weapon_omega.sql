CREATE TABLE `ops_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`hour` integer NOT NULL,
	`status` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ops_alerts_key_hour` ON `ops_alerts` (`key`,`hour`);--> statement-breakpoint
CREATE INDEX `ops_alerts_key_at` ON `ops_alerts` (`key`,`at`);