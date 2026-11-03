-- 0003 · Consent records (Stage 2 Annex L, items 6 and 17).
-- Each acceptance or withdrawal is stored with the document version and time.
-- Rows are append-only: a withdrawal is a new row, never an edit.

CREATE TABLE fin.consent_records (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  document    text NOT NULL CHECK (document IN ('terms', 'privacy', 'age_18', 'marketing')),
  version     text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  accepted    boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_records_user_idx ON fin.consent_records (user_id, document, recorded_at DESC);

CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON fin.consent_records
  FOR EACH ROW EXECUTE FUNCTION fin.forbid_change();

GRANT SELECT, INSERT ON fin.consent_records TO fin_app;

ALTER TABLE fin.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY own_consents ON fin.consent_records
  USING (user_id = fin.current_user_id()) WITH CHECK (user_id = fin.current_user_id());
