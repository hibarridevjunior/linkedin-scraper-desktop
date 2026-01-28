# Database Migrations

## Add search_query Column

To add the `search_query` column to your contacts table:

1. Open your Supabase dashboard
2. Go to **SQL Editor**
3. Copy and paste the contents of `add_search_query_column.sql`
4. Click **Run**

This will add the `search_query` column to store the original search query used when scraping contacts.

**Note**: This migration is safe to run multiple times - it checks if the column exists before adding it.
