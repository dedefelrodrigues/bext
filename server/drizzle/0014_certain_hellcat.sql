CREATE TABLE `ai_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`secret` text NOT NULL,
	`hint` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_user_provider_unique` ON `ai_keys` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `ai_proposal_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `ai_proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_proposal_transactions_pair_unique` ON `ai_proposal_transactions` (`proposal_id`,`transaction_id`);--> statement-breakpoint
CREATE TABLE `ai_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`run_id` integer,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`engine_key` text NOT NULL,
	`web_search` integer DEFAULT false NOT NULL,
	`group_key` text NOT NULL,
	`sample_description` text NOT NULL,
	`merchant` text,
	`keyword` text NOT NULL,
	`category_id` integer,
	`subcategory_id` integer,
	`confidence` integer,
	`rationale` text,
	`sources` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_count` integer DEFAULT 0 NOT NULL,
	`created_keyword_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subcategory_id`) REFERENCES `subcategories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_keyword_id`) REFERENCES `keywords`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_proposals_user_engine_group_unique` ON `ai_proposals` (`user_id`,`engine_key`,`group_key`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`engine_key` text NOT NULL,
	`web_search` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`requested` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `ai_provider` text DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ai_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ai_web_search` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `ai_batch_size` integer DEFAULT 25 NOT NULL;