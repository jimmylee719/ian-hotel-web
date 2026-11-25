CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_runs_name_started` ON `job_runs` (`name`,`started_at`);--> statement-breakpoint
-- Staff emails are stored trimmed and lowercase from now on (they are matched against the Access identity).
-- If two staff rows differ only by case or surrounding spaces, this UPDATE violates staff_email_unique and the
-- whole migration aborts: merge or delete the duplicate by hand, then re-run.
UPDATE `staff` SET `email` = lower(trim(`email`));--> statement-breakpoint
DROP INDEX `staff_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `staff_email_lower_unique` ON `staff` (lower("email"));