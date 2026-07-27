ALTER TABLE devices
  ADD COLUMN apns_environment TEXT NOT NULL DEFAULT 'production'
  CHECK (apns_environment IN ('development', 'production'));
