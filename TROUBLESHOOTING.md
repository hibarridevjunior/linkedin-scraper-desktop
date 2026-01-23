# Troubleshooting: "Cannot read properties of undefined (reading 'startEmailScrape')"

## Issue
You're seeing an error: `Cannot read properties of undefined (reading 'startEmailScrape')`

## Solution

### Step 1: Restart the Electron Application
The most common cause is that the app needs to be restarted for the new `preload.js` changes to take effect.

1. **Close the application completely**
2. **Restart the application** using:
   ```bash
   npm start
   ```
   or if you're running the built version, close and reopen it.

### Step 2: Verify the Preload Script is Loaded

Open the browser DevTools (F12 or Ctrl+Shift+I) and check the console:

1. Type in the console:
   ```javascript
   window.electronAPI
   ```
   You should see an object with methods including `startEmailScrape`.

2. If `window.electronAPI` is `undefined`, the preload script isn't loading correctly.

3. Check if `startEmailScrape` exists:
   ```javascript
   window.electronAPI?.startEmailScrape
   ```
   Should return a function, not `undefined`.

### Step 3: Check File Paths

Verify that `preload.js` exists in the root directory:
- `linkedin-scraper-desktop/preload.js`

And that `main.js` references it correctly:
- Line 23: `preload: path.join(__dirname, 'preload.js')`
- Line 44: `preload: path.join(__dirname, 'preload.js')`

### Step 4: Clear Cache (if needed)

If restarting doesn't work:

1. Close the app completely
2. Delete any cached files (if applicable)
3. Restart the app

### Step 5: Verify the Code

Check that `preload.js` contains:
```javascript
startEmailScrape: (config) => ipcRenderer.invoke('start-email-scrape', config),
```

And that `main.js` has the handler:
```javascript
ipcMain.handle('start-email-scrape', async (event, config) => {
  // ... handler code
});
```

## Common Causes

1. **App not restarted** - Most common! The preload script is loaded when the window is created.
2. **Cached preload script** - Electron may cache the old version
3. **File path issues** - Preload script not found at expected location
4. **Syntax errors** - Check console for any JavaScript errors

## Still Having Issues?

1. Check the browser console for any errors
2. Verify all files were saved correctly
3. Try rebuilding the app:
   ```bash
   npm run build:win
   ```
