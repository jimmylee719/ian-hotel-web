ALTER TABLE `payments` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);