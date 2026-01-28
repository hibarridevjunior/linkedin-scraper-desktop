 -- Migration: Add search_query column to contacts table
-- Run this in your Supabase SQL Editor

-- Add search_query column if it doesn't exist
ALTER TABLE contacts 
ADD COLUMN IF NOT EXISTS search_query VARCHAR(200);

-- Add comment to document the column
COMMENT ON COLUMN contacts.search_query IS 'Original search query used when scraping this contact';

-- Create a function to allow programmatic column creation (optional)
CREATE OR REPLACE FUNCTION add_search_query_column()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'contacts' 
        AND column_name = 'search_query'
    ) THEN
        ALTER TABLE contacts 
        ADD COLUMN search_query VARCHAR(200);
        
        COMMENT ON COLUMN contacts.search_query IS 'Original search query used when scraping this contact';
    END IF;
END;
$$;
