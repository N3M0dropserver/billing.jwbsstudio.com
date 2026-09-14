CREATE TABLE IF NOT EXISTS `agent_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`stage` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`match_rules` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`overrides_built_in` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_skills_user_slug_idx` ON `agent_skills` (`user_id`,`slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `growth_dismissals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recommendation_id` text NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `growth_dismissals_user_rec_idx` ON `growth_dismissals` (`user_id`,`recommendation_id`);