CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_currency` text DEFAULT 'PLN' NOT NULL,
	`global_fuzzy_distance` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `password_is_default` integer DEFAULT false NOT NULL;