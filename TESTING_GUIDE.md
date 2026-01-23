# Email Scraper Testing Guide

## Quick Test Example

### Step 1: Start the Application
```bash
cd linkedin-scraper-desktop
npm start
```

### Step 2: Open the Scraper Window
- From the main dashboard, click the button to open the scraper window
- Or use the menu option if available

### Step 3: Select Email Scraper Tab
- Click on the **"Email Scraper"** tab (the email icon tab)

### Step 4: Configure the Test

**Example 1: Simple Company Search**
```
Search Query: Microsoft
Data Sources: 
  ☑ LinkedIn
  ☑ Google Search
  ☐ Google Maps
  ☐ Websites
Max Results per Source: 10
Industry Tag: Technology & Software
Keywords Tag: (leave empty)
```

**Example 2: Location-Based Search**
```
Search Query: wealth management companies in Sandton
Data Sources:
  ☐ LinkedIn
  ☑ Google Search
  ☑ Google Maps
  ☐ Websites
Max Results per Source: 15
Industry Tag: Wealth Management
Keywords Tag: B2B
```

**Example 3: Website URLs**
```
Search Query: microsoft.com, apple.com, google.com
Data Sources:
  ☐ LinkedIn
  ☐ Google Search
  ☐ Google Maps
  ☑ Websites
Max Results per Source: 20
Industry Tag: Technology & Software
Keywords Tag: Enterprise
```

### Step 5: Start Scraping
- Click the **"Start Scraping"** button
- Watch the progress updates in real-time
- The browser window will open automatically

### Step 6: Monitor Progress
You should see:
- Current source being scraped (LinkedIn, Google Search, etc.)
- Phase of scraping (Searching, Extracting, Saving, etc.)
- Number of contacts found
- Number of contacts scraped

### Step 7: View Results
When complete, you'll see:
- Total contacts found
- Contacts with emails
- Contacts with phones
- A table showing all scraped contacts
- Option to start a new scrape

## Expected Results

### What You Should See:
1. **Progress Updates**: Real-time status messages
2. **Browser Window**: Opens automatically (don't close it)
3. **Results Table**: Shows scraped contacts with:
   - Name/Company
   - Email address
   - Phone/Job Title
   - Location/Info
4. **Statistics**: Total, with emails, with phones

### What Gets Scraped:
- ✅ Business email addresses (e.g., `john@company.com`)
- ❌ Personal emails are filtered out (gmail, yahoo, etc.)
- ✅ Company names
- ✅ Job titles (when available)
- ✅ Phone numbers (when available)
- ✅ Company websites

## Test Scenarios

### Scenario 1: Single Source Test (LinkedIn)
```
Query: "Tesla"
Sources: Only LinkedIn checked
Max Results: 5
```
**Expected**: Should find Tesla employees with generated emails

### Scenario 2: Multi-Source Test
```
Query: "Microsoft"
Sources: All checked
Max Results: 10 each
```
**Expected**: Should find contacts from LinkedIn, Google Search, Google Maps, and Websites

### Scenario 3: Google Search Only
```
Query: "startup companies email contact"
Sources: Only Google Search checked
Max Results: 20
```
**Expected**: Should extract emails from Google Search results and visited pages

### Scenario 4: Google Maps with Enrichment
```
Query: "restaurants in Cape Town"
Sources: Only Google Maps checked
Max Results: 15
```
**Expected**: Should find businesses on Google Maps, then visit their websites for emails

## Verification Checklist

After scraping, verify:

- [ ] Contacts appear in the results table
- [ ] Emails are business domains (not gmail/yahoo)
- [ ] No duplicate emails (same email appears only once)
- [ ] Data is saved to database (check main dashboard)
- [ ] Progress updates were shown during scraping
- [ ] Statistics are accurate

## Troubleshooting

### If No Results:
1. **Check Sources**: Make sure at least one source is selected
2. **Check Query**: Try a more specific search term
3. **Check Browser**: Make sure the browser window stays open
4. **Check Console**: Look for error messages in DevTools

### If Errors Occur:
1. **Check Console**: Open DevTools (F12) and check for errors
2. **Verify API**: Check that `window.electronAPI.startEmailScrape` exists
3. **Restart App**: Close and restart if API methods are missing
4. **Check Network**: Ensure internet connection is active

### Common Issues:

**"Cannot read properties of undefined"**
- Solution: Restart the Electron app completely

**"No contacts found"**
- Solution: Try a different search query or enable more sources

**"Browser window closes immediately"**
- Solution: This is normal - the scraper controls the browser

## Sample Test Queries

Here are some queries you can try:

1. **Tech Companies**:
   - "Microsoft"
   - "Apple"
   - "Google"
   - "Amazon"

2. **Location-Based**:
   - "law firms in Johannesburg"
   - "accounting firms Cape Town"
   - "real estate agents Sandton"

3. **Industry-Specific**:
   - "wealth management companies"
   - "healthcare providers"
   - "construction companies"

4. **Website URLs**:
   - "microsoft.com, apple.com"
   - "https://example.com"
   - Multiple URLs separated by commas or newlines

## Success Criteria

A successful test should show:
- ✅ At least 1-2 contacts found (depending on query)
- ✅ All emails are business domains
- ✅ No personal email providers (gmail, yahoo, etc.)
- ✅ Data appears in results table
- ✅ Statistics are displayed correctly
- ✅ Can start a new scrape after completion

## Next Steps After Testing

1. **Check Dashboard**: Go back to main dashboard to see saved contacts
2. **Verify Data**: Check that contacts are in the database
3. **Test Email Verification**: Use the email verification feature
4. **Test Email Campaigns**: Try sending emails to scraped contacts

## Notes

- The scraper respects rate limits with random delays
- Some sources may take longer than others
- LinkedIn requires manual login the first time
- Google Search may show CAPTCHAs (rare)
- Results vary based on what's publicly available online
