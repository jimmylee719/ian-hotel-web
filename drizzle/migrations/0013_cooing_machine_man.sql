ALTER TABLE `reservations` ADD `desk_due_since` integer;
--> statement-breakpoint
-- Desk-due already owed: the best known start is the cancel, else the last change.
UPDATE `reservations` SET `desk_due_since` = coalesce(`cancelled_at`, `updated_at`) WHERE `front_desk_refund_due` > 0;
