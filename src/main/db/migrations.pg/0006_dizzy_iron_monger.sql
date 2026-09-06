CREATE TABLE IF NOT EXISTS "job_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"jobId" integer NOT NULL,
	"changedAt" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"changedFields" jsonb NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_revisions" ADD CONSTRAINT "job_revisions_jobId_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_revisions_jobId_changedAt_id_idx" ON "job_revisions" USING btree ("jobId","changedAt","id");