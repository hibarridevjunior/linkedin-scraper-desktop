/**
 * Service worker: opens each lead URL, extracts email/phone from the page,
 * POSTs to app /sales-nav-enrich, then closes the tab. Processes URLs sequentially with delay.
 * Also runs bulk export in background so it keeps going when popup is closed.
 */
const ENRICH_URL = 'http://localhost:8765/sales-nav-enrich';
const BULK_RECEIVER_URL = 'http://localhost:8765/sales-nav-results';
const DELAY_BETWEEN_LEADS_MS = 2500;
const NOTIFICATION_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQzwAEAgPw4cfnWgAAAABJRU5ErkJggg==';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Delay that resolves early if bulkExportStopRequested is set, so Stop takes effect quickly. */
function delayOrStop(ms) {
  const chunk = 300;
  return new Promise((resolve) => {
    let elapsed = 0;
    const t = setInterval(() => {
      elapsed += chunk;
      if (bulkExportStopRequested || elapsed >= ms) {
        clearInterval(t);
        resolve();
      }
    }, chunk);
  });
}

function setBadgeCount(n) {
  try {
    const text = n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  } catch (_) {}
}

function setBadgeCounts(listCount, enrichCount) {
  try {
    let text = listCount >= 10000 ? (listCount / 1000).toFixed(1) + 'k' : String(listCount);
    if (enrichCount != null && enrichCount > 0) text += ' E:' + enrichCount;
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  } catch (_) {}
}

const MAX_BULK_LEADS = 1000;
const BATCH_SEND_INTERVAL = 25; // send leads to app every N new leads so enrich can run in parallel
const PERSIST_INTERVAL = 15; // save checkpoint every N leads so interrupted runs can be recovered
let bulkExportStopRequested = false;

function persistCheckpoint(payload) {
  if (!payload || payload.length === 0) return;
  try {
    chrome.storage.local.set({ bulkExportInProgress: true, bulkExportInProgressData: payload });
  } catch (_) {}
}

const LINKEDIN_SEARCH_BASE = 'https://www.linkedin.com/search/results/all/?keywords=';

/** Run on LinkedIn search results page: return first /in/ profile URL (company-scoped search result). */
function getFirstProfileUrlFromSearchPage() {
  const links = document.querySelectorAll('a[href*="linkedin.com/in/"]');
  for (let i = 0; i < links.length; i++) {
    const href = (links[i].href || '').trim();
    if (!href || href.includes('/miniprofile/') || href.includes('/pub/') || href.includes('/search')) continue;
    const m = href.match(/linkedin\.com\/in\/([^\/\?]+)/);
    if (m && m[1] && m[1].length >= 2) return 'https://www.linkedin.com/in/' + m[1];
  }
  return null;
}

/**
 * LinkedIn company-scoped search only. RULE: Never search using a person's name alone.
 * All searches MUST include company name (or company domain). Query format:
 * "Person Full Name" AND "Company Name" — or — "Company Name" AND job title.
 */
