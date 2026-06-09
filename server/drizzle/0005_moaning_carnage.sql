ALTER TABLE `projects` ADD `worktrees_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `worktree_check` text;