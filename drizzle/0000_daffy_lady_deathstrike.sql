CREATE TABLE `cycle_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`candidates` integer DEFAULT 0 NOT NULL,
	`accepted` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `cycle_log_time_idx` ON `cycle_log` (`started_at`);--> statement-breakpoint
CREATE TABLE `execution_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signal_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`source_timestamp` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`outcome` text NOT NULL,
	`market_slug` text,
	`event_slug` text,
	`token_id` text,
	`condition_id` text,
	`score` integer NOT NULL,
	`wallets` integer NOT NULL,
	`operations` integer NOT NULL,
	`buy_pressure` real NOT NULL,
	`flow_amount` real NOT NULL,
	`predicted_probability` real NOT NULL,
	`market_probability` real NOT NULL,
	`edge_points` real NOT NULL,
	`requested_price` real NOT NULL,
	`maximum_price` real NOT NULL,
	`fill_price` real,
	`stake` real DEFAULT 0 NOT NULL,
	`shares` real DEFAULT 0 NOT NULL,
	`spread` real,
	`book_depth` real,
	`order_id` text,
	`transaction_hash` text,
	`reject_reason` text,
	`result` integer,
	`pnl` real,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_decisions_signal_unique` ON `execution_decisions` (`signal_key`);--> statement-breakpoint
CREATE INDEX `execution_decisions_status_time_idx` ON `execution_decisions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `execution_decisions_market_idx` ON `execution_decisions` (`market_slug`,`created_at`);--> statement-breakpoint
CREATE TABLE `executor_state` (
	`key` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'PAPER' NOT NULL,
	`armed` integer DEFAULT false NOT NULL,
	`capital_cap` real DEFAULT 50 NOT NULL,
	`starting_bankroll` real DEFAULT 50 NOT NULL,
	`target_min` integer DEFAULT 4 NOT NULL,
	`target_max` integer DEFAULT 8 NOT NULL,
	`max_stake` real DEFAULT 2.5 NOT NULL,
	`max_exposure` real DEFAULT 5 NOT NULL,
	`max_positions` integer DEFAULT 2 NOT NULL,
	`daily_stop` real DEFAULT 3 NOT NULL,
	`weekly_stop` real DEFAULT 6 NOT NULL,
	`hard_drawdown` real DEFAULT 5 NOT NULL,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`last_cycle_at` integer,
	`last_cycle_status` text,
	`last_error` text,
	`last_geo_blocked` integer,
	`last_geo_country` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
