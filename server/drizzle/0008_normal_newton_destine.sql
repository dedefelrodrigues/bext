CREATE TABLE `csv_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`delimiter` text DEFAULT ',' NOT NULL,
	`decimal_separator` text DEFAULT '.' NOT NULL,
	`encoding` text DEFAULT 'utf-8' NOT NULL,
	`header_row` integer DEFAULT 0 NOT NULL,
	`date_format` text DEFAULT 'YYYY-MM-DD' NOT NULL,
	`date_column` text DEFAULT '' NOT NULL,
	`description_columns` text DEFAULT '[]' NOT NULL,
	`amount_columns` text DEFAULT '[]' NOT NULL,
	`currency_column` text,
	`foreign_amount_column` text,
	`foreign_currency_column` text,
	`filters` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `csv_templates_account_id_unique` ON `csv_templates` (`account_id`);