# Email Scraper / Web Crawler System

## Overview

A comprehensive email scraping system that integrates seamlessly with the existing Marketing System frontend. The system scrapes publicly available business email addresses from multiple sources while filtering out personal email providers.

## Features

### ✅ Multi-Source Email Scraping
- **LinkedIn**: Extracts emails from company pages and employee profiles
- **Google Search**: Searches for company emails and extracts from result pages
- **Google Maps**: Finds businesses and enriches with website email extraction
- **Company Websites**: Crawls Contact, About, and Careers pages for emails

### ✅ Smart Email Filtering
- **Excludes**: Gmail, Yahoo, Hotmail, Outlook, and other personal email providers
- **Includes**: Only business/domain-based email addresses
- **Validates**: Email format and domain structure

### ✅ Data Extraction
When available, extracts:
- First name
- Last name
- Email address (required)
- Company name
- Job title / role
- Location
- Phone numbers
- Company website

### ✅ Advanced Features
- **Deduplication**: Prevents duplicate emails across all sources
- **Data Merging**: Combines data from multiple sources intelligently
- **Rate Limiting**: Respects rate limits with random delays
- **Error Handling**: Gracefully handles failures and continues
- **Progress Tracking**: Real-time updates for multi-source scraping

## Architecture

### New Modules Created

1. **`src/email-extractor.js`**
   - Centralized email extraction and validation
   - Filters personal email domains
   - Extracts names and titles from context
   - Creates contact objects from emails

2. **`src/google-search-scraper.js`**
   - Scrapes Google Search results for emails
   - Extracts emails from search snippets
   - Visits top results for more emails
   - Filters business emails only

3. **`src/email-scraper-service.js`**
   - Orchestrates all email scraping sources
   - Handles deduplication and merging
   - Manages progress reporting
   - Coordinates multi-source scraping

### Enhanced Modules

1. **`src/scraper.js`** (LinkedIn)
   - Now extracts actual emails from profile pages
   - Checks company About pages for emails
   - Falls back to email generation if no emails found

2. **`main.js`**
   - Added `start-email-scrape` IPC handler
   - Routes to unified email scraper service

3. **`src/index.html`**
   - Added "Email Scraper" tab
   - Source selection checkboxes
   - Configuration form

4. **`src/renderer.js`**
   - Handles Email Scraper UI interactions
   - Displays multi-source progress
   - Shows aggregated results

## Usage

### From the Frontend

1. **Open the Scraper Window**
   - Click "Open Scraper" from the dashboard

2. **Select Email Scraper Tab**
   - Click the "Email Scraper" tab in the scraper interface

3. **Configure the Scrape**
   - **Search Query**: Enter company name, search query, or website URLs
   - **Data Sources**: Select which sources to use:
     - ☑ LinkedIn
     - ☑ Google Search
     - ☑ Google Maps
     - ☑ Websites
   - **Max Results per Source**: Set limit (default: 20)
   - **Industry Tag**: Optional industry categorization
   - **Keywords Tag**: Optional keywords for tagging

4. **Start Scraping**
   - Click "Start Scraping"
   - Monitor progress in real-time
   - View results when complete

### Programmatic Usage

```javascript
// From renderer process
const result = await window.electronAPI.startEmailScrape({
  query: "Microsoft",
  sources: {
    linkedin: true,
    googleSearch: true,
    googleMaps: false,
    websites: true
  },
  maxResultsPerSource: 20,
  industry: "Technology & Software",
  keywords: "B2B"
});
```

## Email Filtering Rules

### ✅ Included
- Business domain emails (e.g., `john@company.com`)
- Corporate email addresses
- Valid email format with proper domain structure

### ❌ Excluded
- `@gmail.com`
- `@yahoo.com`
- `@hotmail.com`
- `@outlook.com`
- `@live.com`
- `@icloud.com`
- Other personal email providers

## Data Flow

```
User Input (Frontend)
    ↓
IPC Handler (main.js)
    ↓
Email Scraper Service (orchestrator)
    ↓
┌─────────────┬──────────────┬──────────────┬─────────────┐
│   LinkedIn  │ Google Search│ Google Maps  │  Websites   │
│   Scraper   │   Scraper    │   Scraper    │   Scraper   │
└─────────────┴──────────────┴──────────────┴─────────────┘
    ↓
Email Extractor (validation & filtering)
    ↓
Deduplication (by email address)
    ↓
Data Merging (combine from multiple sources)
    ↓
Supabase (save to contacts table)
    ↓
Frontend (display results)
```

## Error Handling

- **Individual Source Failures**: Continue with other sources
- **Missing Fields**: Gracefully handle missing names, titles, etc.
- **Rate Limiting**: Automatic delays between requests
- **CAPTCHAs**: Logged for manual intervention
- **Network Errors**: Retry logic with exponential backoff

## Rate Limiting

- Random delays: 1-3 seconds between requests
- Source-specific delays: Longer delays between different sources
- Respectful scraping: Follows robots.txt where applicable

## Deduplication

- **Primary Key**: Email address
- **Strategy**: Keep most complete record
- **Merging**: Combines data from multiple sources intelligently
- **Database**: Uses Supabase upsert with email conflict resolution

## Progress Tracking

Real-time progress updates include:
- Current source being scraped
- Phase of scraping (init, search, extract, save, etc.)
- Number of contacts found
- Number of contacts scraped
- Overall progress across all sources

## Example Output

```javascript
{
  success: true,
  results: [
    {
      email: "john.doe@company.com",
      first_name: "John",
      last_name: "Doe",
      company: "Company Inc",
      job_title: "Marketing Manager",
      source: "linkedin,google_search",
      email_verified: false,
      verification_status: "unverified"
    },
    // ... more contacts
  ],
  stats: {
    total: 45,
    withEmail: 45,
    withPhone: 12,
    bySource: {
      linkedin: { found: 20, errors: 0 },
      googleSearch: { found: 15, errors: 0 },
      googleMaps: { found: 10, errors: 0 },
      websites: { found: 0, errors: 0 }
    }
  },
  errors: null
}
```

## Technical Details

### Email Extraction Algorithm

1. **Text Extraction**: Gets all text and HTML from pages
2. **Regex Matching**: Uses pattern matching to find email addresses
3. **Validation**: Validates format, length, and domain structure
4. **Filtering**: Removes personal email domains
5. **Prioritization**: Sorts business emails first

### Name and Title Extraction

- Attempts to extract names from email context
- Looks for patterns like "John Doe <john@company.com>"
- Extracts job titles from surrounding text
- Falls back to email local part if no name found

### Data Merging Strategy

- Merges contacts by email address
- Prefers non-null values
- Combines sources in source field
- Keeps most complete record

## Future Enhancements

Potential improvements:
- [ ] Add more email sources (Twitter, Facebook Pages)
- [ ] Email verification integration
- [ ] Bulk email validation
- [ ] Export to CSV/Excel
- [ ] Scheduled scraping
- [ ] Email pattern learning from successful scrapes

## Troubleshooting

### No Emails Found
- Check if sources are enabled
- Verify search query is specific enough
- Ensure company has public email addresses
- Try different sources

### Rate Limiting Issues
- Increase delays between requests
- Reduce max results per source
- Use fewer sources simultaneously

### Missing Data
- Some fields may not be available on all sources
- System gracefully handles missing fields
- Data is merged from multiple sources when available

## Support

For issues or questions:
1. Check the implementation plan: `EMAIL_SCRAPER_IMPLEMENTATION_PLAN.md`
2. Review code comments in source files
3. Check browser console for detailed error messages
