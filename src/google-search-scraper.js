/**
 * Google Search Email Scraper
 * One job per run: accepts job config, returns contacts. No Supabase — main/runner handles upserts.
 * Job boundaries: one browser per job; browser closed after job. Cancellation checks between operations.
 * IPC progress: only counts/phase sent via progressCallback; no contact arrays or Playwright refs.
 */

const { launchBrowser } = require('./browser-helper');
const { extractEmails, filterBusinessEmails, createContactFromEmail, extractCompanyName, getOgSiteNameFromHtml } = require('./email-extractor');
const { googleDelay } = require('./cooldown-config');
// Import sitemap and contact-page helpers from website-scraper
const { findSitemaps, fetchAllUrlsFromSitemap, fetchUrlsFromHtmlSitemap, getContactPageUrls, getContactLinkUrlsFromPage } = require('./website-scraper');

/** Timeout per page visit. Lower when SCRAPE_FAST=1 (faster but may miss slow pages). */
const VISIT_PAGE_TIMEOUT_MS = process.env.SCRAPE_FAST === '1' || process.env.SCRAPE_FAST === 'true' ? 8000 : 15000;

/**
 * Whether a string looks like a company/organization name (not snippet text or a sentence).
 * Avoids saving "For Sponsorship", "This February, Mining Indaba and 121...", etc. as company.
 */
function looksLikeCompanyName(str) {
  if (!str || typeof str !== 'string') return false;
  const t = str.trim();
  if (t.length > 50) return false;
  const lower = t.toLowerCase();
  const sentenceLike = /\b(for|this|these|the|and|with|our|your|get|see|learn|read|how|what|when|why)\b/i;
  if (sentenceLike.test(lower) && t.length > 20) return false;
  if (/^for\s+/i.test(lower) || /^this\s+/i.test(lower)) return false;
  if ((t.match(/\s/g) || []).length > 4) return false;
  return true;
}

/**
 * Derive company name from URL hostname (e.g. pbf.org.za -> Pbf).
 */
function companyFromUrl(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const domainName = hostname.split('.')[0];
    if (!domainName || domainName.length < 2) return null;
    return domainName.charAt(0).toUpperCase() + domainName.slice(1).toLowerCase();
  } catch (e) {
    return null;
  }
}

/**
 * Extract emails from Google Search result snippets
 * @param {Page} page - Playwright page instance
 * @param {Object} limits
 * @param {number} limits.maxResultLinks - max links to scan on page
 * @param {number} limits.maxUniqueResults - max unique result URLs to keep
 * Phase 1: returns URLs only (resultItems). No snippet email extraction.
 * @returns {{ emailResults: Array<Object>, resultItems: Array<Object> }}
 */