async function getLinkedInProfileFromSearch(lead) {
  const name = (lead.name || '').trim();
  const company = (lead.company || '').trim();
  const headline = (lead.headline || '').trim();
  if (!company) return null;
  if (!name && !headline) return null;
  const query = name ? '"' + name + '" "' + company + '"' : '"' + company + '" "' + headline + '"';
  if (!query.includes(company)) return null;
  const searchUrl = LINKEDIN_SEARCH_BASE + encodeURIComponent(query);
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    if (!tab || !tab.id) return null;
    tabId = tab.id;
    await new Promise(resolve => {
      const listener = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 3000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: getFirstProfileUrlFromSearchPage
    });
    const profileUrl = Array.isArray(results) && results[0] && results[0].result ? results[0].result : null;
    return profileUrl;
  } catch (_) {
    return null;
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

/** Enrich worker: consumes enrichQueue in parallel with list scrape. Runs until listScrapeFinished and queue empty. */
async function runEnrichWorker(enrichQueue, listScrapeFinishedRef, enrichedCountRef, listCountRef) {
  const enrichDelayMs = 3500;
  const enrichWaitAfterLoadMs = 2500;
  while (!bulkExportStopRequested && (!listScrapeFinishedRef.done || enrichQueue.length > 0)) {
    const lead = enrichQueue.shift();
    if (!lead) {
      await delayOrStop(500);
      continue;
    }
    const leadUrl = (lead && lead.url) ? lead.url : null;
    if (!leadUrl) continue;
    let urlToOpen = leadUrl;
    const hasCompany = (lead.company || '').trim().length > 0;
    const hasNameOrTitle = ((lead.name || '').trim().length > 0) || ((lead.headline || '').trim().length > 0);
    if (hasCompany && hasNameOrTitle) {
      const profileFromSearch = await getLinkedInProfileFromSearch(lead);
      if (profileFromSearch) {
        urlToOpen = profileFromSearch;
        await delayOrStop(1500);
      }
    }
    try {
      const tab = await chrome.tabs.create({ url: urlToOpen, active: false });
      if (!tab || !tab.id) continue;
      await new Promise(resolve => {
        const listener = (id, info) => {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(resolve, enrichWaitAfterLoadMs);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 20000);
      });
      const data = await enrichOneUrl(urlToOpen, tab.id);
      if (data && lead) {
        if (data.linkedin_profile_url) {
          lead.linkedin_profile_url = data.linkedin_profile_url;
          lead.url = data.linkedin_profile_url;
        }
        if (data.email != null) lead.email = data.email;
        if (data.phone != null) lead.phone = data.phone;
        if (data.company != null && String(data.company).trim()) lead.company = String(data.company).trim();
        if (data.headline != null && String(data.headline).trim()) lead.headline = String(data.headline).trim();
        if (data.location != null && String(data.location).trim()) lead.location = String(data.location).trim();
        if (data.website != null && String(data.website).trim()) lead.website = String(data.website).trim();
      }
    } catch (_) {}
    enrichedCountRef.count += 1;
    try {
      setBadgeCounts(listCountRef.count, enrichedCountRef.count);
    } catch (_) {}
    await delayOrStop(enrichDelayMs);
  }
}

async function runBulkExport(tabId, options) {
  bulkExportStopRequested = false;
  const skipEnrichByOption = options && options.skipEnrich === true;
  const maxPages = 100;
  const maxScrollsPerPage = 80;
  const scrollDelayMs = 3200;   // delay between each scroll+scrape (balanced: faster run, avoid "Too Many Requests")
  const pageLoadWaitMs = 6500;  // wait after clicking Next before scraping new page
  const minScrollsBeforeDone = 12;
  const allLeadsMap = {};
  const enrichQueue = [];
  const listScrapeFinishedRef = { done: false };
  const enrichedCountRef = { count: 0 };
  const listCountRef = { count: 0 };
  const queuedUrls = new Set();
  let lastBatchSizeSent = 0;
  let lastPersistSize = 0;
  try {
    chrome.storage.local.set({ bulkExportInProgress: true });
  } catch (_) {}
  try {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#0d9488' });
  } catch (_) {}
  const injectOpts = { target: { tabId }, files: ['bulk-export-page.js'], world: 'ISOLATED' };
  let runningTotal = 0;

  const runEnrich = !skipEnrichByOption;
  const enrichWorkerPromise = runEnrich
    ? runEnrichWorker(enrichQueue, listScrapeFinishedRef, enrichedCountRef, listCountRef)
    : Promise.resolve();

  try {
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (bulkExportStopRequested) break;
    try {
      await chrome.scripting.executeScript(injectOpts);
    } catch (e) {
      try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}
      try { if (chrome.notifications && chrome.notifications.create) chrome.notifications.create({ type: 'basic', iconUrl: NOTIFICATION_ICON, title: 'Bulk export', message: 'Failed to inject script on page ' + pageNum + '.' }); } catch (_) {}
      break;
    }
    if (pageNum > 1) await delayOrStop(2000);
    let lastSize = 0;
    let stableRounds = 0;
    let atBottomRounds = 0;
    for (let i = 0; i < maxScrollsPerPage; i++) {
      if (bulkExportStopRequested) break;
      try {
        const scrollRes = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__bulkScrollOnce && window.__bulkScrollOnce(), world: 'ISOLATED' });
        const scrollResult = Array.isArray(scrollRes) && scrollRes[0] && scrollRes[0].result ? scrollRes[0].result : { count: 0, atBottom: false };
        await delayOrStop(scrollDelayMs);
        const results = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__bulkScrape && window.__bulkScrape(), world: 'ISOLATED' });
        const batch = Array.isArray(results) && results[0] && results[0].result ? results[0].result : [];
        batch.forEach(lead => { if (lead && lead.url) allLeadsMap[lead.url] = lead; });
        const size = Object.keys(allLeadsMap).length;
        if (size > 0) runningTotal = size;
        for (let k = 0; k < batch.length; k++) {
          const lead = batch[k];
          if (lead && lead.url && !queuedUrls.has(lead.url)) {
            queuedUrls.add(lead.url);
            enrichQueue.push(lead);
          }
        }
        if (runEnrich && size - lastBatchSizeSent >= BATCH_SEND_INTERVAL) {
          const toSend = Object.values(allLeadsMap).slice(0, MAX_BULK_LEADS);
          try {
            await fetch(BULK_RECEIVER_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ results: toSend })
            });
          } catch (_) {}
          lastBatchSizeSent = size;
        }
        const displayCount = size > 0 ? size : (runningTotal > 0 ? runningTotal : (scrollResult.count || batch.length || 0));
        listCountRef.count = displayCount;
        if (runEnrich) setBadgeCounts(displayCount, enrichedCountRef.count);
        else setBadgeCount(displayCount);
        if (size - lastPersistSize >= PERSIST_INTERVAL || size >= MAX_BULK_LEADS) {
          persistCheckpoint(Object.values(allLeadsMap).slice(0, MAX_BULK_LEADS));
          lastPersistSize = size;
        }
        if (size >= MAX_BULK_LEADS || bulkExportStopRequested) break;
        if (scrollResult.atBottom) atBottomRounds++; else atBottomRounds = 0;
        if (size === lastSize && i >= minScrollsBeforeDone) {
          stableRounds++;
          if (stableRounds >= 3 && (scrollResult.atBottom || atBottomRounds > 0)) break;
        } else stableRounds = 0;
        lastSize = size;
      } catch (_) { break; }
    }
    const pageSize = Object.keys(allLeadsMap).length;
    if (pageSize > 0) {
      persistCheckpoint(Object.values(allLeadsMap).slice(0, MAX_BULK_LEADS));
      lastPersistSize = pageSize;
    }
    if (pageSize >= MAX_BULK_LEADS || bulkExportStopRequested) break;
    try {
      const nextRes = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__bulkHasNext && window.__bulkHasNext(), world: 'ISOLATED' });
      const canGoNext = Array.isArray(nextRes) && nextRes[0] && nextRes[0].result === true;
      if (!canGoNext) break;
      const clicked = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__bulkClickNext && window.__bulkClickNext(), world: 'ISOLATED' });
      if (!clicked || !Array.isArray(clicked) || !clicked[0] || clicked[0].result !== true) break;
      await delayOrStop(pageLoadWaitMs);
    } catch (_) { break; }
  }
  } catch (e) {
  }

  listScrapeFinishedRef.done = true;

  try {
    await Promise.race([
      enrichWorkerPromise,
      delay(25000)
    ]);
  } catch (_) {}

  const payload = Object.values(allLeadsMap).slice(0, MAX_BULK_LEADS);
  let saveFailed = false;
  let saveErrorMsg = '';
  let resultsToShow = payload;
  if (payload.length > 0) {
    try {
      const res = await fetch(BULK_RECEIVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: payload })
      });
      const data = await res.json().catch(() => ({}));
      if (data.error || (data.saved !== undefined && data.saved === 0 && data.message && data.message.includes('could not be saved'))) {
        saveFailed = true;
        saveErrorMsg = data.error || data.message || 'Save failed';
      } else if (Array.isArray(data.contacts) && data.contacts.length > 0) {
        resultsToShow = data.contacts;
      }
    } catch (e) {
      saveFailed = true;
      saveErrorMsg = (e && e.message) || 'Network error – is the Marketing System app open?';
    }
  }

  const skipEnrich = bulkExportStopRequested || skipEnrichByOption;
  try {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: saveFailed ? '#b91c1c' : '#057642' });
    setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (_) {} }, 5000);
  } catch (_) {}
  try {
    if (chrome.notifications && typeof chrome.notifications.create === 'function') {
      if (saveFailed) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: NOTIFICATION_ICON,
          title: 'Save to app failed',
          message: (saveErrorMsg || 'Leads could not be saved. Check that the Marketing System app is open and Supabase is configured.').substring(0, 200)
        });
      } else {
        const savedWithoutEnrich = skipEnrich || bulkExportStopRequested;
        const title = savedWithoutEnrich ? 'Run done' : 'Bulk export done';
        const msg = savedWithoutEnrich
          ? payload.length + ' leads saved (profile & LinkedIn links).'
          : payload.length + ' leads sent; ' + enrichedCountRef.count + ' enriched from profile pages.';
        chrome.notifications.create({ type: 'basic', iconUrl: NOTIFICATION_ICON, title: title, message: msg });
      }
    }
  } catch (_) {}
  function clearCheckpointAndOpenResults() {
    chrome.storage.local.remove(['bulkExportInProgress', 'bulkExportInProgressData'], function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
    });
  }
  if (resultsToShow.length > 0) {
    try {
      chrome.storage.local.set({
        lastBulkExportResults: resultsToShow,
        lastBulkExportDone: { count: resultsToShow.length, at: Date.now() }
      }, clearCheckpointAndOpenResults);
    } catch (_) {
      try { clearCheckpointAndOpenResults(); } catch (_) {}
    }
  } else {
    try {
      chrome.storage.local.set({ lastBulkExportResults: [], lastBulkExportDone: { count: 0, at: Date.now() } }, clearCheckpointAndOpenResults);
    } catch (_) {
      try { clearCheckpointAndOpenResults(); } catch (_) {}
    }
  }
}

