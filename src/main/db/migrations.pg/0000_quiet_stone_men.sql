CREATE TABLE IF NOT EXISTS "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"platform" text NOT NULL,
	"scheduleExpr" text NOT NULL,
	"command" text NOT NULL,
	"workingDir" text,
	"env" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"adopted" boolean DEFAULT false NOT NULL,
	"timeoutSec" integer,
	"category" text,
	"lastRunAt" timestamp with time zone,
	"lastResult" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"jobId" integer NOT NULL,
	"triggeredBy" text NOT NULL,
	"result" text,
	"startedAt" timestamp with time zone NOT NULL,
	"endedAt" timestamp with time zone,
	"durationMs" integer,
	"exitCode" integer,
	"stdout" text,
	"stderr" text,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_jobId_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
