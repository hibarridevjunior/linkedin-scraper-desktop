-- Migration: Add linkedin_url column to contacts table (for Sales Nav / extension profile links)
-- Run this in your Supabase SQL Editor if the column does not exist

ALTER TABLE contacts 
ADD COLUMN IF NOT EXISTS linkedin_url VARCHAR(500);

COMMENT ON COLUMN contacts.linkedin_url IS 'LinkedIn profile or Sales Navigator lead URL';
