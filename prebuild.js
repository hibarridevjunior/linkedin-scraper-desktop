/**
 * Pre-build Script for Marketing System
 * 
 * This script downloads Playwright's Chromium browser and copies it into the project
 * so it can be bundled with the installer.
 * 
 * Run: node prebuild.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[Prebuild]';

function log(msg) {
  console.log(`${LOG_PREFIX} ${msg}`);
}

function logSuccess(msg) {
  console.log(`${LOG_PREFIX} ✓ ${msg}`);
}

function logError(msg) {
  console.error(`${LOG_PREFIX} ✗ ${msg}`);
}

// ============================================
// MAIN SCRIPT
// ============================================

console.log('');
console.log('='.repeat(55));
console.log('  Marketing System - Pre-build Browser Setup');
console.log('='.repeat(55));
console.log('');

// Step 1: Ensure Playwright Chromium is installed
log('Step 1: Installing Chromium via Playwright...');
try {
  execSync('npx playwright install chromium', { 
    stdio: 'inherit',
    env: { ...process.env }
  });
  logSuccess('Chromium installed');
} catch (error) {
  logError('Failed to install Chromium: ' + error.message);
  logError('Make sure you have Node.js and npm installed');
  process.exit(1);
}

// Step 2: Find Playwright's browser cache
log('');
log('Step 2: Locating Chromium installation...');

const homeDir = process.env.USERPROFILE || process.env.HOME;
const possibleCachePaths = [
  path.join(homeDir, 'AppData', 'Local', 'ms-playwright'),  // Windows
  path.join(homeDir, '.cache', 'ms-playwright'),             // Linux
  path.join(homeDir, 'Library', 'Caches', 'ms-playwright'), // macOS
];

let playwrightCache = null;
for (const cachePath of possibleCachePaths) {
  if (fs.existsSync(cachePath)) {
    playwrightCache = cachePath;
    break;
  }
}

if (!playwrightCache) {
  logError('Could not find Playwright browser cache');
  log('Searched in:');
  possibleCachePaths.forEach(p => log('  - ' + p));
  process.exit(1);
}

logSuccess('Found Playwright cache: ' + playwrightCache);

// Step 3: Find the Chromium directory
const cacheContents = fs.readdirSync(playwrightCache);
const chromiumDir = cacheContents.find(d => d.startsWith('chromium-'));

if (!chromiumDir) {
  logError('Could not find Chromium in Playwright cache');
  log('Cache contents: ' + cacheContents.join(', '));
  process.exit(1);
}

const chromiumSource = path.join(playwrightCache, chromiumDir);
logSuccess('Found Chromium: ' + chromiumDir);

// Step 4: Copy to project's playwright-browser folder
log('');
log('Step 3: Copying Chromium to project (this may take a minute)...');

const targetDir = path.join(__dirname, 'playwright-browser', chromiumDir);
const targetBase = path.join(__dirname, 'playwright-browser');

// Remove old browser folder if exists
if (fs.existsSync(targetBase)) {
  log('Removing old browser folder...');
  fs.rmSync(targetBase, { recursive: true, force: true });
}

// Create fresh folder
fs.mkdirSync(targetBase, { recursive: true });

// Copy function
function copyFolderSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const files = fs.readdirSync(from);
  
  for (const file of files) {
    const srcPath = path.join(from, file);
    const destPath = path.join(to, file);
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      copyFolderSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  copyFolderSync(chromiumSource, targetDir);
  logSuccess('Chromium copied to: playwright-browser/' + chromiumDir);
} catch (error) {
  logError('Failed to copy Chromium: ' + error.message);
  process.exit(1);
}

// Step 5: Verify the executable exists
log('');
log('Step 4: Verifying installation...');

const execPath = path.join(targetDir, 'chrome-win', 'chrome.exe');
if (fs.existsSync(execPath)) {
  logSuccess('Chrome executable found: chrome-win/chrome.exe');
} else {
  // Try to find it
  log('Looking for executable...');
  const findExe = (dir) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (file === 'chrome.exe') return fullPath;
      if (fs.statSync(fullPath).isDirectory()) {
        const found = findExe(fullPath);
        if (found) return found;
      }
    }
    return null;
  };
  const found = findExe(targetDir);
  if (found) {
    logSuccess('Chrome executable found: ' + found.replace(targetDir, ''));
  } else {
    logError('Could not find chrome.exe - build may fail');
  }
}

// Step 6: Calculate size
log('');
log('Step 5: Calculating bundle size...');

function getFolderSize(dir) {
  let size = 0;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      size += getFolderSize(filePath);
    } else {
      size += stat.size;
    }
  }
  return size;
}

const sizeBytes = getFolderSize(targetDir);
const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
logSuccess(`Browser size: ${sizeMB} MB`);

// Done!
console.log('');
console.log('='.repeat(55));
console.log('  ✅ Pre-build setup complete!');
console.log('='.repeat(55));
console.log('');
console.log('Chromium browser has been bundled into your project.');
console.log('');
console.log('Next steps:');
console.log('  1. npm run build:win    - Build the Windows installer');
console.log('  2. Look in dist/ folder for the .exe installer');
console.log('');