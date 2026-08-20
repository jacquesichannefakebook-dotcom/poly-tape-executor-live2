CREATE TABLE `trading_account_status` (
	`key` text PRIMARY KEY NOT NULL,
	`account_verified_at` integer,
	`approvals_prepared_at` integer,
	`verified_wallet` text,
	`verified_signer` text,
	`wallet_type` text,
	`open_orders_seen` integer,
	`last_auth_error` text,
	`updated_at` integer NOT NULL
);
