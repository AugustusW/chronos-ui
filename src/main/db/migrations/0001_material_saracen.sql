CREATE TABLE `notify_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`jobName` text NOT NULL,
	`result` text NOT NULL,
	`exitCode` integer,
	`occurredAt` integer NOT NULL,
	`sentAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notify_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`chatId` text,
	`windowMin` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `notifyOnFailure` integer DEFAULT false NOT NULL;