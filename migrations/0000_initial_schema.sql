CREATE TABLE IF NOT EXISTS `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`entity_type` text DEFAULT '' NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`ip_address` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `activity_user_idx` ON `activity_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'assets' NOT NULL,
	`acquired_on` text NOT NULL,
	`disposed_on` text,
	`disposal_proceeds` integer,
	`cost` integer NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`jurisdiction` text DEFAULT 'NZ' NOT NULL,
	`depreciation_rate` real DEFAULT 0.3 NOT NULL,
	`depreciation_method` text DEFAULT 'DV' NOT NULL,
	`business_use_percent` real DEFAULT 1 NOT NULL,
	`accumulated_depreciation` integer DEFAULT 0 NOT NULL,
	`immediate_write_off` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `assets_user_idx` ON `assets` (`user_id`,`acquired_on`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`address_line1` text DEFAULT '' NOT NULL,
	`address_line2` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`postcode` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`tax_number` text DEFAULT '' NOT NULL,
	`gst_treatment` text DEFAULT 'auto' NOT NULL,
	`hourly_rate` integer,
	`payment_terms_days` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `clients_user_idx` ON `clients` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `clients_status_idx` ON `clients` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `clients_name_idx` ON `clients` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `communications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`contact_id` text,
	`kind` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`occurred_at` text NOT NULL,
	`follow_up_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `comms_client_idx` ON `communications` (`client_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `comms_followup_idx` ON `communications` (`user_id`,`follow_up_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contacts_client_idx` ON `contacts` (`client_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `depreciation_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`tax_year` text NOT NULL,
	`opening` integer NOT NULL,
	`depreciation` integer NOT NULL,
	`claimable` integer NOT NULL,
	`closing` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `depreciation_asset_year_idx` ON `depreciation_entries` (`asset_id`,`tax_year`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`description` text NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`incurred_on` text NOT NULL,
	`amount_gross` integer DEFAULT 0 NOT NULL,
	`gst_amount` integer DEFAULT 0 NOT NULL,
	`amount_net` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`jurisdiction` text DEFAULT 'NZ' NOT NULL,
	`business_use_percent` real DEFAULT 1 NOT NULL,
	`claimable_amount` integer DEFAULT 0 NOT NULL,
	`is_capital` integer DEFAULT false NOT NULL,
	`asset_id` text,
	`is_billable` integer DEFAULT false NOT NULL,
	`billed_on_invoice_id` text,
	`receipt_key` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`billed_on_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `expenses_user_date_idx` ON `expenses` (`user_id`,`incurred_on`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `expenses_category_idx` ON `expenses` (`user_id`,`category`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `expenses_client_idx` ON `expenses` (`client_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `income_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tax_year` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`gross_amount` integer DEFAULT 0 NOT NULL,
	`tax_withheld` integer DEFAULT 0 NOT NULL,
	`acc_levy_withheld` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `income_sources_user_year_idx` ON `income_sources` (`user_id`,`tax_year`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1000 NOT NULL,
	`unit` text DEFAULT 'hours' NOT NULL,
	`unit_price` integer DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`line_total` integer DEFAULT 0 NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoice_lines_invoice_idx` ON `invoice_lines` (`invoice_id`,`position`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`number` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_manual_entry` integer DEFAULT false NOT NULL,
	`issued_on` text NOT NULL,
	`due_on` text NOT NULL,
	`paid_on` text,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`jurisdiction` text DEFAULT 'NZ' NOT NULL,
	`gst_treatment` text DEFAULT 'standard' NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`gst_amount` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`amount_paid` integer DEFAULT 0 NOT NULL,
	`fx_rate_to_residence` real DEFAULT 1 NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`terms` text DEFAULT '' NOT NULL,
	`pdf_key` text,
	`public_token` text,
	`sent_at` text,
	`viewed_at` text,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`last_reminder_at` text,
	`stripe_payment_intent_id` text,
	`stripe_payment_link_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_number_idx` ON `invoices` (`user_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_public_token_idx` ON `invoices` (`public_token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_user_status_idx` ON `invoices` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_client_idx` ON `invoices` (`client_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_issued_idx` ON `invoices` (`user_id`,`issued_on`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_due_idx` ON `invoices` (`user_id`,`due_on`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`received_on` text NOT NULL,
	`method` text DEFAULT 'bank-transfer' NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`stripe_charge_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `payments_invoice_idx` ON `payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `payments_user_date_idx` ON `payments` (`user_id`,`received_on`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`fixed_price` integer,
	`estimated_hours` real,
	`started_on` text,
	`due_on` text,
	`completed_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_user_idx` ON `projects` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_client_idx` ON `projects` (`client_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`prospect_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'NZD' NOT NULL,
	`mockup_subdomain` text,
	`mockup_key` text,
	`public_token` text,
	`sent_at` text,
	`viewed_at` text,
	`responded_at` text,
	`expires_on` text,
	`converted_invoice_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prospect_id`) REFERENCES `prospects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proposals_user_status_idx` ON `proposals` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `proposals_public_token_idx` ON `proposals` (`public_token`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prospect_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`niche` text NOT NULL,
	`region` text NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`style_repertoire_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prospect_searches_user_idx` ON `prospect_searches` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`search_id` text,
	`business_name` text NOT NULL,
	`niche` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`maps_url` text DEFAULT '' NOT NULL,
	`social_links` text DEFAULT '[]' NOT NULL,
	`signal` text DEFAULT 'other' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`findings` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`converted_client_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`search_id`) REFERENCES `prospect_searches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prospects_user_status_idx` ON `prospects` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `prospects_score_idx` ON `prospects` (`user_id`,`score`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sessions_token_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`legal_name` text DEFAULT '' NOT NULL,
	`address_line1` text DEFAULT '' NOT NULL,
	`address_line2` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`postcode` text DEFAULT '' NOT NULL,
	`country` text DEFAULT 'NZ' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`logo_key` text,
	`tax_residence` text DEFAULT 'NZ' NOT NULL,
	`nz_ird_number` text DEFAULT '' NOT NULL,
	`nz_gst_registered` integer DEFAULT false NOT NULL,
	`nz_gst_number` text DEFAULT '' NOT NULL,
	`nz_gst_filing_frequency` text DEFAULT 'two-monthly' NOT NULL,
	`nz_has_student_loan` integer DEFAULT false NOT NULL,
	`nz_acc_cover` text DEFAULT 'CoverPlus' NOT NULL,
	`nz_acc_agreed_cover` integer,
	`nz_acc_work_levy_rate` real,
	`nz_acc_full_time` integer DEFAULT true NOT NULL,
	`au_abn` text DEFAULT '' NOT NULL,
	`au_gst_registered` integer DEFAULT false NOT NULL,
	`au_bas_frequency` text DEFAULT 'quarterly' NOT NULL,
	`au_has_help_debt` integer DEFAULT false NOT NULL,
	`au_has_private_hospital_cover` integer DEFAULT false NOT NULL,
	`default_currency` text DEFAULT 'NZD' NOT NULL,
	`default_payment_terms_days` integer DEFAULT 14 NOT NULL,
	`default_hourly_rate` integer DEFAULT 0 NOT NULL,
	`invoice_number_prefix` text DEFAULT 'INV-' NOT NULL,
	`invoice_next_number` integer DEFAULT 1 NOT NULL,
	`invoice_footer` text DEFAULT '' NOT NULL,
	`bank_account_name` text DEFAULT '' NOT NULL,
	`bank_account_number` text DEFAULT '' NOT NULL,
	`bank_name` text DEFAULT '' NOT NULL,
	`bank_bsb` text DEFAULT '' NOT NULL,
	`bank_swift` text DEFAULT '' NOT NULL,
	`stripe_enabled` integer DEFAULT false NOT NULL,
	`tax_reserve_rate` real DEFAULT 0.33 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `style_repertoire` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`reference_urls` text DEFAULT '[]' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`suitable_for` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `style_repertoire_user_idx` ON `style_repertoire` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text,
	`project_id` text,
	`invoice_id` text,
	`description` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`minutes` integer DEFAULT 0 NOT NULL,
	`billable` integer DEFAULT true NOT NULL,
	`hourly_rate` integer,
	`billed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `time_user_started_idx` ON `time_entries` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `time_client_idx` ON `time_entries` (`client_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `time_unbilled_idx` ON `time_entries` (`user_id`,`billed`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`disabled_at` text,
	`last_login_at` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_idx` ON `users` (`email`);