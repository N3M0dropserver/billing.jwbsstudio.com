-- Invoice templates: a saved look for an invoice (layout, palette, logo).
--
-- The ALTER comes first deliberately. Re-applying a migration is what
-- renumbering causes, and `ADD COLUMN` is the one statement SQLite refuses to
-- run twice — so putting it at the top makes a re-run abort here rather than
-- part-way through. See CLAUDE.md.
ALTER TABLE `invoices` ADD `template_id` text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`design` text DEFAULT '{}' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoice_templates_user_idx` ON `invoice_templates` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoice_templates_default_idx` ON `invoice_templates` (`user_id`,`is_default`);
