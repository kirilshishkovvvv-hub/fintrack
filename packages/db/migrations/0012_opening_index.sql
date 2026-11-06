-- 0012 · Finding a workspace's opening balances without reading its whole history (NFR-03).
CREATE INDEX transactions_opening_idx ON fin.transactions (workspace_id, txn_date)
  WHERE kind = 'opening_balance' AND status = 'posted';
