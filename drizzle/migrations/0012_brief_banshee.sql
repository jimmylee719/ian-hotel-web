ALTER TABLE `reservations` ADD `cancel_desk_due` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- A cancellation in flight before this column existed stored its desk share in front_desk_refund_due.
UPDATE `reservations` SET `cancel_desk_due` = `front_desk_refund_due` WHERE `status` = 'confirmed' AND EXISTS (SELECT 1 FROM `payments` WHERE `payments`.`idempotency_key` = 'cancel:' || `reservations`.`id`);
