/**
 * Browser Helper for Marketing System
 * 
 * This module provides the correct browser executable path for both:
 * - Development: Uses Playwright's default location
 * - Production (packaged app): Uses bundled browser in resources folder
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Get the path to the bundled Chromium browser
 * Returns null if not found (falls back to Playwright default)
 */
function getBundledBrowserPath() {
  // Check if we're running in a packaged Electron app
  const isPackaged = process.mainModule?.filename?.includes('app.asar') ||
                     process.resourcesPath !== undefined;

  let browserBasePath;

  if (isPackaged) {
    // Production: Browser is in resources/playwright-browser
    browserBasePath = path.join(process.resourcesPath, 'playwright-browser');
  } else {
    // Development: Browser is in project's playwright-browser folder
    browserBasePath = path.join(__dirname, 'playwright-browser');
  }

  // Check if the folder exists
  if (!fs.existsSync(browserBasePath)) {
    console.log('[Browser Helper] No bundled browser found at:', browserBasePath);
    return null;
  }

  // Find the chromium-XXXX folder
  const contents = fs.readdirSync(browserBasePath);
  const chromiumDir = contents.find(d => d.startsWith('chromium-'));

  if (!chromiumDir) {
    console.log('[Browser Helper] No chromium folder found in:', browserBasePath);
    return null;
  }

  // Construct the executable path
  // Structure varies: could be chrome-win/chrome.exe or chrome-win64/chrome.exe
  const possiblePaths = [
    path.join(browserBasePath, chromiumDir, 'chrome-win', 'chrome.exe'),
    path.join(browserBasePath, chromiumDir, 'chrome-win64', 'chrome.exe'),
    path.join(browserBasePath, chromiumDir, 'chrome.exe'),
  ];

  for (const exePath of possiblePaths) {
    if (fs.existsSync(exePath)) {
      console.log('[Browser Helper] Found bundled browser:', exePath);
      return exePath;
    }
  }

  // Try to find chrome.exe recursively
  const findExe = (dir, depth = 0) => {
    if (depth > 5) return null; // Prevent infinite recursion
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (file === 'chrome.exe') return fullPath;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const found = findExe(fullPath, depth + 1);
          if (found) return found;
        }
      }
    } catch (e) {
      // Ignore permission errors
    }
    return null;
  };

  const foundPath = findExe(path.join(browserBasePath, chromiumDir));
  if (foundPath) {
    console.log('[Browser Helper] Found bundled browser (recursive):', foundPath);
    return foundPath;
  }

  console.log('[Browser Helper] Could not find chrome.exe in bundled browser');
  return null;
}

/**
 * Launch browser with correct executable path
 * Automatically uses bundled browser if available
 * 
 * @param {Object} options - Playwright launch options
 * @returns {Promise<Browser>} Playwright browser instance
 */
async function launchBrowser(options = {}) {
  const bundledPath = getBundledBrowserPath();
  
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...options,
  };

  // Use bundled browser if available
  if (bundledPath) {
    launchOptions.executablePath = bundledPath;
    console.log('[Browser Helper] Launching bundled browser');
  } else {
    console.log('[Browser Helper] Launching Playwright default browser');
  }

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    // If bundled browser fails, provide helpful error message
    if (bundledPath && error.message.includes("Executable doesn't exist")) {
      throw new Error(
        `Browser not found at: ${bundledPath}\n\n` +
        `This usually means the browser wasn't bundled correctly.\n` +
        `Please contact support or try reinstalling the application.`
      );
    }
    
    // If Playwright browser is not installed
    if (error.message.includes("Executable doesn't exist") || 
        error.message.includes("chromium") && error.message.includes("not found")) {
      throw new Error(
        `Playwright Chromium browser is not installed.\n\n` +
        `Please run the following command to install it:\n\n` +
        `  npm run install-browsers\n\n` +
        `Or manually:\n` +
        `  npx playwright install chromium\n\n` +
        `Then restart the application.`
      );
    }
    
    throw error;
  }
}

module.exports = {
  launchBrowser,
  getBundledBrowserPath
};