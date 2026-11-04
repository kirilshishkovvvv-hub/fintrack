-- 0006 · Session idle tracking (AD-14), per-account login throttling (BR-01.3) and the purge of
-- deleted workspaces (Stage 2 §8.6, GAP-5).
-- The two session columns are Better Auth "additional fields" (see auth.ts); 0002 stays as generated.

ALTER TABLE auth.session
  ADD COLUMN "keepSignedIn" boolean NOT NULL DEFAULT false,
  ADD COLUMN "lastActiveAt" timestamptz;

-- Keyed by an HMAC of the email, so the table holds no address and works the same for
-- addresses that aren't registered (AC-01.2).
CREATE TABLE auth.login_throttle (
  key              text PRIMARY KEY,
  failures         integer NOT NULL,
  first_failure_at timestamptz NOT NULL,
  locked_until     timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.login_throttle TO auth_app;

-- The purge sets app.workspace_id and app.user_id to its target, one workspace per database
-- transaction, so the existing isolation policies confine each delete to that workspace.
GRANT SELECT, DELETE ON
  fin.memberships, fin.ledger_accounts, fin.accounts, fin.categories, fin.payees,
  fin.reconciliations, fin.consent_records
  TO fin_maintenance;
GRANT SELECT, UPDATE ON fin.workspaces TO fin_maintenance;
GRANT EXECUTE ON FUNCTION fin.current_workspace(), fin.current_user_id() TO fin_maintenance;
GRANT USAGE ON SCHEMA auth TO fin_maintenance;
GRANT SELECT, DELETE ON auth."user", auth.login_throttle TO fin_maintenance;

CREATE POLICY maintenance_read ON fin.workspaces FOR SELECT TO fin_maintenance
  USING (status = 'deletion_pending');

-- Consent records stay append-only for the application; only the purge may remove them.
DROP TRIGGER consent_records_append_only ON fin.consent_records;
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON fin.consent_records
  FOR EACH ROW WHEN (current_user <> 'fin_maintenance') EXECUTE FUNCTION fin.forbid_change();