async function extractEmailsFromSearchResults(page, limits = {}) {
  const results = [];
  const maxResultLinks = Number.isFinite(limits.maxResultLinks) ? limits.maxResultLinks : 60;
  const maxUniqueResults = Number.isFinite(limits.maxUniqueResults) ? limits.maxUniqueResults : 30;
  // Must be function-scoped (used in return value even if try/catch fails)
  let searchResults = [];
  
  try {
    // Wait for page to be stable before extracting
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    } catch (e) {
      console.log('Page load wait timed out, continuing...');
    }
    
    // Get all search result elements - try multiple selectors for Google's changing structure
    try {
      searchResults = await page.evaluate(({ maxLinks, maxUnique }) => {
      const items = [];
      const seenUrls = new Set();
      
      // Try multiple selector strategies - Google changes their HTML frequently
      let resultElements = [];
      
      // Strategy 1: Modern Google search results
      resultElements = document.querySelectorAll('div[data-sokoban-container] a[href*="http"]');
      
      // Strategy 2: Classic Google results
      if (resultElements.length === 0) {
        resultElements = document.querySelectorAll('div.g a[href*="http"]');
      }
      
      // Strategy 3: Any div with class containing "result"
      if (resultElements.length === 0) {
        resultElements = document.querySelectorAll('div[class*="result"] a[href^="http"]');
      }
      
      // Strategy 4: Find all links in main content area
      if (resultElements.length === 0) {
        const main = document.querySelector('#main') || document.querySelector('#search') || document.body;
        resultElements = main.querySelectorAll('a[href^="http"]');
      }
      
      // Strategy 5: Last resort - all links except Google's
      if (resultElements.length === 0) {
        resultElements = document.querySelectorAll('a[href^="http"]');
      }
      
      console.log(`Found ${resultElements.length} potential result links`);
      
      resultElements.forEach((link, index) => {
        if (index >= maxLinks) return; // Limit scanned links based on user target
        if (items.length >= maxUnique) return; // Keep unique results based on user target
        
        const url = link.href;
        if (!url || !url.startsWith('http')) return;
        
        // Skip Google's own pages and common non-result links
        if (url.includes('google.com') || 
            url.includes('youtube.com') || 
            url.includes('maps.google.com') ||
            url.includes('accounts.google.com') ||
            url.includes('policies.google.com') ||
            url.includes('support.google.com') ||
            url.startsWith('https://www.google.com/search') ||
            url.includes('webcache') ||
            url.includes('translate.google')) {
          return;
        }
        
        // Skip if we've seen this URL
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        
        // Try to find title
        let title = '';
        const h3 = link.querySelector('h3');
        if (h3) {
          title = h3.innerText || h3.textContent || '';
        } else {
          // Look for h3 in parent containers
          const container = link.closest('div');
          if (container) {
            const h3InContainer = container.querySelector('h3');
            if (h3InContainer) {
              title = h3InContainer.innerText || h3InContainer.textContent || '';
            }
          }
        }
        if (!title) {
          title = link.textContent?.trim() || link.innerText?.trim() || '';
        }
        
        // Try multiple ways to find snippet
        const container = link.closest('div[data-sokoban-container]') || 
                         link.closest('div.g') || 
                         link.closest('div[class*="result"]') ||
                         link.closest('div[class*="MjjYud"]') ||
                         link.parentElement?.parentElement;
        
        let snippet = '';
        if (container) {
          snippet = container.querySelector('span[style*="-webkit-line-clamp"]')?.innerText ||
                   container.querySelector('.VwiC3b')?.innerText ||
                   container.querySelector('span[class*="st"]')?.innerText ||
                   container.querySelector('div[class*="VwiC3b"]')?.innerText ||
                   container.textContent?.trim() || '';
        }
        
        // Clean up snippet (remove title from it)
        if (snippet && title) {
          snippet = snippet.replace(title, '').trim();
        }
        
        items.push({ url, title: title.substring(0, 200), snippet: snippet.substring(0, 500) });
      });
      
        console.log(`Returning ${items.length} unique search results`);
        return items;
      }, { maxLinks: maxResultLinks, maxUnique: maxUniqueResults });
    } catch (error) {
      if (error.message.includes('Execution context was destroyed') || 
          error.message.includes('navigation')) {
        console.log('Page navigated during evaluation, retrying after wait...');
        await googleDelay('afterSearch');
        // Retry once with simpler extraction
        try {
          searchResults = await page.evaluate(({ maxLinks, maxUnique }) => {
            const items = [];
            const seenUrls = new Set();
            const links = document.querySelectorAll('a[href^="http"]');
            
            links.forEach((link, index) => {
              if (index >= maxLinks || items.length >= maxUnique) return;
              const url = link.href;
              if (!url || !url.startsWith('http') || seenUrls.has(url)) return;
              if (url.includes('google.com') || url.includes('youtube.com')) return;
              seenUrls.add(url);
              const title = link.querySelector('h3')?.innerText || link.textContent?.trim() || '';
              items.push({ url, title: title.substring(0, 200), snippet: '' });
            });
            return items;
          }, { maxLinks: maxResultLinks, maxUnique: maxUniqueResults });
        } catch (retryError) {
          console.log('Retry also failed:', retryError.message);
          searchResults = [];
        }
      } else {
        console.log('Error extracting search results:', error.message);
        searchResults = [];
      }
    }
    
    console.log(`Found ${searchResults.length} search results`);
    
    // Debug: Log page structure if no results found
    if (searchResults.length === 0) {
      let pageInfo = {};
      try {
        pageInfo = await page.evaluate(() => {
        return {
          title: document.title,
          hasMain: !!document.querySelector('#main'),
          hasSearch: !!document.querySelector('#search'),
          hasSokoban: !!document.querySelector('div[data-sokoban-container]'),
          hasG: document.querySelectorAll('div.g').length,
          allLinks: document.querySelectorAll('a[href^="http"]').length,
          bodyText: document.body.innerText.substring(0, 500)
        };
        });
      } catch (e) {
        console.log('Could not get page debug info:', e.message);
      }
      console.log('Page debug info:', pageInfo);
    }
    
    // Phase 1: URLs only — no snippet email extraction. Emails come from Phase 2 (visiting contact pages).
    console.log(`Collected ${searchResults.length} result URLs (emails will be extracted when visiting contact pages)`);
  } catch (error) {
    console.log('Error extracting from search results:', error.message);
  }

  return { emailResults: [], resultItems: searchResults };
}

