-- Migration: Allow upsert by linkedin_url so extension can send batches without duplicates (parallel Run + Enrich)
-- Run this in your Supabase SQL Editor after add_linkedin_url_column.sql

-- Unique index so multiple POSTs of the same lead (e.g. from different batches) update one row
CREATE UNIQUE INDEX IF NOT EXISTS contacts_linkedin_url_key
  ON contacts (linkedin_url)
  WHERE linkedin_url IS NOT NULL;
