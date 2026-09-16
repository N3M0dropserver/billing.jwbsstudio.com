ALTER TABLE `brand_kits` ADD `reference_profiles` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `brand_kits` ADD `reference_profiled_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `design_plans` ADD `style` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `design_plans` ADD `fallback_reason` text DEFAULT '' NOT NULL;