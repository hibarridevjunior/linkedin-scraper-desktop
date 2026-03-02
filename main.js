const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const https = require('https');

// Load .env from app directory (for clean build: set SUPABASE_URL + SUPABASE_KEY to a new empty project)
require('dotenv').config({ path: path.join(__dirname, '.env') });
const nodemailer = require('nodemailer');
const { verifyEmailSmtp, verifyEmailMxSyntax } = require('./src/smtp-verifier');

// Prevent ECONNRESET and other network errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
  const msg = (err && err.message) ? err.message : String(err);
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('main-error', { message: msg, code: err.code || null });
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection in main process:', reason);
});

let mainWindow;
let scraperWindow;

// Supabase config: set SUPABASE_URL + SUPABASE_KEY to a new empty project for a "clean"
// distribution (all nav counts 0). If unset, uses the default project below.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('src/dashboard.html');
  mainWindow.webContents.openDevTools();
}

function createScraperWindow() {
  if (scraperWindow) {
    scraperWindow.focus();
    return;
  }

  scraperWindow = new BrowserWindow({
    width: 800,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  scraperWindow.loadFile('src/index.html');

  scraperWindow.on('closed', () => {
    scraperWindow = null;
  });
}

const salesNavReceiver = require('./src/sales-nav-receiver');

function onSalesNavRefresh() {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('refresh-data');
}

async function saveExtensionContactsToSupabase(contacts) {
  if (!contacts || contacts.length === 0) return;
  const supabase = getSupabase();
  const withLinkedInUrl = contacts.filter(c => c && c.linkedin_url);
  const withoutLinkedInUrl = contacts.filter(c => c && !c.linkedin_url);

  try {
    // Merge by linkedin_url without requiring a unique constraint: fetch existing, then update or insert
    if (withLinkedInUrl.length > 0) {
      const urls = [...new Set(withLinkedInUrl.map(c => c.linkedin_url.trim()).filter(Boolean))];
      const existingByUrl = new Map();
      const BATCH = 100;
      for (let i = 0; i < urls.length; i += BATCH) {
        const chunk = urls.slice(i, i + BATCH);
        const { data: rows, error: selectErr } = await supabase.from('contacts').select('id, linkedin_url').in('linkedin_url', chunk);
        if (selectErr) throw new Error('Select existing: ' + (selectErr.message || selectErr));
        if (rows && rows.length) rows.forEach(r => { if (r.linkedin_url) existingByUrl.set(r.linkedin_url, r.id); });
      }
      const toUpdate = withLinkedInUrl.filter(c => existingByUrl.has(c.linkedin_url));
      const toInsert = withLinkedInUrl.filter(c => !existingByUrl.has(c.linkedin_url));
      for (const c of toUpdate) {
        const id = existingByUrl.get(c.linkedin_url);
        const { error } = await supabase.from('contacts').update(c).eq('id', id);
        if (error) {
          if (error.code === '23505' && error.message && error.message.includes('email')) {
            const { error: err2 } = await supabase.from('contacts').update({ ...c, email: null }).eq('id', id);
            if (err2) console.error('[Sales Nav receiver] Update (no email) failed:', err2.message);
          } else {
            throw new Error('Update: ' + (error.message || error));
          }
        }
      }
      if (toInsert.length > 0) {
        const seenEmail = new Set();
        const deduped = toInsert.map(c => {
          if (c.email && seenEmail.has(c.email.toLowerCase())) {
            return { ...c, email: null };
          }
          if (c.email) seenEmail.add(c.email.toLowerCase());
          return c;
        });
        const withEmail = deduped.filter(c => c && c.email);
        const withoutEmail = deduped.filter(c => c && !c.email);
        if (withEmail.length > 0) {
          const { error } = await supabase.from('contacts').upsert(withEmail, { onConflict: 'email', ignoreDuplicates: false });
          if (error) throw new Error('Upsert: ' + (error.message || error));
        }
        if (withoutEmail.length > 0) {
          const { error } = await supabase.from('contacts').insert(withoutEmail);
          if (error) throw new Error('Insert: ' + (error.message || error));
        }
      }
    }

    if (withoutLinkedInUrl.length > 0) {
      const withEmail = withoutLinkedInUrl.filter(c => c && c.email);
      const withoutEmail = withoutLinkedInUrl.filter(c => c && !c.email);
      if (withEmail.length > 0) {
        const { error } = await supabase.from('contacts').upsert(withEmail, { onConflict: 'email', ignoreDuplicates: false });
        if (error) throw new Error('Upsert (no url): ' + (error.message || error));
      }
      if (withoutEmail.length > 0) {
        const { error } = await supabase.from('contacts').insert(withoutEmail);
        if (error) throw new Error('Insert (no url): ' + (error.message || error));
      }
    }

    console.log('[Sales Nav receiver] Saved ' + contacts.length + ' contacts to Supabase.');
  } catch (err) {
    console.error('[Sales Nav receiver] Save failed:', err && err.message ? err.message : err);
    throw err;
  }
}

async function updateContactByLinkedInUrl(linkedinUrl, updates) {
  if (!linkedinUrl || typeof linkedinUrl !== 'string') return { data: null, error: new Error('Missing linkedin_url') };
  const supabase = getSupabase();
  let { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('linkedin_url', linkedinUrl.trim())
    .select();
  if (error && error.code === '23505' && updates.email && String(error.message || '').includes('email')) {
    const { email, ...rest } = updates;
    const res = await supabase
      .from('contacts')
      .update(rest)
      .eq('linkedin_url', linkedinUrl.trim())
      .select();
    if (!res.error) return { data: res.data, error: null };
  }
  if (error) console.error('[Sales Nav receiver] Update by linkedin_url error:', error);
  return { data, error };
}

app.whenReady().then(() => {
  createWindow();
  salesNavReceiver.startSalesNavReceiver(getSupabase, saveExtensionContactsToSupabase, onSalesNavRefresh, updateContactByLinkedInUrl);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('open-scraper', () => {
  createScraperWindow();
});

// ============================================
// SCRAPING - Job queue, runner, progress store (~500 leads/day)
// ============================================

const progressStore = require('./src/progress-store');
const searchHistoryStore = require('./src/search-history-store');
const { buildEmailScraperJobs, mergeContacts } = require('./src/email-scraper-service');
const { BETWEEN_JOBS_MS, sleep } = require('./src/cooldown-config');

// Global cancellation flag — cooperative cancellation; runner checks between jobs
let scrapingCancelled = false;
let scrapingStopMode = null; // 'slow' | 'fast' | null; slow = save with emails, fast = save without emails/profiles

function resetCancellationFlag() {
  scrapingCancelled = false;
  scrapingStopMode = null;
}

function isScrapingCancelled() {
  return scrapingCancelled;
}

function getScrapingStopMode() {
  return scrapingStopMode;
}

global.isScrapingCancelled = isScrapingCancelled;

ipcMain.handle('stop-scrape', async (event, mode) => {
  scrapingCancelled = true;
  scrapingStopMode = mode === 'fast' ? 'fast' : 'slow';
  const msg = mode === 'fast'
    ? 'Fast stop — saving leads without emails or LinkedIn profiles'
    : 'Stopping after current operation — all contacts collected so far will be saved (with emails)';
  console.log('[stop-scrape]', msg);
  return { success: true, message: msg };
});

// IPC progress: only counts, phase, source, cancelled/completed — no contact arrays, no Playwright refs
function sendProgress(progress, jobsCompleted, jobsTotal, contactsCollected) {
  const payload = {
    status: progress.status || '',
    phase: progress.phase || 'init',
    source: progress.source || null,
    profilesFound: progress.profilesFound ?? 0,
    profilesScraped: progress.profilesScraped ?? 0,
    cancelled: !!progress.cancelled,
    completed: !!progress.completed,
    error: !!progress.error
  };
  if (progress.stats && typeof progress.stats === 'object') {
    payload.stats = { total: progress.stats.total ?? 0, withEmail: progress.stats.withEmail ?? 0, withPhone: progress.stats.withPhone ?? 0 };
  }
  if (jobsTotal != null) payload.jobsTotal = jobsTotal;
  if (jobsCompleted != null) payload.jobsCompleted = jobsCompleted;
  if (contactsCollected != null) payload.contactsCollected = contactsCollected;
  if (progress.failedUrls) payload.failedUrls = progress.failedUrls;
  if (progress.estimatedSecondsRemaining != null) payload.estimatedSecondsRemaining = progress.estimatedSecondsRemaining;
  if (scraperWindow) scraperWindow.webContents.send('scrape-progress', payload);
}

// Build queue for start-scrape (single job) or start-email-scrape (buildEmailScraperJobs)
function buildQueue(config) {
  if (config.type === 'emailscraper') {
    return buildEmailScraperJobs({ query: config.query, sources: config.sources || {}, maxResultsPerSource: config.maxResultsPerSource || 20, industry: config.industry || null, keywords: config.keywords || null });
  }
  if (config.type === 'linkedin') {
    return [{ type: 'linkedin', config: { searchMode: config.searchMode || (config.keywords && config.keywords.trim() ? 'keyword' : 'company'), companyName: config.companyName || '', companyDomain: config.companyDomain || '', maxProfiles: config.maxProfiles || 20, jobTitles: config.jobTitles || [], industry: config.industry || null, keywords: config.keywords || null, location: config.location || null, jobTitle: config.jobTitle || null, company: config.company || null } }];
  }
  if (config.type === 'googlemaps') {
    return [{ type: 'google_maps', config: { searchQuery: config.searchQuery, maxResults: config.maxResults || 50, industry: config.industry || null, keywords: config.keywords || null, enableEnrichment: config.enableEnrichment !== false } }];
  }
  if (config.type === 'website') {
    return [{ type: 'website', config: { websiteUrl: config.websiteUrl, industry: config.industry || null, keywords: config.keywords || null, isBulk: !!config.isBulk } }];
  }
  return [];
}

// Build a short label for Search History from job type and config
function getSearchHistoryLabel(job) {
  const { type, config } = job || {};
  const c = config || {};
  switch (type) {
    case 'linkedin':
      return (c.keywords || c.companyName || 'LinkedIn search').toString().trim() || 'LinkedIn search';
    case 'google_maps':
      return (c.searchQuery || 'Google Maps').toString().trim().substring(0, 120) || 'Google Maps';
    case 'google_search':
      return (c.originalQuery || c.searchQuery || c.query || 'Google Search').toString().trim().substring(0, 120) || 'Google Search';
    case 'website': {
      const url = c.websiteUrl;
      if (Array.isArray(url)) {
        return url.length > 1 ? `Websites (${url.length} URLs)` : (url[0] || 'Websites').toString().substring(0, 80);
      }
      const str = (url || '').toString().trim();
      const lines = str.split(/\r?\n/).filter(Boolean);
      if (lines.length > 1) return `Websites (${lines.length} URLs)`;
      return str.substring(0, 80) || 'Websites';
    }
    default:
      return (c.searchQuery || c.query || type || 'Search').toString().trim().substring(0, 120) || 'Search';
  }
}

// Run one job — per-job browser lifecycle; scraper returns contacts; cancellation check passed in
async function runOneJob(job, progressCallback) {
  const { type, config } = job;
  const options = { checkCancellation: isScrapingCancelled, stopMode: getScrapingStopMode() };
  if (type === 'linkedin') {
    const { runLinkedInScraper } = require('./src/scraper');
    return await runLinkedInScraper(config, progressCallback, options);
  }
  if (type === 'google_search') {
    const { runGoogleSearchScraper } = require('./src/google-search-scraper');
    return await runGoogleSearchScraper(config, progressCallback, options);
  }
  if (type === 'google_maps') {
    const { runGoogleMapsScraper } = require('./src/googlemaps-scraper');
    return await runGoogleMapsScraper(config, progressCallback, options);
  }
  if (type === 'website') {
    const { runWebsiteScraper, runBulkWebsiteScraper } = require('./src/website-scraper');
    if (config.isBulk || (typeof config.websiteUrl === 'string' && (config.websiteUrl.includes(',') || config.websiteUrl.includes('\n')))) {
      return await runBulkWebsiteScraper(config, progressCallback, options);
    }
    return await runWebsiteScraper(config, progressCallback, options);
  }
  return [];
}

/** @returns {{ saved: number, error?: string }} */
async function saveContactsToSupabase(contacts) {
  if (!contacts || contacts.length === 0) return { saved: 0 };
  const supabase = getSupabase();
  const withEmail = contacts.filter(c => c && c.email);
  const withoutEmail = contacts.filter(c => c && !c.email);
  let saved = 0;
  let saveError = null;
  if (withEmail.length > 0) {
    const { error } = await supabase.from('contacts').upsert(withEmail, { onConflict: 'email', ignoreDuplicates: false });
    if (error) {
      console.error('Supabase save error (with email):', error);
      saveError = saveError || (error.message || String(error));
    } else {
      saved += withEmail.length;
    }
  }
  if (withoutEmail.length > 0) {
    const { error } = await supabase.from('contacts').insert(withoutEmail);
    if (error) {
      console.error('Supabase save error (no email):', error);
      saveError = saveError || (error.message || String(error));
    } else {
      saved += withoutEmail.length;
    }
  }
  return { saved, error: saveError || undefined };
}

async function runLoop(initialQueue, configSummary, isEmailScraper) {
  let queue = [...initialQueue];
  const jobsTotal = queue.length;
  let jobsCompleted = 0;
  let allContacts = [];
  let stats = null;
  let failedUrls = null;
  const runId = 'run-' + Date.now();
  progressStore.save({ runId, queue, configSummary, counts: { contactsCollected: 0 }, lastUpdated: Date.now() });

  const progressCallback = (progress) => {
    if (isScrapingCancelled()) { progress.cancelled = true; progress.status = 'Stopping...'; }
    if (progress.stats) stats = progress.stats;
    if (progress.failedUrls) failedUrls = progress.failedUrls;
    sendProgress(progress, jobsCompleted, jobsTotal, allContacts.length);
  };

  while (queue.length > 0 && !isScrapingCancelled()) {
    const job = queue.shift();
    try {
      const contacts = await runOneJob(job, progressCallback);
      const list = Array.isArray(contacts) ? contacts : (contacts ? [contacts] : []);
      allContacts = allContacts.concat(list);
      // Tag contacts with search_run_id and record in Search History (all job types; one entry per job so "View leads" shows only this job's contacts)
      if (list.length > 0) {
        const jobRunId = `${runId}-${jobsCompleted}`;
        const { columnExists } = await ensureSearchRunIdColumn();
        if (columnExists) {
          list.forEach(c => { c.search_run_id = jobRunId; });
        }
        const label = getSearchHistoryLabel(job);
        searchHistoryStore.append(jobRunId, label, list.length, job.type || null);
      }
      // Save after each job (and on stop: current job returns partial list, we save it here)
      const saveResult = await saveContactsToSupabase(list);
      if (saveResult.error && mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('contacts-save-error', { message: saveResult.error });
      }
      jobsCompleted++;
      progressStore.save({ runId, queue, configSummary, counts: { contactsCollected: allContacts.length }, lastUpdated: Date.now() });
      sendProgress({ status: 'Job ' + jobsCompleted + '/' + jobsTotal + ' done.', phase: 'complete', completed: false }, jobsCompleted, jobsTotal, allContacts.length);
    } catch (err) {
      console.error('Job error:', err);
      sendProgress({ status: 'Error: ' + err.message, phase: 'error', error: true }, jobsCompleted, jobsTotal, allContacts.length);
    }
    if (queue.length > 0 && !isScrapingCancelled()) await sleep(BETWEEN_JOBS_MS);
  }
  progressStore.clear();
  // On cancel we still merge/save what we have so far (already saved per-job above; merge dedupes for email scraper)
  if (isEmailScraper && allContacts.length > 0) {
    const merged = mergeContacts(allContacts);
    const mergeSaveResult = await saveContactsToSupabase(merged);
    if (mergeSaveResult.error && mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('contacts-save-error', { message: mergeSaveResult.error });
    }
    stats = { total: merged.length, withEmail: merged.filter(c => c.email).length, withPhone: merged.filter(c => c.phone_number || c.mobile_number).length };
    allContacts = merged;
  } else if (!stats && allContacts.length > 0) {
    stats = { total: allContacts.length, withEmail: allContacts.filter(r => r.email).length, withPhone: allContacts.filter(r => r.phone_number || r.mobile_number || r.whatsapp_number).length };
  }
  console.log('[runLoop] Returning:', { resultsCount: allContacts.length, stats, hasFailedUrls: !!failedUrls, cancelled: isScrapingCancelled() });
  if (allContacts.length > 0) {
    console.log('[runLoop] First contact sample:', allContacts[0]);
  }
  return { results: allContacts, stats, failedUrls, cancelled: isScrapingCancelled() };
}

ipcMain.handle('start-scrape', async (event, config) => {
  resetCancellationFlag();
  const queue = buildQueue(config);
  if (queue.length === 0) return { success: false, error: 'No jobs to run' };
  const configSummary = { type: config.type };
  try {
    const { results, stats, failedUrls, cancelled } = await runLoop(queue, configSummary, false);
    console.log('[start-scrape] runLoop returned:', { resultsCount: results ? results.length : 0, stats, cancelled });
    if (mainWindow) mainWindow.webContents.send('refresh-data');
    if (cancelled) return { success: false, error: 'Scraping was cancelled by user', cancelled: true, results: results || [], stats, failedUrls };
    const returnValue = { success: true, results: results || [], stats, failedUrls };
    console.log('[start-scrape] Returning to renderer:', { success: returnValue.success, resultsCount: returnValue.results.length, stats: returnValue.stats });
    return returnValue;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-email-scrape', async (event, config) => {
  resetCancellationFlag();
  const queue = buildQueue({ ...config, type: 'emailscraper' });
  if (queue.length === 0) return { success: false, error: 'No sources selected or no jobs to run' };
  const configSummary = { type: 'emailscraper', query: config.query, sources: config.sources };
  try {
    const { results, stats, failedUrls, cancelled } = await runLoop(queue, configSummary, true);
    if (mainWindow) mainWindow.webContents.send('refresh-data');
    if (cancelled) return { success: false, error: 'Scraping was cancelled by user', cancelled: true, results: results || [], stats: stats || { total: 0, withEmail: 0, withPhone: 0 }, errors: null };
    return { success: true, results: results || [], stats: stats || { total: 0, withEmail: 0, withPhone: 0 }, errors: null };
  } catch (error) {
    console.error('Email scraper error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-run-status', async () => {
  const saved = progressStore.load();
  if (!saved || !saved.queue || saved.queue.length === 0) return { hasSavedRun: false };
  return { hasSavedRun: true, jobsRemaining: saved.queue.length, counts: saved.counts || { contactsCollected: 0 }, configSummary: saved.configSummary || null };
});

ipcMain.handle('resume-run', async () => {
  const saved = progressStore.load();
  if (!saved || !saved.queue || saved.queue.length === 0) return { success: false, error: 'No saved run to resume' };
  resetCancellationFlag();
  try {
    const { results, stats, failedUrls, cancelled } = await runLoop(saved.queue, saved.configSummary || {}, saved.configSummary?.type === 'emailscraper');
    if (mainWindow) mainWindow.webContents.send('refresh-data');
    if (cancelled) return { success: false, cancelled: true, results: results || [], stats, failedUrls };
    return { success: true, results: results || [], stats, failedUrls };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('discard-saved-run', async () => {
  progressStore.clear();
  return { success: true };
});

// Check and create search_query column if needed
async function ensureSearchQueryColumn() {
  try {
    const supabase = getSupabase();
    
    // Try to query the search_query column - if it fails, column doesn't exist
    const { error } = await supabase
      .from('contacts')
      .select('search_query')
      .limit(1);
    
    if (error && error.code === '42703') { // Column doesn't exist error code
      console.log('search_query column does not exist. Attempting to create it...');
      
      // Try to create column using RPC (requires a database function)
      // If RPC doesn't exist, we'll need to use direct SQL
      const { error: rpcError } = await supabase.rpc('add_search_query_column');
      
      if (rpcError) {
        console.warn('Could not create column automatically. Please run the SQL migration manually.');
        console.warn('SQL to run:', `
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_query VARCHAR(200);
        `.trim());
        return { success: false, needsManualMigration: true };
      }
      
      console.log('search_query column created successfully!');
      return { success: true };
    }
    
    // Column exists or different error
    if (error && error.code !== '42703') {
      console.warn('Error checking search_query column:', error.message);
    }
    
    return { success: true, columnExists: true };
  } catch (error) {
    console.warn('Error checking search_query column:', error.message);
    return { success: false, error: error.message };
  }
}

// Check if search_run_id column exists (for Search History)
async function ensureSearchRunIdColumn() {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('contacts').select('search_run_id').limit(1);
    if (error && error.code === '42703') {
      console.log('search_run_id column does not exist. To enable Search History view by run, run this SQL in Supabase:');
      console.log('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_run_id VARCHAR(100);');
      return { columnExists: false, needsMigration: true };
    }
    return { columnExists: true };
  } catch (e) {
    return { columnExists: false };
  }
}

// Load contacts (paginate to get all rows; Supabase default limit is 1000)
ipcMain.handle('load-contacts', async () => {
  try {
    await ensureSearchQueryColumn();
    const supabase = getSupabase();
    const pageSize = 1000;
    let all = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const chunk = data || [];
      all = all.concat(chunk);
      hasMore = chunk.length === pageSize;
      from += pageSize;
    }
    return { success: true, contacts: all };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Search History: list of runs (keyword, lead count, runId)
ipcMain.handle('get-search-history', async () => {
  try {
    const data = searchHistoryStore.load();
    return { success: true, runs: data.runs || [] };
  } catch (e) {
    return { success: false, runs: [], error: e.message };
  }
});

// Load contacts for a specific search run (for Search History "View")
ipcMain.handle('load-contacts-by-run-id', async (event, runId) => {
  if (!runId) return { success: false, contacts: [], error: 'runId required' };
  try {
    const supabase = getSupabase();
    const pageSize = 1000;
    let all = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('search_run_id', runId)
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) {
        if (error.code === '42703') {
          return { success: false, contacts: [], needsMigration: true };
        }
        throw error;
      }
      const chunk = data || [];
      all = all.concat(chunk);
      hasMore = chunk.length === pageSize;
      from += pageSize;
    }
    return { success: true, contacts: all };
  } catch (e) {
    return { success: false, contacts: [], error: e.message };
  }
});

// Delete contacts
ipcMain.handle('delete-contacts', async (event, ids) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .delete()
      .in('id', ids);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Clear all contacts (reset database to empty — all nav counts go to 0)
ipcMain.handle('clear-all-contacts', async () => {
  try {
    const supabase = getSupabase();
    const pageSize = 500;
    let deleted = 0;
    let hasMore = true;
    while (hasMore) {
      const { data: rows, error: selectErr } = await supabase
        .from('contacts')
        .select('id')
        .limit(pageSize);
      if (selectErr) throw selectErr;
      if (!rows || rows.length === 0) break;
      const ids = rows.map(r => r.id);
      const { error: deleteErr } = await supabase.from('contacts').delete().in('id', ids);
      if (deleteErr) throw deleteErr;
      deleted += ids.length;
      hasMore = rows.length === pageSize;
    }
    return { success: true, deleted };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Verify single email using Abstract Email Reputation API
// CORRECTED: Parsing the actual API response structure
async function verifyEmailWithAPI(email, apiKey) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://emailreputation.abstractapi.com/v1/?api_key=${apiKey}&email=${encodeURIComponent(email)}`;
    
    console.log(`Verifying email: ${email}`);
    
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          console.log(`API Response for ${email}:`, data.substring(0, 300));
          const response = JSON.parse(data);
          
          // Check for API errors
          if (response.error) {
            console.error('API Error:', response.error);
            
            // Handle quota errors specifically
            if (response.error.code === 'quota_reached' || response.error.message?.includes('quota')) {
              resolve({ 
                isValid: null, // null means couldn't verify (not false/invalid)
                status: 'quota_exceeded',
                details: {
                  error: 'API quota exceeded. Please upgrade your Abstract API plan or use a different API key.',
                  code: response.error.code
                }
              });
              return;
            }
            
            resolve({ 
              isValid: false, 
              status: 'error',
              details: response.error.message || 'API error'
            });
            return;
          }
          
          // ============================================
          // CORRECT Email Reputation API Response Parsing
          // ============================================
          
          // Get deliverability info
          const deliverability = response.email_deliverability || {};
          const deliveryStatus = deliverability.status || 'unknown'; // "deliverable", "risky", "undeliverable", "unknown"
          const isFormatValid = deliverability.is_format_valid === true;
          const isSmtpValid = deliverability.is_smtp_valid === true;
          const isMxValid = deliverability.is_mx_valid === true;
          
          // Get quality info
          const quality = response.email_quality || {};
          const qualityScore = quality.score || 0; // 0-1 scale
          const isFreeEmail = quality.is_free_email === true;
          const isDisposable = quality.is_disposable === true;
          const isCatchAll = quality.is_catchall === true;
          const isRoleEmail = quality.is_role === true;
          
          // Get risk info
          const risk = response.email_risk || {};
          const addressRisk = risk.address_risk_status || 'unknown'; // "low", "medium", "high"
          const domainRisk = risk.domain_risk_status || 'unknown';
          
          // Determine final validity and status
          let isValid = false;
          let status = 'unverified';
          
          // Primary check: deliverability status
          if (deliveryStatus === 'deliverable') {
            isValid = true;
            status = 'verified';
          } else if (deliveryStatus === 'undeliverable') {
            isValid = false;
            status = 'invalid';
          } else if (deliveryStatus === 'risky') {
            // Risky from API - check if we can still consider it valid
            if (isFormatValid && isMxValid && addressRisk === 'low' && !isDisposable) {
              isValid = true; // Format and MX valid, low risk - treat as verified
              status = 'verified';
            } else {
              isValid = false;
              status = 'risky';
            }
          } else if (deliveryStatus === 'unknown') {
            // For unknown, be more lenient - if format and MX are valid, consider it verified
            if (isFormatValid && isMxValid && !isDisposable) {
              if (addressRisk === 'low') {
                isValid = true;
                status = 'verified'; // Format valid, MX valid, low risk - good enough
              } else if (addressRisk === 'medium') {
                isValid = true;
                status = 'verified'; // Still accept medium risk as verified
              } else {
                isValid = false;
                status = 'risky'; // High risk only
              }
            } else if (isFormatValid && isMxValid) {
              isValid = false;
              status = 'risky'; // Valid format/MX but disposable or other issues
            } else {
              isValid = false;
              status = 'invalid'; // Invalid format or MX
            }
          }
          
          // Override: Disposable emails are always risky/invalid
          if (isDisposable) {
            isValid = false;
            status = 'risky';
          }
          
          // Override: Only downgrade if address risk is high AND we have other concerns
          if (addressRisk === 'high' && (isDisposable || !isMxValid)) {
            status = 'risky';
            isValid = false;
          }
          
          console.log(`Result for ${email}: ${status} (delivery: ${deliveryStatus}, smtp: ${isSmtpValid}, addressRisk: ${addressRisk})`);
          
          resolve({
            isValid,
            status,
            details: {
              delivery_status: deliveryStatus,
              is_smtp_valid: isSmtpValid,
              is_mx_valid: isMxValid,
              quality_score: qualityScore,
              is_free_email: isFreeEmail,
              is_disposable: isDisposable,
              is_catchall: isCatchAll,
              is_role_email: isRoleEmail,
              address_risk: addressRisk,
              domain_risk: domainRisk
            }
          });
        } catch (e) {
          console.error('Parse error:', e.message, 'Raw data:', data.substring(0, 200));
          resolve({ isValid: false, status: 'error', details: 'Parse error: ' + e.message });
        }
      });
    }).on('error', (err) => {
      console.error('HTTP error:', err.message);
      resolve({ isValid: false, status: 'error', details: err.message });
    });
  });
}

// Bulk verify emails
ipcMain.handle('verify-emails', async (event, emailData, apiKey) => {
  try {
    const supabase = getSupabase();
    const results = [];
    
    console.log(`Starting bulk verification of ${emailData.length} emails`);
    
    let quotaReached = false;
    let quotaReachedAt = null;
    
    for (let i = 0; i < emailData.length; i++) {
      const item = emailData[i];
      
      // Stop processing if quota was reached
      if (quotaReached) {
        console.log(`Quota reached - stopping verification. ${emailData.length - i} emails remaining.`);
        // Mark remaining emails as quota_exceeded
        for (let j = i; j < emailData.length; j++) {
          results.push({ 
            id: emailData[j].id, 
            verified: null, 
            status: 'quota_exceeded',
            details: {
              error: 'API quota exceeded. Verification stopped early.',
              code: 'quota_reached'
            }
          });
        }
        break;
      }
      
      // Send progress update to renderer
      if (mainWindow) {
        mainWindow.webContents.send('verification-progress', {
          current: i + 1,
          total: emailData.length,
          email: item.email,
          quotaReached: quotaReached
        });
      }
      
      if (!item.email) {
        results.push({ id: item.id, verified: false, status: 'no_email' });
        continue;
      }

      try {
        const verifyResult = await verifyEmailWithAPI(item.email, apiKey);
        
        // Check if quota was reached
        if (verifyResult.status === 'quota_exceeded') {
          quotaReached = true;
          quotaReachedAt = i + 1;
          console.error('⚠️ API QUOTA EXCEEDED - Stopping verification');
          
          // Send quota error notification to renderer
          if (mainWindow) {
            mainWindow.webContents.send('quota-exceeded', {
              message: 'Abstract Email Reputation API quota has been exhausted.',
              verifiedCount: results.filter(r => r.verified).length,
              totalAttempted: i + 1,
              remaining: emailData.length - (i + 1)
            });
          }
        }
        
        // Update in Supabase
        // Only update if not quota exceeded (don't overwrite existing status)
        if (verifyResult.status !== 'quota_exceeded') {
          const { error } = await supabase
            .from('contacts')
            .update({ 
              email_verified: verifyResult.isValid,
              verification_status: verifyResult.status,
              verification_details: verifyResult.details
            })
            .eq('id', item.id);

          if (error) {
            console.error('Supabase update error:', error);
          }
        } else {
          // For quota exceeded, just log it
          console.log(`Quota exceeded for ${item.email} - skipping database update`);
        }

        // Handle quota exceeded specially
        if (verifyResult.status === 'quota_exceeded') {
          results.push({ 
            id: item.id, 
            verified: null, 
            status: 'quota_exceeded',
            details: verifyResult.details
          });
        } else {
          results.push({ 
            id: item.id, 
            verified: verifyResult.isValid, 
            status: verifyResult.status,
            details: verifyResult.details
          });
        }

        // Rate limiting - wait 1.1 seconds between API calls (free tier limit)
        // Skip delay if quota reached (we're stopping anyway)
        if (!quotaReached) {
          await new Promise(resolve => setTimeout(resolve, 1100));
        }

      } catch (err) {
        console.error('Verification error for', item.email, err);
        results.push({ id: item.id, verified: false, status: 'error' });
      }
    }
    
    // Add quota reached info to return value
    if (quotaReached) {
      console.log(`⚠️ Verification stopped early due to quota: ${quotaReachedAt}/${emailData.length} emails processed`);
    }

    const verifiedCount = results.filter(r => r.verified).length;
    const riskyCount = results.filter(r => r.status === 'risky').length;
    const invalidCount = results.filter(r => r.status === 'invalid').length;
    const quotaExceededCount = results.filter(r => r.status === 'quota_exceeded').length;
    
    console.log(`Verification complete: ${verifiedCount} verified, ${riskyCount} risky, ${invalidCount} invalid, ${quotaExceededCount} quota exceeded`);

    return { 
      success: true, 
      results,
      quotaExceeded: quotaReached,
      quotaExceededCount: quotaExceededCount
    };
  } catch (error) {
    console.error('Bulk verification error:', error);
    return { success: false, error: error.message };
  }
});

// Bulk verify emails via real-time SMTP (no API key; may not work if port 25 is blocked)
ipcMain.handle('verify-emails-smtp', async (event, emailData) => {
  try {
    const supabase = getSupabase();
    const results = [];
    const DELAY_MS = 400;

    console.log(`Starting SMTP verification of ${emailData.length} emails`);

    for (let i = 0; i < emailData.length; i++) {
      const item = emailData[i];

      if (mainWindow) {
        mainWindow.webContents.send('verification-progress', {
          current: i + 1,
          total: emailData.length,
          email: item.email,
          quotaReached: false
        });
      }

      if (!item.email) {
        results.push({ id: item.id, verified: false, status: 'no_email' });
        continue;
      }

      try {
        const verifyResult = await verifyEmailSmtp(item.email, { timeout: 12000 });

        const { error } = await supabase
          .from('contacts')
          .update({
            email_verified: verifyResult.isValid === true,
            verification_status: verifyResult.status,
            verification_details: verifyResult.details
          })
          .eq('id', item.id);

        if (error) console.error('Supabase update error:', error);

        results.push({
          id: item.id,
          verified: verifyResult.isValid === true,
          status: verifyResult.status,
          details: verifyResult.details
        });

        if (i < emailData.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
      } catch (err) {
        console.error('SMTP verification error for', item.email, err);
        results.push({ id: item.id, verified: false, status: 'error', details: { error: err.message } });
      }
    }

    const verifiedCount = results.filter((r) => r.verified).length;
    const invalidCount = results.filter((r) => r.status === 'invalid').length;
    console.log(`SMTP verification complete: ${verifiedCount} verified, ${invalidCount} invalid`);

    return { success: true, results, quotaExceeded: false, quotaExceededCount: 0 };
  } catch (error) {
    console.error('Bulk SMTP verification error:', error);
    return { success: false, error: error.message };
  }
});

// Bulk verify emails via MX + syntax only (no RCPT TO, not blocked by anti-verification)
ipcMain.handle('verify-emails-mx', async (event, emailData) => {
  try {
    const supabase = getSupabase();
    const results = [];
    const progressTarget = event.sender;

    console.log(`Starting MX+syntax verification of ${emailData.length} emails`);

    for (let i = 0; i < emailData.length; i++) {
      const item = emailData[i];

      if (progressTarget && !progressTarget.isDestroyed()) {
        progressTarget.send('verification-progress', {
          current: i + 1,
          total: emailData.length,
          email: item.email,
          quotaReached: false
        });
      }

      if (!item.email) {
        results.push({ id: item.id, verified: false, status: 'no_email' });
        continue;
      }

      const verifyResult = await verifyEmailMxSyntax(item.email);

      const { error } = await supabase
        .from('contacts')
        .update({
          email_verified: verifyResult.isValid === true,
          verification_status: verifyResult.status,
          verification_details: verifyResult.details
        })
        .eq('id', item.id);

      if (error) console.error('Supabase update error:', error);

      results.push({
        id: item.id,
        verified: verifyResult.isValid === true,
        status: verifyResult.status,
        details: verifyResult.details
      });
    }

    const verifiedCount = results.filter((r) => r.verified).length;
    console.log(`MX+syntax verification complete: ${verifiedCount} verified`);
    return { success: true, results, quotaExceeded: false, quotaExceededCount: 0 };
  } catch (error) {
    console.error('MX verification error:', error);
    return { success: false, error: error.message };
  }
});

// Verify emails for scraper results (look up contact ids by email, then run MX + syntax verification)
ipcMain.handle('verify-scraper-results', async (event, contacts) => {
  if (!contacts || !Array.isArray(contacts)) return { success: false, error: 'No contacts provided' };
  const emails = [...new Set(contacts.map(c => c && c.email).filter(Boolean))];
  if (emails.length === 0) return { success: true, results: [] };
  try {
    const supabase = getSupabase();
    const { data: rows, error: fetchError } = await supabase.from('contacts').select('id, email').in('email', emails);
    if (fetchError) {
      console.error('Fetch contacts for verify:', fetchError);
      return { success: false, error: fetchError.message };
    }
    const emailData = (rows || []).map(r => ({ id: r.id, email: r.email }));
    if (emailData.length === 0) return { success: true, results: emails.map(e => ({ email: e, verified: false, status: 'not_found' })) };
    const results = [];
    const progressTarget = event.sender;
    for (let i = 0; i < emailData.length; i++) {
      const item = emailData[i];
      if (progressTarget && !progressTarget.isDestroyed()) {
        progressTarget.send('verification-progress', { current: i + 1, total: emailData.length, email: item.email, quotaReached: false });
      }
      if (!item.email) {
        results.push({ email: item.email, verified: false, status: 'no_email' });
        continue;
      }
      try {
        const verifyResult = await verifyEmailMxSyntax(item.email);
        const { error } = await supabase.from('contacts').update({
          email_verified: verifyResult.isValid === true,
          verification_status: verifyResult.status,
          verification_details: verifyResult.details
        }).eq('id', item.id);
        if (error) console.error('Supabase update error:', error);
        results.push({ email: item.email, verified: verifyResult.isValid === true, status: verifyResult.status });
      } catch (err) {
        console.error('MX verification error for', item.email, err);
        results.push({ email: item.email, verified: false, status: 'error' });
      }
    }
    return { success: true, results };
  } catch (error) {
    console.error('verify-scraper-results error:', error);
    return { success: false, error: error.message };
  }
});

// Update single contact verification status
ipcMain.handle('update-contact-verification', async (event, contactId, isVerified, status) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ 
        email_verified: isVerified,
        verification_status: status || (isVerified ? 'verified' : 'unverified')
      })
      .eq('id', contactId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Update contact industry
ipcMain.handle('update-contact-industry', async (event, contactId, industry) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ industry })
      .eq('id', contactId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Bulk update industry for multiple contacts
ipcMain.handle('bulk-update-industry', async (event, contactIds, industry) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ industry })
      .in('id', contactIds);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Import contacts (CSV or manual)
ipcMain.handle('import-contacts', async (event, contacts) => {
  try {
    const supabase = getSupabase();
    
    if (!contacts || contacts.length === 0) {
      return { success: false, error: 'No contacts to import' };
    }

    // Separate contacts with and without email
    let withEmail = contacts.filter(c => c.email);
    const withoutEmail = contacts.filter(c => !c.email);

    // Deduplicate by email so ON CONFLICT DO UPDATE doesn't touch the same row twice
    const byEmail = new Map();
    for (const c of withEmail) {
      const key = (c.email || '').trim().toLowerCase();
      if (key) byEmail.set(key, c);
    }
    withEmail = Array.from(byEmail.values());

    let imported = 0;

    // Upsert contacts with email (will update if exists)
    if (withEmail.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .upsert(withEmail, { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (error) {
        console.error('Upsert error:', error);
        throw error;
      }
      imported += withEmail.length;
    }

    // Insert contacts without email
    if (withoutEmail.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .insert(withoutEmail);

      if (error) {
        console.error('Insert error:', error);
        // Don't throw, some might be duplicates
      } else {
        imported += withoutEmail.length;
      }
    }

    return { success: true, count: imported };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// WEEK 3: EMAIL SENDING SYSTEM
// ============================================

// Store active SMTP transporter
let smtpTransporter = null;
let smtpConfig = null;

// Generate random email address for survivability
function generateRandomEmail(domain) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${randomPart}@${domain}`;
}

// Generate random email with prefix
ipcMain.handle('generate-random-email', async (event, domain, prefix = '') => {
  try {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 12; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const email = prefix ? `${prefix}.${randomPart}@${domain}` : `${randomPart}@${domain}`;
    return { success: true, email };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Configure SMTP settings
ipcMain.handle('configure-smtp', async (event, config) => {
  try {
    console.log('Configuring SMTP with:', { host: config.host, port: config.port, user: config.user });
    
    smtpConfig = {
      host: config.host,
      port: parseInt(config.port),
      secure: config.secure || config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass
      },
      // Connection pooling for bulk sending
      pool: true,
      maxConnections: config.maxConnections || 5,
      maxMessages: config.maxMessages || 100,
      // Timeouts
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    };

    // Create transporter
    smtpTransporter = nodemailer.createTransport(smtpConfig);

    // Verify connection
    await smtpTransporter.verify();
    
    console.log('SMTP connection verified successfully');
    return { success: true, message: 'SMTP configured and verified' };
  } catch (error) {
    console.error('SMTP configuration error:', error);
    smtpTransporter = null;
    smtpConfig = null;
    return { success: false, error: error.message };
  }
});

// Test SMTP connection
ipcMain.handle('test-smtp', async (event) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured' };
    }

    await smtpTransporter.verify();
    return { success: true, message: 'SMTP connection is working' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Replace template variables in text
function replaceTemplateVariables(template, contact) {
  if (!template) return '';
  
  let result = template;
  
  // Standard variables (Mailgun/Mailchimp-style: Name, Surname, Company, etc.)
  const variables = {
    '{{first_name}}': contact.first_name || '',
    '{{last_name}}': contact.last_name || '',
    '{{surname}}': contact.last_name || '', // alias
    '{{full_name}}': [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '',
    '{{email}}': contact.email || '',
    '{{company}}': contact.company || '',
    '{{job_title}}': contact.job_title || '',
    '{{location}}': contact.location || '',
    '{{industry}}': contact.industry || '',
    '{{phone}}': contact.phone_number || '',
    // Fallbacks with default values
    '{{first_name|there}}': contact.first_name || 'there',
    '{{company|your company}}': contact.company || 'your company',
    '{{job_title|professional}}': contact.job_title || 'professional'
  };

  // Replace all variables
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(escapeRegExp(key), 'gi'), value);
  }

  // Handle custom fallback syntax: {{variable|fallback}}
  result = result.replace(/\{\{(\w+)\|([^}]+)\}\}/g, (match, variable, fallback) => {
    const varKey = variable.toLowerCase();
    const value = contact[varKey] || contact[variable];
    return value || fallback;
  });

  return result;
}

// Escape special regex characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Send single email
ipcMain.handle('send-email', async (event, emailConfig) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured. Please configure SMTP settings first.' };
    }

    const { to, subject, html, text, from, replyTo } = emailConfig;

    const mailOptions = {
      from: from || smtpConfig.auth.user,
      to: to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for plain text
      replyTo: replyTo || from || smtpConfig.auth.user
    };

    const info = await smtpTransporter.sendMail(mailOptions);
    
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Send email error:', error);
    return { success: false, error: error.message };
  }
});

// Send bulk emails with rate limiting and progress updates
ipcMain.handle('send-bulk-emails', async (event, config) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured. Please configure SMTP settings first.' };
    }

    const { 
      contacts, 
      subject, 
      htmlTemplate, 
      textTemplate,
      from,
      replyTo,
      delayBetweenEmails = 2000, // 2 seconds default
      batchSize = 50,
      delayBetweenBatches = 60000 // 1 minute between batches
    } = config;

    const results = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`Starting bulk email send to ${contacts.length} contacts`);

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      // Send progress update
      if (mainWindow) {
        mainWindow.webContents.send('email-send-progress', {
          current: i + 1,
          total: contacts.length,
          email: contact.email,
          successCount,
          failCount
        });
      }

      if (!contact.email) {
        results.push({ 
          contactId: contact.id, 
          email: null, 
          success: false, 
          error: 'No email address' 
        });
        failCount++;
        continue;
      }

      try {
        // Replace template variables
        const personalizedSubject = replaceTemplateVariables(subject, contact);
        const personalizedHtml = replaceTemplateVariables(htmlTemplate, contact);
        const personalizedText = textTemplate ? 
          replaceTemplateVariables(textTemplate, contact) : 
          personalizedHtml.replace(/<[^>]*>/g, '');

        const mailOptions = {
          from: from || smtpConfig.auth.user,
          to: contact.email,
          subject: personalizedSubject,
          html: personalizedHtml,
          text: personalizedText,
          replyTo: replyTo || from || smtpConfig.auth.user
        };

        const info = await smtpTransporter.sendMail(mailOptions);
        
        results.push({
          contactId: contact.id,
          email: contact.email,
          success: true,
          messageId: info.messageId
        });
        successCount++;

        console.log(`Sent ${i + 1}/${contacts.length}: ${contact.email}`);

      } catch (err) {
        console.error(`Failed to send to ${contact.email}:`, err.message);
        results.push({
          contactId: contact.id,
          email: contact.email,
          success: false,
          error: err.message
        });
        failCount++;
      }

      // Rate limiting
      if (i < contacts.length - 1) {
        // Check if we need batch delay
        if ((i + 1) % batchSize === 0) {
          console.log(`Batch ${Math.floor((i + 1) / batchSize)} complete. Waiting ${delayBetweenBatches / 1000}s...`);
          if (mainWindow) {
            mainWindow.webContents.send('email-send-progress', {
              current: i + 1,
              total: contacts.length,
              email: 'Batch pause...',
              successCount,
              failCount,
              batchPause: true
            });
          }
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        } else {
          // Normal delay between emails
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
      }
    }

    console.log(`Bulk send complete: ${successCount} sent, ${failCount} failed`);

    return { 
      success: true, 
      results,
      summary: {
        total: contacts.length,
        sent: successCount,
        failed: failCount
      }
    };
  } catch (error) {
    console.error('Bulk email error:', error);
    return { success: false, error: error.message };
  }
});

// Save email campaign to Supabase
ipcMain.handle('save-campaign', async (event, campaign) => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_campaigns')
      .insert([{
        name: campaign.name,
        subject: campaign.subject,
        html_content: campaign.htmlContent,
        text_content: campaign.textContent,
        from_email: campaign.fromEmail,
        reply_to: campaign.replyTo,
        status: campaign.status || 'draft',
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    return { success: true, campaign: data[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load email campaigns
ipcMain.handle('load-campaigns', async () => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { success: true, campaigns: data || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete campaign
ipcMain.handle('delete-campaign', async (event, campaignId) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('email_campaigns')
      .delete()
      .eq('id', campaignId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Log email send for analytics
ipcMain.handle('log-email-send', async (event, logData) => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_logs')
      .insert([{
        campaign_id: logData.campaignId,
        contact_id: logData.contactId,
        email: logData.email,
        status: logData.status,
        message_id: logData.messageId,
        error_message: logData.error,
        sent_at: new Date().toISOString()
      }]);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get email analytics
ipcMain.handle('get-email-analytics', async (event, campaignId) => {
  try {
    const supabase = getSupabase();
    
    let query = supabase.from('email_logs').select('*');
    
    if (campaignId) {
      query = query.eq('campaign_id', campaignId);
    }
    
    const { data, error } = await query.order('sent_at', { ascending: false });

    if (error) throw error;

    // Calculate stats
    const logs = data || [];
    const stats = {
      total: logs.length,
      sent: logs.filter(l => l.status === 'sent').length,
      failed: logs.filter(l => l.status === 'failed').length,
      logs: logs
    };

    return { success: true, analytics: stats };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Disconnect SMTP
ipcMain.handle('disconnect-smtp', async () => {
  try {
    if (smtpTransporter) {
      smtpTransporter.close();
      smtpTransporter = null;
      smtpConfig = null;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get SMTP status
ipcMain.handle('get-smtp-status', async () => {
  return {
    connected: smtpTransporter !== null,
    config: smtpConfig ? {
      host: smtpConfig.host,
      port: smtpConfig.port,
      user: smtpConfig.auth.user
    } : null
  };
});