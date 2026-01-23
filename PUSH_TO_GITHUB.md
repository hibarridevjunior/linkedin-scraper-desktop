# Push to GitHub - Step by Step

## Prerequisites
- Git installed on your computer
- GitHub account access to the repository

## Steps

### Step 1: Open Terminal/Command Prompt
Navigate to your project folder:
```bash
cd linkedin-scraper-desktop
```

### Step 2: Initialize Git (if not already done)
```bash
git init
```

### Step 3: Add Remote Repository
```bash
git remote add origin https://github.com/hibarridevjunior/linkedin-scraper-desktop.git
```

### Step 4: Add All Files
```bash
git add .
```

### Step 5: Commit Changes
```bash
git commit -m "Initial commit: Marketing System v2.0.0 with Email Scraper"
```

### Step 6: Push to GitHub
```bash
git branch -M main
git push -u origin main
```

## If Repository Already Has Content

If the repository already has files, you may need to pull first:
```bash
git pull origin main --allow-unrelated-histories
```

Then push:
```bash
git push -u origin main
```

## Quick One-Liner (if starting fresh)

```bash
git init && git add . && git commit -m "Initial commit: Marketing System v2.0.0 with Email Scraper" && git branch -M main && git remote add origin https://github.com/hibarridevjunior/linkedin-scraper-desktop.git && git push -u origin main
```

## What Gets Pushed

✅ Source code files
✅ Configuration files
✅ Documentation
❌ node_modules/ (excluded by .gitignore)
❌ dist/ (excluded by .gitignore)
❌ Build artifacts (excluded by .gitignore)

## Troubleshooting

### If you get "repository not found":
- Check you have access to the repository
- Verify the URL is correct
- Make sure you're authenticated with GitHub

### If you get authentication errors:
```bash
# Use GitHub CLI or set up SSH keys
# Or use Personal Access Token
```

### If files are too large:
- Make sure .gitignore is working
- Check node_modules isn't being tracked
