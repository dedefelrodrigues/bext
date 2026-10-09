PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`institution_id` integer NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`holder` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_accounts`("id", "user_id", "institution_id", "name", "currency", "holder", "created_at") SELECT "id", "user_id", "institution_id", "name", "currency", "holder", "created_at" FROM `accounts`;--> statement-breakpoint
DROP TABLE `accounts`;--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_institutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_institutions`("id", "user_id", "name", "created_at") SELECT "id", "user_id", "name", "created_at" FROM `institutions`;--> statement-breakpoint
DROP TABLE `institutions`;--> statement-breakpoint
ALTER TABLE `__new_institutions` RENAME TO `institutions`;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`password_is_default` integer DEFAULT false NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`default_currency` text DEFAULT 'PLN' NOT NULL,
	`global_fuzzy_distance` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "password_hash", "is_admin", "password_is_default", "theme", "default_currency", "global_fuzzy_distance", "created_at") SELECT "id", "username", "password_hash", "is_admin", "password_is_default", "theme", "default_currency", "global_fuzzy_distance", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);