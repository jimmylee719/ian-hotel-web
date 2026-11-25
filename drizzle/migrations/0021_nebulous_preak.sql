ALTER TABLE `payments` ADD `settled_at` integer;--> statement-breakpoint
-- Backfill (M-6): refunds settled before this column existed are dated by when they were created (the best record there is).
UPDATE `payments` SET `settled_at` = `created_at` WHERE `kind` = 'refund' AND `status` = 'succeeded' AND `settled_at` IS NULL;
