ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "requested_resolver_policy" text NOT NULL DEFAULT 'board_only';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "effective_resolver_policy" text NOT NULL DEFAULT 'board_only';--> statement-breakpoint
ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "addressee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "resolved_by_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_addressee_agent_id_agents_id_fk') THEN
    ALTER TABLE "issue_thread_interactions"
      ADD CONSTRAINT "issue_thread_interactions_addressee_agent_id_agents_id_fk"
      FOREIGN KEY ("addressee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_thread_interactions_resolved_by_run_id_heartbeat_runs_id_fk') THEN
    ALTER TABLE "issue_thread_interactions"
      ADD CONSTRAINT "issue_thread_interactions_resolved_by_run_id_heartbeat_runs_id_fk"
      FOREIGN KEY ("resolved_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_agent_idx"
  ON "issue_thread_interactions" USING btree ("addressee_agent_id");
