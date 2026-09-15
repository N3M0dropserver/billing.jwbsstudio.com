CREATE TABLE IF NOT EXISTS `agent_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'fact' NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`campaign_id` text,
	`prospect_id` text,
	`confidence` integer DEFAULT 60 NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`embedding` text DEFAULT '' NOT NULL,
	`embedding_model` text DEFAULT '' NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_memories_scope_idx` ON `agent_memories` (`user_id`,`scope`,`scope_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_memories_recent_idx` ON `agent_memories` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_research` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`campaign_id` text,
	`prospect_id` text,
	`question` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`learned` text DEFAULT '[]' NOT NULL,
	`steps_used` integer DEFAULT 0 NOT NULL,
	`step_budget` integer DEFAULT 8 NOT NULL,
	`skills_used` text DEFAULT '[]' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_research_user_idx` ON `agent_research` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_research_campaign_idx` ON `agent_research` (`campaign_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_research_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`research_id` text NOT NULL,
	`user_id` text NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'thought' NOT NULL,
	`tool` text DEFAULT '' NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`research_id`) REFERENCES `agent_research`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_research_steps_idx` ON `agent_research_steps` (`research_id`,`step`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_skill_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`when_to_use` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `agent_skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_skill_revisions_idx` ON `agent_skill_revisions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`when_to_use` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`success_count` integer DEFAULT 0 NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_skills_slug_idx` ON `agent_skills` (`user_id`,`slug`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_skills_status_idx` ON `agent_skills` (`user_id`,`status`);--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_browser_mode` text DEFAULT 'fallback' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_step_budget` integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_memory_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_skills_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_self_improve` text DEFAULT 'propose' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `agent_research_daily_cap` integer DEFAULT 20 NOT NULL;