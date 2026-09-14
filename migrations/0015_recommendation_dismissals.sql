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