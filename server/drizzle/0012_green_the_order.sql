CREATE TABLE `recurring_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`cadence` text NOT NULL,
	`day_of_week` integer,
	`day_of_month` integer,
	`time` text NOT NULL,
	`project_id` text,
	`priority` text,
	`paused` integer DEFAULT false NOT NULL,
	`last_triggered_at` integer,
	`last_task_id` text,
	`next_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
