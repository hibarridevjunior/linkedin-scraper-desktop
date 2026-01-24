# Handling Google CAPTCHA

## What is a CAPTCHA?

Google shows a CAPTCHA (Completely Automated Public Turing test) when it detects automated browsing. This is a security measure to prevent bots.

## What Happens When CAPTCHA Appears

When the scraper detects a CAPTCHA:

1. **Browser window opens** showing the CAPTCHA
2. **Progress message appears**: "⚠️ Google CAPTCHA detected. Please solve it in the browser window..."
3. **Scraper waits** for you to solve it (up to 2 minutes)
4. **After solving**, the scraper continues automatically

## How to Solve CAPTCHA

1. **Look at the browser window** that opened
2. **Follow the instructions** on the CAPTCHA page:
   - Click "I'm not a robot" checkbox
   - Select images if prompted
   - Complete any verification steps
3. **Wait** - The scraper will detect when it's solved and continue
4. **Don't close the browser** - Let it continue automatically

## Tips to Avoid CAPTCHAs

### 1. Use Other Sources First
- Try **LinkedIn** or **Google Maps** first
- These are less likely to show CAPTCHAs
- Use Google Search as a backup

### 2. Reduce Search Frequency
- Don't run multiple Google searches in quick succession
- Wait a few minutes between searches
- Use fewer max results per source

### 3. Use More Specific Queries
- Specific queries: "financial advisor in Johannesburg"
- Less generic: Avoid very broad terms
- Add location: Helps narrow results

### 4. Enable Multiple Sources
- If Google Search hits CAPTCHA, other sources still work
- LinkedIn, Google Maps, and Websites can continue
- You'll still get results from other sources

## What to Do If CAPTCHA Keeps Appearing

### Option 1: Skip Google Search
- Uncheck Google Search in source selection
- Use LinkedIn, Google Maps, or Websites instead
- These sources are more reliable

### Option 2: Solve Manually
- Solve the CAPTCHA when it appears
- The scraper will continue automatically
- Usually only happens once per session

### Option 3: Wait and Retry
- Wait 10-15 minutes
- Try again with a different query
- Google may have rate-limited temporarily

## Error Messages

### "CAPTCHA not solved within 2 minutes"
- **Solution**: Solve the CAPTCHA faster, or try other sources
- The scraper will continue with other sources automatically

### "Google CAPTCHA detected"
- **Solution**: Look at the browser window and solve the CAPTCHA
- The scraper is waiting for you to complete it

## Best Practices

1. **Start with LinkedIn/Google Maps** - Less likely to trigger CAPTCHAs
2. **Use Google Search as supplement** - Not primary source
3. **Solve CAPTCHA when it appears** - Takes 30 seconds
4. **Don't panic** - Other sources still work even if Google Search fails

## Why This Happens

- Google detects automated browsing patterns
- Too many requests in short time
- Unusual traffic patterns
- Security measure to protect their servers

## The Good News

- **Other sources still work** - LinkedIn, Google Maps, Websites
- **Scraper continues automatically** - After you solve CAPTCHA
- **Only affects Google Search** - Not other scrapers
- **Temporary** - Usually only happens once

## Summary

If you see a CAPTCHA:
1. ✅ Don't close the browser
2. ✅ Solve it in the browser window
3. ✅ Wait for scraper to continue
4. ✅ Or use other sources instead

The scraper is designed to handle this gracefully and continue with other sources even if Google Search fails.
