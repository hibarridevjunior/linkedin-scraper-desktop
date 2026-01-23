/**
 * Verify Browser is Bundled in Built App
 * 
 * Run this after building to check if the browser is included
 */

const fs = require('fs');
const path = require('path');

console.log('Checking if browser is bundled...\n');

// Check in dist folder
const distPath = path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'playwright-browser');

if (!fs.existsSync(distPath)) {
  console.log('❌ Browser NOT bundled!');
  console.log(`   Path not found: ${distPath}`);
  console.log('\n   Make sure you ran: npm run build:win');
  process.exit(1);
}

console.log('✓ playwright-browser folder exists');

// Check for chromium folder
const chromiumDirs = fs.readdirSync(distPath).filter(d => d.startsWith('chromium-'));
if (chromiumDirs.length === 0) {
  console.log('❌ Chromium folder not found!');
  process.exit(1);
}

const chromiumDir = chromiumDirs[0];
console.log(`✓ Found: ${chromiumDir}`);

// Check for chrome.exe
const possiblePaths = [
  path.join(distPath, chromiumDir, 'chrome-win', 'chrome.exe'),
  path.join(distPath, chromiumDir, 'chrome-win64', 'chrome.exe'),
  path.join(distPath, chromiumDir, 'chrome.exe'),
];

let chromeExe = null;
for (const exePath of possiblePaths) {
  if (fs.existsSync(exePath)) {
    chromeExe = exePath;
    break;
  }
}

if (!chromeExe) {
  // Try recursive search
  function findExe(dir, depth = 0) {
    if (depth > 5) return null;
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
    } catch (e) {}
    return null;
  }
  chromeExe = findExe(path.join(distPath, chromiumDir));
}

if (chromeExe) {
  const stats = fs.statSync(chromeExe);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  console.log(`✓ Chrome.exe found: ${path.relative(distPath, chromeExe)}`);
  console.log(`✓ Size: ${sizeMB} MB`);
  console.log('\n✅ Browser IS bundled! Users won\'t need to install it separately.');
} else {
  console.log('❌ chrome.exe NOT found!');
  console.log('   Browser is NOT properly bundled.');
  process.exit(1);
}
