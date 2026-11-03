-- 0004 · The maintenance role for retention jobs (FR-19, OD-05; Stage 2 §6.3).
-- The application role can never delete financial history. Purging expired trash runs as
-- fin_maintenance instead, and row-level security limits even that role to exactly the rows
-- a purge may touch: trashed transactions, the refunds that point at them, expired
-- idempotency records, and new audit events.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fin_maintenance') THEN
    CREATE ROLE fin_maintenance NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA fin TO fin_maintenance;
GRANT SELECT, DELETE ON fin.transactions, fin.idempotency_records TO fin_maintenance;
GRANT INSERT ON fin.audit_events TO fin_maintenance;

CREATE POLICY maintenance_read ON fin.transactions FOR SELECT TO fin_maintenance
  USING (status = 'trashed' OR refund_of_id IS NOT NULL);
CREATE POLICY maintenance_purge ON fin.transactions FOR DELETE TO fin_maintenance
  USING (status = 'trashed');

CREATE POLICY maintenance_read ON fin.idempotency_records FOR SELECT TO fin_maintenance
  USING (expires_at < now());
CREATE POLICY maintenance_purge ON fin.idempotency_records FOR DELETE TO fin_maintenance
  USING (expires_at < now());

CREATE POLICY maintenance_record ON fin.audit_events FOR INSERT TO fin_maintenance
  WITH CHECK (user_id IS NULL);
