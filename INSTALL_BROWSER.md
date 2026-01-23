# Installing Playwright Browser

## Quick Fix

The Playwright Chromium browser needs to be installed before you can use the scrapers.

### Option 1: Using npm script (Recommended)
```bash
cd linkedin-scraper-desktop
npm run install-browsers
```

### Option 2: Using npx directly
```bash
cd linkedin-scraper-desktop
npx playwright install chromium
```

### Option 3: Install all browsers (if needed)
```bash
cd linkedin-scraper-desktop
npx playwright install
```

## After Installation

1. **Restart the Electron app**:
   ```bash
   npm start
   ```

2. **Verify installation**:
   - The browser should be installed to: `C:\Users\<username>\AppData\Local\ms-playwright\chromium-1200\`
   - Or in the project's `playwright-browser` folder if bundled

## What This Does

- Downloads Chromium browser (~300MB)
- Installs it to the Playwright cache directory
- Makes it available for the scrapers to use

## Troubleshooting

### If installation fails:
1. Check your internet connection
2. Ensure you have enough disk space (~500MB free)
3. Try running as administrator if permission errors occur

### If browser still not found:
1. Check if the path exists: `C:\Users\<username>\AppData\Local\ms-playwright\chromium-1200\`
2. Try reinstalling: `npx playwright install --force chromium`
3. Check the console for the exact error message

### Alternative: Use Bundled Browser
If you're running a built/packaged version, the browser should be bundled. If not:
1. Check the `playwright-browser` folder exists in the project
2. Rebuild the application to include the browser

## Verification

After installation, try running a scraper. The browser should launch automatically without errors.
