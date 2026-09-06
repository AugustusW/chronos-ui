CREATE TABLE `job_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`changedAt` integer NOT NULL,
	`source` text NOT NULL,
	`changedFields` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_revisions_jobId_changedAt_id_idx` ON `job_revisions` (`jobId`,`changedAt`,`id`);