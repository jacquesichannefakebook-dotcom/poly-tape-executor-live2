ALTER TABLE `executor_state` ADD `risk_configured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `executor_state` ADD `max_orders_per_day` integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `executor_state` ADD `base_stake` real DEFAULT 1.25 NOT NULL;--> statement-breakpoint
ALTER TABLE `executor_state` ADD `last_scheduled_cycle_at` integer;