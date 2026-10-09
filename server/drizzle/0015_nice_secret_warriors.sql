CREATE TABLE `budget_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `categories` ADD `budget_line_id` integer REFERENCES budget_lines(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `hashtags` ADD `budget_line_id` integer REFERENCES budget_lines(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `hashtags` ADD `budget_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subcategories` ADD `budget_line_id` integer REFERENCES budget_lines(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `budget_line_id` integer REFERENCES budget_lines(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `spread_months` integer;