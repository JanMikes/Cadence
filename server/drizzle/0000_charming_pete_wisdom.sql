CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text,
	`session_id` text,
	`type` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fleets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`system_prompt` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleets_slug_unique` ON `fleets` (`slug`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text,
	`root_path` text,
	`git_remote` text,
	`default_model` text,
	`default_permission_mode` text DEFAULT 'auto' NOT NULL,
	`default_delivery_mode` text DEFAULT 'branch_summary' NOT NULL,
	`system_prompt` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`project_id` text,
	`fleet_id` text,
	`role` text NOT NULL,
	`kind` text DEFAULT 'warm' NOT NULL,
	`status` text DEFAULT 'spawning' NOT NULL,
	`cwd` text NOT NULL,
	`branch` text,
	`worktree_path` text,
	`pid` integer,
	`model` text,
	`permission_mode` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`transcript_path` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`suggested_value` text,
	`rationale` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`source` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `task_deps` (
	`blocker_task_id` text NOT NULL,
	`blocked_task_id` text NOT NULL,
	PRIMARY KEY(`blocker_task_id`, `blocked_task_id`),
	FOREIGN KEY (`blocker_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`priority` text,
	`project_id` text,
	`fleet_id` text,
	`deadline` integer,
	`estimate` integer,
	`delivery_mode` text,
	`parent_task_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`fleet_id`) REFERENCES `fleets`(`id`) ON UPDATE no action ON DELETE set null
);
