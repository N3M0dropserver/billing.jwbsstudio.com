CREATE TABLE `invoice_events` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`client_id` text,
	`user_id` text,
	`type` text NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`parent_id` text,
	`ip_address` text,
	`user_agent` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `invoice_events_invoice_idx` ON `invoice_events` (`invoice_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `invoice_events_client_idx` ON `invoice_events` (`client_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `invoice_events_user_idx` ON `invoice_events` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `invoice_events_parent_idx` ON `invoice_events` (`parent_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `track_email_opens` integer DEFAULT true NOT NULL;