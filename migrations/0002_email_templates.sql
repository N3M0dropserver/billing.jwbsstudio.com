CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'general' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`doc` text DEFAULT '{}' NOT NULL,
	`html` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_templates_user_kind_idx` ON `email_templates` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `email_templates_default_idx` ON `email_templates` (`user_id`,`kind`,`is_default`);--> statement-breakpoint
CREATE TABLE `email_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entity_type` text DEFAULT 'invoice' NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`template_id` text,
	`to_address` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`token` text NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`provider_message_id` text,
	`sent_at` text NOT NULL,
	`first_opened_at` text,
	`last_opened_at` text,
	`open_count` integer DEFAULT 0 NOT NULL,
	`open_user_agent` text,
	`open_ip` text,
	`likely_prefetch` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `email_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_sends_token_idx` ON `email_sends` (`token`);--> statement-breakpoint
CREATE INDEX `email_sends_entity_idx` ON `email_sends` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `email_sends_user_idx` ON `email_sends` (`user_id`,`sent_at`);
