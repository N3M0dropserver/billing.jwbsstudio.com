CREATE TABLE `proposal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1000 NOT NULL,
	`unit` text DEFAULT 'hours' NOT NULL,
	`unit_price` integer DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`line_total` integer DEFAULT 0 NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proposal_lines_proposal_idx` ON `proposal_lines` (`proposal_id`,`position`);--> statement-breakpoint
ALTER TABLE `proposals` ADD `number` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `jurisdiction` text DEFAULT 'NZ' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `gst_treatment` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `subtotal` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `gst_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `fx_rate_to_residence` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `reference` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `terms` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `accepted_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `accepted_ip` text;--> statement-breakpoint
ALTER TABLE `proposals` ADD `decline_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `quote_number_prefix` text DEFAULT 'QUO-' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `quote_next_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `quote_valid_days` integer DEFAULT 30 NOT NULL;