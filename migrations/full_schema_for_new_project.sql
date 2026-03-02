-- =============================================================================
-- Full schema for a NEW Supabase project (clean build — all counts start at 0)
-- Run this entire file in Supabase Dashboard → SQL Editor → New query → Run
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. CONTACTS (main table; app uses upsert on email and update by linkedin_url)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Identity
  email VARCHAR(255) UNIQUE,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  job_title VARCHAR(100),
  company VARCHAR(100),

  -- Source & search
  source VARCHAR(50),
  search_query VARCHAR(200),
  search_run_id VARCHAR(100),
  linkedin_url VARCHAR(500),

  -- Verification
  email_verified BOOLEAN DEFAULT false,
  verification_status VARCHAR(50) DEFAULT 'unverified',
  verification_details TEXT,

  -- Extra fields
  email_domain VARCHAR(100),
  industry VARCHAR(100),
  keywords VARCHAR(100),
  location VARCHAR(100),
  phone_number VARCHAR(50),
  mobile_number VARCHAR(50),
  whatsapp_number VARCHAR(50),
  company_website VARCHAR(255),
  company_summary VARCHAR(500)
);

-- Allow upsert by email (app uses onConflict: 'email')
-- UNIQUE on email is already in the table definition above.

-- Unique index on linkedin_url so Sales Nav / extension can upsert by profile URL
CREATE UNIQUE INDEX IF NOT EXISTS contacts_linkedin_url_key
  ON contacts (linkedin_url)
  WHERE linkedin_url IS NOT NULL;

COMMENT ON TABLE contacts IS 'Contacts from LinkedIn, Google Maps, websites, etc.';

-- -----------------------------------------------------------------------------
-- 2. EMAIL_CAMPAIGNS (saved email drafts/campaigns)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  name VARCHAR(255),
  subject VARCHAR(500),
  html_content TEXT,
  text_content TEXT,
  from_email VARCHAR(255),
  reply_to VARCHAR(255),
  status VARCHAR(50) DEFAULT 'draft'
);

COMMENT ON TABLE email_campaigns IS 'Saved email campaign templates';

-- -----------------------------------------------------------------------------
-- 3. EMAIL_LOGS (send history for analytics)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sent_at TIMESTAMPTZ DEFAULT now(),
  campaign_id UUID REFERENCES email_campaigns(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  email VARCHAR(255),
  status VARCHAR(50),
  message_id VARCHAR(500),
  error_message TEXT
);

COMMENT ON TABLE email_logs IS 'Log of sent/failed emails per campaign';

-- -----------------------------------------------------------------------------
-- 4. Optional: RPC for auto-adding search_query column (used by app if column missing)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION add_search_query_column()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'search_query'
  ) THEN
    ALTER TABLE contacts ADD COLUMN search_query VARCHAR(200);
    COMMENT ON COLUMN contacts.search_query IS 'Original search query used when scraping this contact';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Row Level Security (optional but recommended for Supabase)
-- Enable if you want to restrict access later; anon key can still read/write with default policies.
-- -----------------------------------------------------------------------------
-- ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
-- Then create policies as needed for your anon key.

-- Done. Your new project now has the same schema as the app expects.
