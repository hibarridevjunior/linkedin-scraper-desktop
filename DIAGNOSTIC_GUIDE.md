# Diagnostic Guide: No Contacts Found

## Issue: "0 contacts added to database"

If you're seeing 0 contacts after scraping, here are the most common causes and solutions:

## Common Causes

### 1. **All Emails Were Filtered Out (Personal Emails)**
**Problem**: The scraper found emails, but they were all from personal providers (gmail, yahoo, etc.) and were filtered out.

**Solution**: 
- Try a more specific search query
- Focus on company websites (they're more likely to have business emails)
- Use Google Maps + Website enrichment (more likely to find business emails)

### 2. **No Emails Found on Pages**
**Problem**: The pages visited didn't contain any email addresses.

**Solution**:
- Try different sources (some companies don't list emails on LinkedIn)
- Use Google Search with "email contact" in the query
- Try website URLs directly

### 3. **LinkedIn Requires Login**
**Problem**: LinkedIn scraper needs you to be logged in.

**Solution**:
- When browser opens, log in to LinkedIn manually
- Wait for the login to complete before the scraper continues

### 4. **Search Query Too Generic**
**Problem**: The search query didn't return relevant results.

**Solution**:
- Be more specific: "Microsoft" instead of "tech companies"
- Add location: "law firms in Johannesburg"
- Use exact company names

### 5. **Sources Not Enabled**
**Problem**: No sources were selected or all sources failed.

**Solution**:
- Check that at least one source is enabled
- Try enabling all sources
- Check the console for error messages

## Diagnostic Steps

### Step 1: Check Browser Console
1. Open DevTools (F12)
2. Look for error messages
3. Check if any sources reported errors

### Step 2: Check What Sources Ran
Look at the progress messages:
- Did you see "Starting LinkedIn scraper..."?
- Did you see "Starting Google Search scraper..."?
- Did any sources complete successfully?

### Step 3: Try a Simple Test
Use this minimal test:
```
Query: microsoft.com
Sources: Only ☑ Websites
Max Results: 5
```

This should find at least 1-2 emails from Microsoft's website.

### Step 4: Check the Browser Window
- Did the browser window open?
- Did it navigate to pages?
- Did you see any CAPTCHAs or blocks?

## Better Test Queries

### High Success Rate Queries:

1. **Direct Website URLs**:
   ```
   Query: microsoft.com, apple.com
   Sources: Websites only
   ```

2. **Google Search with "email"**:
   ```
   Query: Microsoft email contact
   Sources: Google Search only
   ```

3. **Google Maps Business**:
   ```
   Query: restaurants in Cape Town
   Sources: Google Maps only
   ```

## Debugging Tips

### Enable Console Logging
Open DevTools console and look for:
- `Email scraper completed:` - Shows final results
- `Scrape result:` - Shows what was returned
- Error messages from individual scrapers

### Check Individual Sources
Try running one source at a time to see which works:
1. Test LinkedIn only
2. Test Google Search only
3. Test Google Maps only
4. Test Websites only

### Verify Email Filtering
The scraper filters out:
- @gmail.com
- @yahoo.com
- @hotmail.com
- @outlook.com
- Other personal email providers

If all found emails are personal, they'll be filtered out.

## Expected Behavior

### Successful Scrape Should Show:
- Progress messages for each source
- "Found X contacts" messages
- "Saving to database" message
- Results table with contacts
- Statistics showing contacts found

### If No Contacts Found:
- Message: "No contacts found. Try a different search query..."
- Statistics all show 0
- Empty results table
- No error messages (if sources ran successfully)

## Quick Fixes

### Fix 1: Use Website URLs
```
Query: microsoft.com
Sources: Websites
```
This has the highest success rate.

### Fix 2: Enable All Sources
```
Query: Microsoft
Sources: All checked
Max Results: 10 each
```

### Fix 3: More Specific Query
```
Query: Microsoft careers contact email
Sources: Google Search
```

## Still Not Working?

1. **Check Network**: Ensure internet connection is active
2. **Check Browser**: Make sure browser window stays open
3. **Check Console**: Look for JavaScript errors
4. **Try Restart**: Close and restart the Electron app
5. **Check Logs**: Look at the main process console for errors

## Contact Information

If you continue to have issues:
1. Check the browser console for errors
2. Note which sources you enabled
3. Note the search query used
4. Check if any error messages appeared