function requestStopBulkSaveWithoutEnrich() {
  bulkExportStopRequested = true;
}

/** Run in lead profile tab: extract all contact details (email, phone, websites) for enrichment. */
function extractEmailAndPhoneFromPage() {
  const url = window.location.href || '';
  if (!url.includes('/sales/lead/') && !url.includes('/in/')) return null;
  let canonicalUrl = url;
  if (url.includes('/sales/lead/')) {
    const m = url.match(/\/sales\/lead\/([^?]+)/);
    if (m && m[1]) canonicalUrl = 'https://www.linkedin.com/sales/lead/' + m[1].replace(/\?.*$/, '').trim();
  } else if (url.includes('/in/')) {
    const m = url.match(/\/in\/([^\/\?]+)/);
    if (m && m[1]) canonicalUrl = 'https://www.linkedin.com/in/' + m[1];
  }
  function text(sel) {
    const el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }
  const name = text('[data-anonymize="person-name"]') || text('h1') || text('.artdeco-entity-lockup__title');
  const headline = text('[data-anonymize="headline"]') || text('[data-anonymize="title"]') || text('.artdeco-entity-lockup__subtitle');
  const company = text('[data-anonymize="company-name"]') || text('.artdeco-entity-lockup__subtitle');
  const location = text('[data-anonymize="location"]') || text('.artdeco-entity-lockup__caption');
  const industry = text('[data-anonymize="industry"]') || '';
  let email = '';
  const mailto = document.querySelector('a[href^="mailto:"]');
  if (mailto && mailto.href) email = (mailto.href.replace(/^mailto:/i, '').split('?')[0] || '').trim();
  let phone = '';
  const tel = document.querySelector('a[href^="tel:"]');
  if (tel && tel.href) phone = (tel.href.replace(/^tel:/i, '').trim() || '').trim();
  if (!phone && document.body) {
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
    const phoneMatch = bodyText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}(?:[-.\s]?\d{2,4})?/);
    if (phoneMatch) phone = phoneMatch[0].trim();
  }
  const websites = [];
  const contactLinks = document.querySelectorAll('a[href^="http://"], a[href^="https://"]');
  for (let i = 0; i < contactLinks.length; i++) {
    const href = (contactLinks[i].href || '').trim();
    if (!href || href.indexOf('linkedin.com') !== -1 || href.indexOf('mailto:') !== -1 || href.indexOf('tel:') !== -1) continue;
    if (href.length < 10 || href.length > 500) continue;
    if (websites.indexOf(href) === -1) websites.push(href);
  }
  const website = websites.length > 0 ? websites[0] : null;
  let linkedinProfileUrl = null;
  if (url.includes('/sales/lead/')) {
    const profileLink = document.querySelector('a[href*="linkedin.com/in/"]');
    if (profileLink && profileLink.href) {
      const h = profileLink.href.trim();
      if (!h.includes('/miniprofile/') && !h.includes('/pub/')) {
        const match = h.match(/linkedin\.com\/in\/([^\/\?]+)/);
        if (match && match[1] && match[1].length >= 2 && !match[1].includes('search')) {
          linkedinProfileUrl = 'https://www.linkedin.com/in/' + match[1];
        }
      }
    }
  } else if (url.includes('/in/')) {
    linkedinProfileUrl = canonicalUrl;
  }
  return {
    url: canonicalUrl,
    linkedin_profile_url: linkedinProfileUrl || null,
    name: name || null,
    headline: headline || null,
    company: company || null,
    location: location || null,
    industry: industry || null,
    email: email || null,
    phone: phone || null,
    website: website,
    websites: websites.length > 0 ? websites : null
  };
}

