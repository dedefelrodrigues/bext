CREATE TABLE `fx_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`date` text NOT NULL,
	`from_ccy` text NOT NULL,
	`to_ccy` text NOT NULL,
	`rate` real NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rates_user_pair_unique` ON `fx_rates` (`user_id`,`date`,`from_ccy`,`to_ccy`);