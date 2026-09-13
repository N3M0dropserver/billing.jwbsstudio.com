ALTER TABLE `clients` ADD `reminders_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `last_reminder_stage` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `reminders_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reminders_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reminder_days_before` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reminder_days_after` text DEFAULT '[7,14,30]' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reminder_max_count` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reminder_skip_weekends` integer DEFAULT true NOT NULL;