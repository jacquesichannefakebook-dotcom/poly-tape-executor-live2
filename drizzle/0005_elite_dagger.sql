CREATE TABLE `execution_network` (
	`key` text PRIMARY KEY NOT NULL,
	`proxy_url` text NOT NULL,
	`execution_region` text NOT NULL,
	`installed_at` integer NOT NULL,
	`last_verified_at` integer NOT NULL
);
