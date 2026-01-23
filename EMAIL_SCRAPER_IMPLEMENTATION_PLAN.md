# Email Scraper / Web Crawler Implementation Plan

## Overview
Build a comprehensive email scraping system that integrates with the existing Marketing System frontend. The system will scrape publicly available business emails from multiple sources while respecting rate limits and filtering out personal email providers.

## Architecture

### 1. New Modules to Create

#### A. Google Search Scraper (`src/google-search-scraper.js`)
- **Purpose**: Scrape email addresses from Google Search results
- **Functionality**:
  - Search for companies/domains with email patterns
  - Extract emails from search result snippets
  - Visit top results to extract more emails
  - Filter out personal email domains
- **Input**: Search query (e.g., "company name email contact")
- **Output**: Array of contact objects with emails

#### B. Enhanced Email Extraction Utilities (`src/email-extractor.js`)
- **Purpose**: Centralized email extraction and validation logic
- **Functionality**:
  - Extract emails from HTML/text content
  - Validate email format
  - Filter personal email domains (gmail, yahoo, hotmail, outlook)
  - Prioritize business emails
  - Extract names and job titles from context

#### C. Unified Email Scraper Service (`src/email-scraper-service.js`)
- **Purpose**: Orchestrate all email scraping sources
- **Functionality**:
  - Coordinate between LinkedIn, Google Search, Google Maps, Website scrapers
  - Handle deduplication
  - Merge data from multiple sources
  - Progress reporting
  - Error handling

### 2. Enhancements to Existing Modules

#### A. LinkedIn Scraper (`src/scraper.js`)
- Add email extraction from company "About" pages
- Extract emails from profile descriptions/bios
- Better name extraction from email context

#### B. Google Maps Scraper (`src/googlemaps-scraper.js`)
- Already has website enrichment - ensure it's extracting emails properly
- No major changes needed

#### C. Website Scraper (`src/website-scraper.js`)
- Already extracts emails - ensure comprehensive page coverage
- Add more page types: Careers, Team, Leadership pages

### 3. Frontend Integration

#### A. New UI Tab in `src/index.html`
- Add "Email Scraper" tab alongside LinkedIn, Google Maps, Website
- Form fields:
  - Search query / Company name
  - Source selection (checkboxes: LinkedIn, Google Search, Google Maps, Websites)
  - Max results per source
  - Industry tag (optional)
- Progress display
- Results table

#### B. Renderer Updates (`src/renderer.js`)
- Handle new email scraper form
- Display progress from multiple sources
- Show aggregated results

#### C. IPC Handlers (`main.js`)
- `start-email-scrape` - Main entry point
- Routes to appropriate scrapers based on source selection
- Aggregates results
- Handles deduplication

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
Supabase (save to contacts table)
    ↓
Frontend (display results)
```

## Implementation Steps

1. **Create Email Extractor Utility** - Reusable email extraction logic
2. **Build Google Search Scraper** - New scraper for Google Search results
3. **Enhance LinkedIn Scraper** - Better email extraction from company pages
4. **Create Email Scraper Service** - Unified orchestrator
5. **Add IPC Handlers** - Connect to Electron main process
6. **Update Frontend** - Add new tab and UI
7. **Update Renderer** - Handle new scraper interactions
8. **Test Integration** - Verify all sources work together

## Key Features

### Email Filtering Rules
- ✅ Include: Business domain emails (e.g., @company.com)
- ❌ Exclude: gmail.com, yahoo.com, hotmail.com, outlook.com, live.com, icloud.com
- ✅ Validate: Proper email format, domain exists
- ✅ Prioritize: Business emails over personal

### Rate Limiting
- Random delays between requests (1-3 seconds)
- Respect robots.txt (where applicable)
- Handle CAPTCHAs gracefully
- Retry logic for failed requests

### Error Handling
- Continue on individual failures
- Log errors for debugging
- Report failed sources to user
- Graceful degradation

### Deduplication
- Primary key: Email address
- Merge data from multiple sources
- Keep most complete record
- Update existing contacts if new data is available

## File Structure

```
src/
├── email-extractor.js          (NEW - Email extraction utilities)
├── google-search-scraper.js    (NEW - Google Search scraper)
├── email-scraper-service.js    (NEW - Unified service)
├── scraper.js                  (ENHANCED - Better email extraction)
├── googlemaps-scraper.js      (VERIFY - Already good)
├── website-scraper.js          (ENHANCED - More page types)
├── index.html                  (UPDATED - New tab)
└── renderer.js                 (UPDATED - Handle new scraper)

main.js                         (UPDATED - New IPC handlers)
```

## Testing Checklist

- [ ] Google Search scraper extracts emails correctly
- [ ] LinkedIn company page email extraction works
- [ ] All sources integrate properly
- [ ] Deduplication prevents duplicate emails
- [ ] Personal email domains are filtered
- [ ] Missing fields don't cause errors
- [ ] Rate limiting works as expected
- [ ] Progress updates display correctly
- [ ] Error handling is graceful
- [ ] Data saves to Supabase correctly
