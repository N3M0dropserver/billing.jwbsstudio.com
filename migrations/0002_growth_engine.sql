-- Growth engine.
--
-- `prospects` is rebuilt rather than altered because SQLite cannot add a
-- CHECK-constrained column or change a foreign key in place. The copy below
-- names only the columns the old table actually had: everything new carries
-- its default. `search_id` is deliberately NOT carried into `campaign_id` —
-- it pointed at `prospect_searches`, which this migration drops, so keeping
-- the value would leave a dangling reference.
--
-- `prospect_searches` and `style_repertoire` are dropped. Neither ever held
-- usable data: discovery was a stub that failed before writing any result,
-- and the style repertoire had no UI to populate it. `brand_kits` and
-- `campaigns` replace them.

CREATE TABLE `brand_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`brand_kit_id` text,
	`campaign_id` text,
	`kind` text DEFAULT 'screenshot' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_kit_id`) REFERENCES `brand_kits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brand_assets_kit_idx` ON `brand_assets` (`brand_kit_id`);--> statement-breakpoint
CREATE INDEX `brand_assets_campaign_idx` ON `brand_assets` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `brand_kits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`reference_urls` text DEFAULT '[]' NOT NULL,
	`typography` text DEFAULT '[]' NOT NULL,
	`palette` text DEFAULT '[]' NOT NULL,
	`section_order` text DEFAULT '[]' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`tone_notes` text DEFAULT '' NOT NULL,
	`avoid` text DEFAULT '' NOT NULL,
	`capabilities` text DEFAULT '' NOT NULL,
	`suitable_for` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `brand_kits_user_idx` ON `brand_kits` (`user_id`,`is_default`);--> statement-breakpoint
CREATE TABLE `campaign_events` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`prospect_id` text,
	`stage` text DEFAULT '' NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_events_idx` ON `campaign_events` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`niche` text DEFAULT '' NOT NULL,
	`ideal_client` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`discovery_provider` text DEFAULT 'overpass' NOT NULL,
	`manual_input` text DEFAULT '' NOT NULL,
	`brand_kit_id` text,
	`brief_overrides` text DEFAULT '{}' NOT NULL,
	`policy` text DEFAULT '{}' NOT NULL,
	`stage` text DEFAULT 'brief' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`waiting_on` text,
	`target_count` integer DEFAULT 10 NOT NULL,
	`score_floor` integer DEFAULT 55 NOT NULL,
	`discovered_count` integer DEFAULT 0 NOT NULL,
	`shortlisted_count` integer DEFAULT 0 NOT NULL,
	`enriched_count` integer DEFAULT 0 NOT NULL,
	`planned_count` integer DEFAULT 0 NOT NULL,
	`built_count` integer DEFAULT 0 NOT NULL,
	`proposed_count` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`last_activity_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_kit_id`) REFERENCES `brand_kits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaigns_user_idx` ON `campaigns` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `demo_sites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`campaign_id` text,
	`plan_id` text,
	`subdomain` text NOT NULL,
	`host` text NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`r2_prefix` text DEFAULT '' NOT NULL,
	`source_prefix` text DEFAULT '' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`build_error` text DEFAULT '' NOT NULL,
	`dns_record_id` text,
	`views` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `design_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demo_sites_host_idx` ON `demo_sites` (`host`);--> statement-breakpoint
CREATE INDEX `demo_sites_prospect_idx` ON `demo_sites` (`prospect_id`);--> statement-breakpoint
CREATE TABLE `design_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`campaign_id` text,
	`brand_kit_id` text,
	`summary` text DEFAULT '' NOT NULL,
	`strategy` text DEFAULT '' NOT NULL,
	`objective` text DEFAULT 'conversion' NOT NULL,
	`palette` text DEFAULT '[]' NOT NULL,
	`typography` text DEFAULT '[]' NOT NULL,
	`sections` text DEFAULT '[]' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_kit_id`) REFERENCES `brand_kits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `design_plans_prospect_idx` ON `design_plans` (`prospect_id`);--> statement-breakpoint
CREATE TABLE `prospect_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`campaign_id` text,
	`kind` text DEFAULT 'page' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`r2_key` text DEFAULT '' NOT NULL,
	`content_type` text DEFAULT '' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prospect_artifacts_idx` ON `prospect_artifacts` (`prospect_id`,`kind`);--> statement-breakpoint
DROP TABLE `prospect_searches`;--> statement-breakpoint
DROP TABLE `style_repertoire`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`campaign_id` text,
	`business_name` text NOT NULL,
	`niche` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`maps_url` text DEFAULT '' NOT NULL,
	`social_links` text DEFAULT '[]' NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`contact_role` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`signal` text DEFAULT 'other' NOT NULL,
	`presence_score` integer DEFAULT 0 NOT NULL,
	`fit_score` integer DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`audit` text DEFAULT '{}' NOT NULL,
	`findings` text DEFAULT '{}' NOT NULL,
	`rating` real,
	`review_count` integer DEFAULT 0 NOT NULL,
	`review_summary` text DEFAULT '' NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`selected_by` text,
	`stage` text DEFAULT 'discover' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`converted_client_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`enriched_at` text,
	`planned_at` text,
	`built_at` text,
	`proposed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`converted_client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_prospects`("id", "user_id", "business_name", "niche", "region", "country", "website", "email", "phone", "address", "maps_url", "social_links", "signal", "score", "findings", "status", "converted_client_id", "notes", "created_at", "updated_at") SELECT "id", "user_id", "business_name", "niche", "region", "country", "website", "email", "phone", "address", "maps_url", "social_links", "signal", "score", "findings", "status", "converted_client_id", "notes", "created_at", "updated_at" FROM `prospects`;--> statement-breakpoint
DROP TABLE `prospects`;--> statement-breakpoint
ALTER TABLE `__new_prospects` RENAME TO `prospects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `prospects_user_status_idx` ON `prospects` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `prospects_score_idx` ON `prospects` (`user_id`,`score`);--> statement-breakpoint
CREATE INDEX `prospects_campaign_idx` ON `prospects` (`campaign_id`,`score`);--> statement-breakpoint
CREATE INDEX `prospects_domain_idx` ON `prospects` (`user_id`,`domain`);--> statement-breakpoint
ALTER TABLE `proposals` ADD `campaign_id` text REFERENCES campaigns(id);--> statement-breakpoint
ALTER TABLE `proposals` ADD `demo_site_id` text REFERENCES demo_sites(id);--> statement-breakpoint
ALTER TABLE `proposals` ADD `email_subject` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `email_body` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `sent_to` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `send_result` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposals` ADD `view_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `proposals_campaign_idx` ON `proposals` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `proposals` DROP COLUMN `mockup_subdomain`;--> statement-breakpoint
ALTER TABLE `proposals` DROP COLUMN `mockup_key`;--> statement-breakpoint
ALTER TABLE `settings` ADD `growth_policy` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `growth_brand_kit_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `growth_discovery_provider` text DEFAULT 'overpass' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `demo_host` text DEFAULT 'demo.jwbsstudio.com' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `outreach_daily_cap` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `outreach_sender_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `outreach_bio` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `outreach_signature` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `outreach_reply_to` text DEFAULT '' NOT NULL;