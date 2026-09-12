CREATE TABLE `login_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text DEFAULT 'magic-link' NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`requested_ip` text,
	`requested_user_agent` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_tokens_token_idx` ON `login_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `login_tokens_user_idx` ON `login_tokens` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `login_tokens_expiry_idx` ON `login_tokens` (`expires_at`);