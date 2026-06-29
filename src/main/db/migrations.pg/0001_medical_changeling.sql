CREATE TABLE IF NOT EXISTS "notify_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"jobId" integer NOT NULL,
	"jobName" text NOT NULL,
	"result" text NOT NULL,
	"exitCode" integer,
	"occurredAt" timestamp with time zone NOT NULL,
	"sentAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notify_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"chatId" text,
	"windowMin" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "notifyOnFailure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notify_outbox" ADD CONSTRAINT "notify_outbox_jobId_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
