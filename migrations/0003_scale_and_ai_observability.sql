CREATE TABLE `ai_cache` (
	`hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`operation` text DEFAULT '' NOT NULL,
	`response` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_hit_at` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_cache_expiry_idx` ON `ai_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`campaign_id` text,
	`prospect_id` text,
	`stage` text DEFAULT '' NOT NULL,
	`operation` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`tokens_measured` integer DEFAULT false NOT NULL,
	`cost_microcents` integer DEFAULT 0 NOT NULL,
	`cost_confident` integer DEFAULT false NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`cached` integer DEFAULT false NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`request_hash` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_calls_user_idx` ON `ai_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_calls_campaign_idx` ON `ai_calls` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `ai_calls_operation_idx` ON `ai_calls` (`user_id`,`operation`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `scale_ceiling` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `demo_sites` ADD `public_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `prospects` ADD `scale_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `prospects` ADD `scale` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `prospects` ADD `brand` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `prospects` ADD `branch_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `demo_host_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `demo_host_checked_at` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `demo_host_check_result` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `ai_cache_ttl_hours` integer DEFAULT 72 NOT NULL;