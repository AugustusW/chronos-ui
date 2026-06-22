CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`platform` text NOT NULL,
	`scheduleExpr` text NOT NULL,
	`command` text NOT NULL,
	`workingDir` text,
	`env` text,
	`enabled` integer DEFAULT true NOT NULL,
	`adopted` integer DEFAULT false NOT NULL,
	`timeoutSec` integer,
	`category` text,
	`lastRunAt` integer,
	`lastResult` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`triggeredBy` text NOT NULL,
	`result` text,
	`startedAt` integer NOT NULL,
	`endedAt` integer,
	`durationMs` integer,
	`exitCode` integer,
	`stdout` text,
	`stderr` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
