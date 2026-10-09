CREATE TABLE `ofx_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`description_fields` text DEFAULT '["NAME","MEMO"]' NOT NULL,
	`bank_id` text,
	`acct_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ofx_settings_account_id_unique` ON `ofx_settings` (`account_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `fitid` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `format` text DEFAULT 'csv' NOT NULL;