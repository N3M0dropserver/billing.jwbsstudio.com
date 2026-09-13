ALTER TABLE `expenses` ADD `fx_rate_to_residence` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `fx_rate_to_residence` real DEFAULT 1 NOT NULL;