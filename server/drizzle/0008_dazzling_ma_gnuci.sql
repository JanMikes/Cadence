ALTER TABLE `tasks` ADD `task_type` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_direction` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_ref` text;