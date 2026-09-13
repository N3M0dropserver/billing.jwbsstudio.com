ALTER TABLE `income_sources` ADD `earned_from` text;--> statement-breakpoint
ALTER TABLE `income_sources` ADD `earned_to` text;--> statement-breakpoint
ALTER TABLE `income_sources` ADD `fx_rate_to_residence` real DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `income_sources_user_period_idx` ON `income_sources` (`user_id`,`earned_from`);