async function enrichOneUrl(url, tabId) {
  let data = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractEmailAndPhoneFromPage
    });
    data = Array.isArray(results) && results[0] && results[0].result ? results[0].result : null;
    if (!data || !data.url) return null;
    await fetch(ENRICH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: data.url,
        linkedin_profile_url: data.linkedin_profile_url || null,
        name: data.name || null,
        headline: data.headline || null,
        company: data.company || null,
        location: data.location || null,
        industry: data.industry || null,
        email: data.email || null,
        phone: data.phone || null,
        website: data.website || null,
        websites: data.websites || null
      })
    }).catch(() => {});
    return data;
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_) {}
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startBulkExport' && msg.tabId) {
    runBulkExport(msg.tabId, { skipEnrich: msg.skipEnrich === true });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'stopBulkExportSaveWithoutEnrich') {
    requestStopBulkSaveWithoutEnrich();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action !== 'enrichLeads' || !Array.isArray(msg.urls) || msg.urls.length === 0) {
    sendResponse({ ok: false });
    return true;
  }
  const urls = msg.urls.slice();
  (async () => {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        if (!tab || !tab.id) continue;
        await new Promise(resolve => {
          const listener = (id, info) => {
            if (id === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(resolve, 2000);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 20000);
        });
        await enrichOneUrl(url, tab.id);
      } catch (_) {}
      if (i < urls.length - 1) await delay(DELAY_BETWEEN_LEADS_MS);
    }
    sendResponse({ ok: true });
  })();
  return true;
});
