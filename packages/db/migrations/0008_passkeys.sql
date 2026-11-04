-- 0008 · Passkeys (user decision, 4 Nov 2026): the table of the Better Auth passkey plugin, in the
-- auth schema. It holds public keys only: biometrics and private keys never leave the user's device.
-- Goes with the user when an account is purged (§8.6).

CREATE TABLE auth."passkey" (
  "id"           text NOT NULL PRIMARY KEY,
  "name"         text,
  "publicKey"    text NOT NULL,
  "userId"       text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "credentialID" text NOT NULL UNIQUE,
  "counter"      integer NOT NULL,
  "deviceType"   text NOT NULL,
  "backedUp"     boolean NOT NULL,
  "transports"   text,
  "createdAt"    timestamptz,
  "aaguid"       text
);
CREATE INDEX "passkey_userId_idx" ON auth."passkey" ("userId");

GRANT SELECT, INSERT, UPDATE, DELETE ON auth."passkey" TO auth_app;
