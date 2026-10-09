PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`password_is_default` integer DEFAULT false NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`default_currency` text DEFAULT 'PLN' NOT NULL,
	`global_fuzzy_distance` integer DEFAULT 0 NOT NULL,
	`transactions_page_size` integer DEFAULT 100 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "password_hash", "is_admin", "password_is_default", "theme", "default_currency", "global_fuzzy_distance", "transactions_page_size", "created_at") SELECT "id", "username", "password_hash", "is_admin", "password_is_default", "theme", "default_currency", "global_fuzzy_distance", "transactions_page_size", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);