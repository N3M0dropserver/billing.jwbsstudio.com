ALTER TABLE `settings` ADD `generate_demo_images` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `max_generated_images` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `brand_kits` ADD `design_tokens` text DEFAULT '{}' NOT NULL;