/**
 * Check if a URL is a homepage (just domain or domain/)
 * @param {string} url - URL to check
 * @returns {boolean} - True if looks like homepage
 */
function isHomepage(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    return !path || path === '' || path === '/';
  } catch (e) {
    return false;
  }
}

/**
 * Extract emails from a website by scraping all pages from its sitemap
 * @param {Page} page - Playwright page instance
 * @param {string} websiteUrl - Website homepage URL
 * @param {string} companyName - Company name for context
 * @param {string} originalQuery - Original search query
 * @param {number} maxPages - Maximum pages to scrape from sitemap (default 50)
 * @returns {Array<Object>} - Array of contact objects
 */
async function extractEmailsFromWebsiteWithSitemap(page, websiteUrl, companyName, originalQuery = null, maxPages = 250) {
  const contacts = [];
  const baseDomain = new URL(websiteUrl).hostname.replace(/^www\./, '');
  const sameDomain = (u) => {
    try {
      const host = new URL(u).hostname.replace(/^www\./, '');
      return host === baseDomain;
    } catch (e) { return false; }
  };

  try {
    let allPageUrls = [];
    const xmlSitemaps = await findSitemaps(websiteUrl);
    if (xmlSitemaps && xmlSitemaps.length) {
      for (const sitemapUrl of xmlSitemaps) {
        try {
          const pageUrls = await fetchAllUrlsFromSitemap(sitemapUrl);
          allPageUrls.push(...pageUrls);
        } catch (e) {
          console.log(`Error fetching sitemap ${sitemapUrl}: ${e.message}`);
        }
      }
    }
    if (allPageUrls.length === 0) {
      const htmlUrls = await fetchUrlsFromHtmlSitemap(websiteUrl);
      if (htmlUrls.length) allPageUrls = htmlUrls;
    }
    if (allPageUrls.length === 0) {
      allPageUrls = [websiteUrl];
    }
    const filtered = [...new Set(allPageUrls)].filter(sameDomain).slice(0, maxPages);
    const urlsToScrape = [websiteUrl, ...filtered.filter(u => u !== websiteUrl)];

    console.log(`Found sitemap: will scrape ${urlsToScrape.length} pages from ${websiteUrl}`);

    for (const pageUrl of urlsToScrape) {
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: VISIT_PAGE_TIMEOUT_MS });
        await googleDelay('betweenPageVisits');
        const pageContent = await page.evaluate(() => ({
          text: document.body.innerText || '',
          html: document.body.innerHTML || '',
          title: document.title || '',
          h1: (document.querySelector('h1') && (document.querySelector('h1').innerText || '').trim()) || ''
        }));
        const titlePart = (pageContent.title || '').split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim();
        const pageDisplayName = (titlePart && titlePart.length < 150) ? titlePart : (pageContent.h1 && pageContent.h1.length < 150 ? pageContent.h1 : '') || companyName || '';
        const allEmails = extractEmails(pageContent.text, pageContent.html);
        const businessEmails = filterBusinessEmails(allEmails);
        for (const email of businessEmails) {
          const contact = createContactFromEmail(email, pageContent.text, {
            company: companyName || null,
            company_website: websiteUrl,
            source: 'google_search',
            search_query: originalQuery,
            pageDisplayName: pageDisplayName || companyName || null
          });
          if (contact) contacts.push(contact);
        }
      } catch (e) {
        console.log(`Error scraping ${pageUrl}: ${e.message}`);
      }
    }
  } catch (error) {
    console.log(`Error extracting from website ${websiteUrl}: ${error.message}`);
  }
  return contacts;
}

/**
 * Visit a URL and extract emails from the page (or all pages if homepage with sitemap)
 * @param {Page} page - Playwright page instance
 * @param {string} url - URL to visit
 * @param {string} companyName - Company name for context
 * @param {string} originalQuery - Original search query (before "email contact" was added)
 * @returns {Array<Object>} - Array of contact objects
 */
/**
 * Phase 2: Visit a result URL — get company name from it, then extract emails only from the Contact us page(s).
 * If no contact page has emails, fall back to the landing page so we don't miss homepage-only emails.
 */
