CREATE TABLE `execution_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`order_id` text NOT NULL,
	`purpose` text NOT NULL,
	`side` text NOT NULL,
	`order_type` text NOT NULL,
	`post_only` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`requested_price` real NOT NULL,
	`requested_size` real NOT NULL,
	`filled_size` real DEFAULT 0 NOT NULL,
	`average_fill_price` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`canceled_at` integer,
	`failure_reason` text,
	`transaction_hash` text,
	FOREIGN KEY (`decision_id`) REFERENCES `execution_decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_orders_order_unique` ON `execution_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `execution_orders_decision_idx` ON `execution_orders` (`decision_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `execution_orders_status_idx` ON `execution_orders` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `execution_strategy` (
	`key` text PRIMARY KEY NOT NULL,
	`maker_entry_enabled` integer DEFAULT true NOT NULL,
	`maker_improvement_ticks` integer DEFAULT 1 NOT NULL,
	`maker_timeout_seconds` integer DEFAULT 90 NOT NULL,
	`taker_fallback_enabled` integer DEFAULT true NOT NULL,
	`take_profit_enabled` integer DEFAULT true NOT NULL,
	`take_profit_percent` real DEFAULT 8 NOT NULL,
	`minimum_profit_ticks` integer DEFAULT 2 NOT NULL,
	`updated_at` integer NOT NULL
);
