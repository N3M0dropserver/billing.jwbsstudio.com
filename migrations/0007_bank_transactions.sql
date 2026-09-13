CREATE TABLE `bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`occurred_on` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'unmatched' NOT NULL,
	`matched_invoice_id` text,
	`matched_payment_id` text,
	`match_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`matched_payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_tx_fingerprint_idx` ON `bank_transactions` (`user_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `bank_tx_user_status_idx` ON `bank_transactions` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `bank_tx_user_date_idx` ON `bank_transactions` (`user_id`,`occurred_on`);