async function extractEmailsFromPage(page, url, companyName, originalQuery = null) {
  const contacts = [];
  const seenEmails = new Set();

  try {
    // Load the result URL only to get company name (and fallback if no contact page has emails)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: VISIT_PAGE_TIMEOUT_MS });
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    } catch (e) {}

    let pageContent = { text: '', html: '', title: '', h1: '' };
    try {
      pageContent = await page.evaluate(() => ({
        text: document.body && (document.body.innerText || ''),
        html: document.body && (document.body.innerHTML || ''),
        title: document.title || '',
        h1: (document.querySelector('h1') && (document.querySelector('h1').innerText || '').trim()) || ''
      }));
    } catch (error) {
      if (error.message.includes('Execution context was destroyed') || error.message.includes('navigation')) {
        return contacts;
      }
      throw error;
    }

    // Get company name: prefer extractCompanyName from page title/og:site_name/url; fallback to result title then domain
    let company = extractCompanyName({
      title: pageContent.title,
      url,
      ogSiteName: getOgSiteNameFromHtml(pageContent.html) || null
    }) || companyName || null;
    if (!company) {
      try {
        const urlObj = new URL(url);
        company = (urlObj.hostname.replace('www.', '').split('.')[0] || '').charAt(0).toUpperCase() + (urlObj.hostname.replace('www.', '').split('.')[0] || '').slice(1);
      } catch (e2) {
        company = '';
      }
    }
    if (company) {
      [' - contact us', ' | contact us', ' contact', ' - contact', ' | contact'].forEach(suffix => {
        if (company.toLowerCase().endsWith(suffix.toLowerCase())) company = company.substring(0, company.length - suffix.length).trim();
      });
    }
    // When company came from page (not from result title), replace with URL if it doesn't look like a company name. Keep result title when provided.
    if (company && !looksLikeCompanyName(company) && !companyName) {
      company = companyFromUrl(url) || company;
    }

    // ——— Extract emails from Contact us page(s): first try links found on the page, then guessed paths ———
    let baseOrigin;
    try {
      baseOrigin = new URL(url).origin;
    } catch (e) {
      baseOrigin = null;
    }
    const sameOrigin = (u) => { try { return new URL(u).origin === baseOrigin; } catch (e) { return false; } };

    const tryContactUrl = async (contactUrl) => {
      if (contactUrl === url) return;
      try {
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(VISIT_PAGE_TIMEOUT_MS, 10000) });
        await googleDelay('betweenPageVisits');
        const contactPageContent = await page.evaluate(() => ({
          text: document.body && (document.body.innerText || ''),
          html: document.body && (document.body.innerHTML || ''),
          title: document.title || '',
          h1: (document.querySelector('h1') && (document.querySelector('h1').innerText || '').trim()) || ''
        }));
        const titlePart = (contactPageContent.title || '').split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim();
        const pageDisplayName = (titlePart && titlePart.length < 150) ? titlePart : (contactPageContent.h1 && contactPageContent.h1.length < 150 ? contactPageContent.h1 : '') || company || '';
        const contactEmails = extractEmails(contactPageContent.text || '', contactPageContent.html || '');
        const contactBusiness = filterBusinessEmails(contactEmails);
        for (const email of contactBusiness) {
          if (contacts.length >= 2) break; // max 2 contacts per website
          const lower = email.toLowerCase();
          if (seenEmails.has(lower)) continue;
          seenEmails.add(lower);
          const contact = createContactFromEmail(email, contactPageContent.text || '', {
            company: company || null,
            company_website: url,
            source: 'google_search',
            search_query: originalQuery,
            pageDisplayName: pageDisplayName || company || null
          });
          if (contact) contacts.push(contact);
        }
      } catch (e) {
        // Contact page failed — try next candidate
      }
    };

    if (baseOrigin) {
      // 1) Contact links found on the current page (we're already on the landing page)
      const linkUrls = await getContactLinkUrlsFromPage(page, url, 5);
      for (const contactUrl of linkUrls) {
        await tryContactUrl(contactUrl);
      }
      // 2) Fallback: guessed contact paths
      const guessedUrls = getContactPageUrls(url).filter(sameOrigin).slice(0, 5);
      for (const contactUrl of guessedUrls) {
        await tryContactUrl(contactUrl);
      }
    }

    // Fallback: if no contact page had emails, use the landing page we already loaded
    if (contacts.length === 0) {
      const titlePart = (pageContent.title || '').split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim();
      const pageDisplayName = (titlePart && titlePart.length < 150) ? titlePart : (pageContent.h1 && pageContent.h1.length < 150 ? pageContent.h1 : '') || company || '';
      const allEmails = extractEmails(pageContent.text, pageContent.html);
      const businessEmails = filterBusinessEmails(allEmails).slice(0, 2); // max 2 per website
      for (const email of businessEmails) {
        const contact = createContactFromEmail(email, pageContent.text, {
          company: company || null,
          company_website: url,
          source: 'google_search',
          search_query: originalQuery,
          pageDisplayName: pageDisplayName || company || null
        });
        if (contact) contacts.push(contact);
      }
    }
  } catch (error) {
    console.log(`Error extracting from ${url}:`, error.message);
  }

  return contacts.slice(0, 2); // max 2 contacts per website
}

