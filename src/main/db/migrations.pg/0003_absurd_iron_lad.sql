CREATE INDEX IF NOT EXISTS "run_logs_jobId_startedAt_id_idx" ON "run_logs" USING btree ("jobId","startedAt","id");
