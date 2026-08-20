CREATE TABLE `credential_vault` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`version` integer NOT NULL,
	`actor_hash` text NOT NULL,
	`updated_at` integer NOT NULL
);