/**
 * Run Google Search email scraper — one job config; returns contacts; no Supabase.
 * @param {Object} config - { searchQuery, originalQuery, maxResults, industry, keywords }
 * @param {Function} progressCallback - Progress callback (counts/phase only; no contact arrays)
 * @param {Object} options - { checkCancellation }
 * @returns {Array<Object>} - Array of contact objects
 */
async function runGoogleSearchScraper(config, progressCallback, options = {}) {
  const { searchQuery, originalQuery: configOriginalQuery, maxResults = 20, industry = null, keywords = null } = config || {};
  const originalQuery = configOriginalQuery != null ? configOriginalQuery : searchQuery;
  const checkCancellation = options.checkCancellation || (() => false);
  const scrapedContacts = [];
  let browser;
  
  // Scale internal limits from the user's target (maxResults); bulk up to 2,500.
  const maxUniqueResults = Math.min(3000, Math.max(30, maxResults * 5));
  const maxResultLinks = Math.min(3000, Math.max(60, maxResults * 12));
  const maxUrlsToVisit = Math.min(3000, Math.max(30, maxResults * 12));
  
  try {
    progressCallback({ 
      status: 'Launching browser...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'init'
    });
    
    browser = await launchBrowser({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    
    // ========== PHASE 1: SEARCH GOOGLE ==========
    progressCallback({ 
      status: `Searching Google for "${searchQuery}"...`, 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'search'
    });
    
    // Build search query - add "email" or "contact" if not present
    let query = searchQuery.trim();
    if (!query.toLowerCase().includes('email') && !query.toLowerCase().includes('contact')) {
      query = `${query} email contact`;
    }
    
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await googleDelay('afterSearch');
    
    // Wait for results - try multiple selectors
    try {
      await page.waitForSelector('div[data-sokoban-container], div.g, #main, #search', { timeout: 15000 });
    } catch (e) {
      console.log('Waiting for search results timed out, continuing anyway...');
    }
    await googleDelay('afterResults');
    
    // Check if we're on a CAPTCHA page
    let isCaptcha = false;
    try {
      isCaptcha = await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        return bodyText.includes('captcha') || 
               bodyText.includes('unusual traffic') ||
               bodyText.includes('verify you\'re not a robot') ||
               bodyText.includes('verify you are not a robot') ||
               document.querySelector('form[action*="captcha"]') !== null ||
               document.querySelector('iframe[src*="recaptcha"]') !== null;
      });
    } catch (e) {
      console.log('Could not check for CAPTCHA:', e.message);
    }
    
    if (isCaptcha) {
      progressCallback({
        status: '⚠️ Google CAPTCHA detected. Please solve it in the browser window, then the scraper will continue automatically...',
        profilesFound: 0,
        profilesScraped: 0,
        phase: 'captcha'
      });
      
      // Wait for user to solve CAPTCHA (up to 2 minutes)
      console.log('Waiting for CAPTCHA to be solved...');
      let captchaSolved = false;
      const maxWaitTime = 120000; // 2 minutes
      const startTime = Date.now();
      
      while (!captchaSolved && (Date.now() - startTime) < maxWaitTime) {
        await googleDelay('captchaCheck');
        
        let stillCaptcha = false;
        try {
          stillCaptcha = await page.evaluate(() => {
            const bodyText = document.body.innerText.toLowerCase();
            return bodyText.includes('captcha') || 
                   bodyText.includes('unusual traffic') ||
                   bodyText.includes('verify you\'re not a robot') ||
                   document.querySelector('iframe[src*="recaptcha"]') !== null;
          });
        } catch (e) {
          // If evaluation fails, assume CAPTCHA is still there
          stillCaptcha = true;
        }
        
        if (!stillCaptcha) {
          captchaSolved = true;
          console.log('CAPTCHA appears to be solved, continuing...');
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); // Smart wait
          break;
        }
      }
      
      if (!captchaSolved) {
        throw new Error('CAPTCHA not solved within 2 minutes. Please try again or use a different source.');
      }
    }
    
    // ========== PHASE 2: EXTRACT EMAILS FROM SEARCH RESULTS (WITH PAGINATION) ==========
    progressCallback({ 
      status: 'Extracting emails from search results (page 1)...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'extract'
    });
    
    // Phase 1: Collect URLs only (no snippet emails)
    let allResultItems = [];
    let currentPage = 1;
    // Scale max pages based on target: ~10 results per page; bulk cap 250 pages (2,500 results)
    const maxPages = Math.min(250, Math.max(1, Math.ceil(maxResults / 10)));
    
    while (currentPage <= maxPages) {
      // Check for cancellation before each page
      if (checkCancellation && checkCancellation()) {
        progressCallback({ 
          status: 'Scraping cancelled by user', 
profilesFound: allResultItems.length,
          profilesScraped: scrapedContacts.length,
          cancelled: true,
          phase: 'extract'
        });
        break;
      }
      
      if (currentPage > 1) {
        progressCallback({
          status: `Collecting URLs from page ${currentPage}...`,
          profilesFound: allResultItems.length,
          profilesScraped: scrapedContacts.length,
          phase: 'extract'
        });
      }
      
      // Scroll down to load more results on current page
      if (maxResults > 10) {
        try {
          const scrollSteps = Math.min(5, Math.max(2, Math.ceil(maxResults / 20)));
          for (let scroll = 0; scroll < scrollSteps; scroll++) {
            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
            });
            await googleDelay('scroll');
          }
          await page.evaluate(() => {
            window.scrollTo(0, 0);
          });
          await googleDelay('scroll');
        } catch (e) {
          console.log('Error scrolling:', e.message);
        }
      }
      
      // Extract from current page
      const { emailResults, resultItems } = await extractEmailsFromSearchResults(page, {
        maxResultLinks,
        maxUniqueResults
      });
      
      if (resultItems && resultItems.length > 0) {
        allResultItems = allResultItems.concat(resultItems);
      }
      
      // Stop pagination when we have enough URLs (Phase 2 will visit them and get emails from contact pages)
      if (allResultItems.length >= maxResults) {
        console.log(`Collected ${allResultItems.length} URLs, stopping pagination — Phase 2 will visit contact pages`);
        break;
      }
      
      // Try to click "Next" button to go to next page
      if (currentPage < maxPages && allResultItems.length < maxResults) {
        const hasNextPage = await page.evaluate(() => {
          // Try multiple selectors for Google's "Next" button
          const nextSelectors = [
            'a[aria-label="Next"]',
            'a#pnnext',
            'a[aria-label*="Next"]',
            'td[style*="text-align"] a[aria-label*="Next"]',
            'a[href*="start="]' // Google pagination URL pattern
          ];
          
          for (const selector of nextSelectors) {
            try {
              const nextBtn = document.querySelector(selector);
              if (nextBtn) {
                const href = nextBtn.href || nextBtn.getAttribute('href') || '';
                if (href && !href.includes('javascript:') && (href.includes('start=') || href.includes('&start='))) {
                  return true;
                }
              }
            } catch (e) {}
          }
          
          // Check pagination table for Next link
          const paginationTable = document.querySelector('table[role="presentation"]');
          if (paginationTable) {
            const nextLink = paginationTable.querySelector('a#pnnext, a[aria-label*="Next"]');
            if (nextLink && nextLink.href && !nextLink.href.includes('javascript:')) {
              return true;
            }
          }
          
          // Check for pagination numbers - if we see page numbers, there might be a next page
          const pageNumbers = document.querySelectorAll('a[aria-label*="Page"], td a[href*="start="]');
          if (pageNumbers.length > 0) {
            // Check if there's a link with a higher start parameter
            let maxStart = 0;
            pageNumbers.forEach(link => {
              const href = link.href || '';
              const match = href.match(/[?&]start=(\d+)/);
              if (match) {
                const start = parseInt(match[1], 10);
                if (start > maxStart) maxStart = start;
              }
            });
            // If we found links with start parameters, there might be more pages
            return maxStart > 0;
          }
          
          return false;
        });
        
        if (hasNextPage) {
          try {
            const clicked = await page.evaluate(() => {
              // Try clicking the Next button - priority order
              const nextSelectors = [
                'a#pnnext', // Most reliable Google Next button ID
                'a[aria-label="Next"]',
                'a[aria-label*="Next"]',
                'td[style*="text-align"] a[aria-label*="Next"]'
              ];
              
              for (const selector of nextSelectors) {
                try {
                  const nextBtn = document.querySelector(selector);
                  if (nextBtn) {
                    const href = nextBtn.href || nextBtn.getAttribute('href') || '';
                    if (href && !href.includes('javascript:') && (href.includes('start=') || href.includes('&start='))) {
                      nextBtn.click();
                      return true;
                    }
                  }
                } catch (e) {}
              }
              
              // Fallback: find link with highest start= parameter (next page)
              const links = Array.from(document.querySelectorAll('a[href*="start="]'));
              let nextLink = null;
              let maxStart = -1;
              
              for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                const match = href.match(/[?&]start=(\d+)/);
                if (match) {
                  const start = parseInt(match[1], 10);
                  if (start > maxStart) {
                    maxStart = start;
                    nextLink = link;
                  }
                }
              }
              
              if (nextLink && maxStart > 0) {
                nextLink.click();
                return true;
              }
              
              return false;
            });
            
            if (clicked) {
              // Wait for page to load and search results to appear
              try {
                await page.waitForSelector('div[data-sokoban-container], div.g, #main, #search', { timeout: 15000 });
              } catch (e) {
                console.log('Waiting for search results timed out, continuing...');
              }
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              await googleDelay('afterSearch');
              
              // Verify we're on a new page (not CAPTCHA, not same page)
              const pageCheck = await page.evaluate(() => {
                const bodyText = document.body.innerText.toLowerCase();
                const isCaptcha = bodyText.includes('captcha') || 
                                  bodyText.includes('unusual traffic') ||
                                  document.querySelector('iframe[src*="recaptcha"]') !== null;
                
                // Check if we have search results (verify we navigated)
                const hasResults = !!(
                  document.querySelector('div[data-sokoban-container]') ||
                  document.querySelector('div.g') ||
                  document.querySelector('#main')
                );
                
                return { isCaptcha, hasResults };
              });
              
              if (pageCheck.isCaptcha) {
                console.log('CAPTCHA detected on next page — waiting for you to solve it...');
                progressCallback({
                  status: '⚠️ CAPTCHA on next page. Solve it in the browser, then scraping will continue.',
                  profilesFound: allResultItems.length,
                  profilesScraped: scrapedContacts.length,
                  phase: 'captcha'
                });
                let captchaSolved = false;
                const maxWait = 120000;
                const start = Date.now();
                while (!captchaSolved && (Date.now() - start) < maxWait) {
                  await googleDelay('captchaCheck');
                  const still = await page.evaluate(() => {
                    const t = document.body.innerText.toLowerCase();
                    return t.includes('captcha') || t.includes('unusual traffic') || !!document.querySelector('iframe[src*="recaptcha"]');
                  }).catch(() => true);
                  if (!still) {
                    captchaSolved = true;
                    console.log('CAPTCHA solved, continuing pagination');
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                  }
                }
                if (!captchaSolved) {
                  console.log('CAPTCHA not solved in time, stopping pagination');
                  break;
                }
                currentPage++;
                await googleDelay('afterResults');
                continue;
              }
              
              if (!pageCheck.hasResults) {
                console.log('No search results found on new page, stopping pagination');
                break;
              }
              
              currentPage++;
              await googleDelay('afterResults');
            } else {
              console.log('No next page button found, stopping pagination');
              break;
            }
          } catch (error) {
            console.log('Error clicking next page:', error.message);
            break;
          }
        } else {
          console.log('No more pages available, stopping pagination');
          break;
        }
      } else {
        break; // Reached max pages
      }
    }
    
    console.log(`Phase 1 complete: Collected ${allResultItems.length} URLs from ${currentPage} page(s). Phase 2: visiting contact pages for emails.`);

    // ========== PHASE 2: VISIT URLS → FIND CONTACT PAGE → EXTRACT EMAILS ==========
    progressCallback({
      status: 'Visiting URLs to find contact pages and extract emails...',
      profilesFound: (allResultItems && allResultItems.length) ? allResultItems.length : 0,
      profilesScraped: scrapedContacts.length,
      phase: 'visit'
    });
    
    // Get URLs and preserve result title (underlined "company name" in search results) per URL
    let uniqueUrls = [];
    const urlToTitle = new Map();
    if (allResultItems && allResultItems.length > 0) {
      for (const r of allResultItems) {
        if (r.url && !urlToTitle.has(r.url)) {
          urlToTitle.set(r.url, (r.title && r.title.trim()) || '');
          uniqueUrls.push(r.url);
        }
      }
      uniqueUrls = uniqueUrls.slice(0, maxUrlsToVisit);
    } else {
      console.log('Could not extract structured results; extracting URLs directly from page...');
      try {
        uniqueUrls = await page.evaluate((maxUrls) => {
          const urls = [];
          const seen = new Set();
          
          // Try multiple strategies to find result URLs
          let links = document.querySelectorAll('div[data-sokoban-container] a[href^="http"]');
          if (links.length === 0) {
            links = document.querySelectorAll('div.g a[href^="http"]');
          }
          if (links.length === 0) {
            links = document.querySelectorAll('div[class*="result"] a[href^="http"]');
          }
          if (links.length === 0) {
            const main = document.querySelector('#main') || document.querySelector('#search');
            if (main) {
              links = main.querySelectorAll('a[href^="http"]');
            }
          }
          
          links.forEach(link => {
            const url = link.href;
            if (!url || seen.has(url)) return;
            
            // Skip Google's own pages
            if (url.includes('google.com') || 
                url.includes('youtube.com') || 
                url.includes('maps.google.com') ||
                url.includes('accounts.google.com') ||
                url.startsWith('https://www.google.com/search') ||
                url.includes('webcache') ||
                url.includes('translate.google')) {
              return;
            }
            
            seen.add(url);
            urls.push(url);
          });
          
          return urls.slice(0, maxUrls);
        }, maxUrlsToVisit);
      } catch (error) {
        console.log('Error extracting URLs:', error.message);
        uniqueUrls = [];
      }
      console.log(`Extracted ${uniqueUrls.length} URLs to visit`);
    }
    
    // Continue visiting URLs until we reach maxResults or run out of URLs
    if (uniqueUrls.length > 0) {
      console.log(`Visiting ${uniqueUrls.length} URLs to find more contacts (currently have ${scrapedContacts.length}/${maxResults})`);
      
      for (let i = 0; i < uniqueUrls.length && scrapedContacts.length < maxResults; i++) {
        // Check for cancellation before each page visit
        if (checkCancellation && checkCancellation()) {
          progressCallback({ 
            status: 'Scraping cancelled by user', 
            profilesFound: uniqueUrls.length, 
            profilesScraped: scrapedContacts.length,
            cancelled: true,
            phase: 'visit'
          });
          break;
        }
        
        const url = uniqueUrls[i];
        
        progressCallback({ 
          status: `Visiting result ${i + 1}/${uniqueUrls.length}...`, 
          profilesFound: uniqueUrls.length, 
          profilesScraped: scrapedContacts.length,
          phase: 'visit'
        });
        
        try {
          // Company = search result title (the underlined link text, e.g. "SOLA Group"). Name = page <title> or <h1> only (no person name).
          const resultTitle = urlToTitle.get(url) || null;
          const pageContacts = await extractEmailsFromPage(page, url, resultTitle, originalQuery);
          
          // Add industry and keywords to contacts
          pageContacts.forEach(contact => {
            if (!contact.industry) contact.industry = industry;
            if (!contact.keywords) contact.keywords = keywords;
          });
          
          scrapedContacts.push(...pageContacts);
          
          // Remove duplicates by email
          const seen = new Set();
          const unique = scrapedContacts.filter(contact => {
            if (seen.has(contact.email)) return false;
            seen.add(contact.email);
            return true;
          });
          scrapedContacts.length = 0;
          scrapedContacts.push(...unique);
          
        } catch (error) {
          console.log(`Error visiting ${url}:`, error.message);
        }
        
        await googleDelay('betweenPageVisits');
      }
    } else {
      console.log('No URLs found to visit or already reached max results');
    }
    
    // Return contacts; main/runner handles Supabase upsert. No contact arrays over IPC.
    const uniqueContacts = [...new Map(scrapedContacts.map(c => [c.email, c])).values()];
    progressCallback({ 
      status: `Complete! ${uniqueContacts.length} contacts found.`, 
      profilesFound: uniqueContacts.length, 
      profilesScraped: uniqueContacts.length,
      phase: 'complete',
      completed: true,
      stats: { total: uniqueContacts.length, withEmail: uniqueContacts.filter(c => c.email).length }
    });
    await googleDelay('final');
    await browser.close();
    return uniqueContacts;
    
  } catch (error) {
    progressCallback({ 
      status: `Error: ${error.message}`, 
      profilesFound: 0, 
      profilesScraped: scrapedContacts.length,
      phase: 'error',
      error: true
    });
    if (browser) await browser.close();
    throw error;
  }
}

module.exports = { runGoogleSearchScraper };
