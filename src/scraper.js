/**
 * LinkedIn scraper — one job config; returns contacts; no Supabase.
 * Job boundaries: one browser per job; browser closed after job. Cancellation checks between profiles.
 * IPC progress: only counts/phase via progressCallback; no contact arrays or Playwright refs.
 */

const { launchBrowser } = require('./browser-helper');
const { extractEmails, filterBusinessEmails, createContactFromEmail } = require('./email-extractor');
const { linkedinDelay } = require('./cooldown-config');
const { getContactPageUrls, getContactLinkUrlsFromPage } = require('./website-scraper');
const { resolveMx, verifyEmailMxSyntax } = require('./smtp-verifier');

const MAX_CONTACT_PAGES_TO_TRY = 5;
const MAX_GENERATED_EMAILS_TO_VERIFY = 10;
const CONTACT_PAGE_TIMEOUT_MS = 12000;

/** Run page.evaluate; if context was destroyed (e.g. navigation), wait and retry once or return default. */
async function safeEvaluate(page, fn, defaultValue = null) {
  try {
    return await page.evaluate(fn);
  } catch (e) {
    if (e.message && (e.message.includes('Execution context was destroyed') || e.message.includes('Target closed'))) {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      try {
        return await page.evaluate(fn);
      } catch (e2) {
        return defaultValue;
      }
    }
    throw e;
  }
}

/** Scroll the page using real mouse wheel and keyboard so LinkedIn actually scrolls. */
async function scrollPageWithInput(page, options = {}) {
  const { rounds = 30, wheelStep = 600, useKeyboard = true } = options;
  let centerX = 800, centerY = 450;
  try {
    const v = page.viewportSize();
    if (v && v.width && v.height) {
      centerX = Math.floor(v.width / 2);
      centerY = Math.floor(v.height / 2);
    }
  } catch (e) {}
  try {
    await page.mouse.move(centerX, centerY);
  } catch (e) {}
  for (let i = 0; i < rounds; i++) {
    try {
      await page.mouse.wheel(0, wheelStep);
    } catch (e) {}
    await new Promise(r => setTimeout(r, 80));
  }
  if (useKeyboard) {
    for (let k = 0; k < 8; k++) {
      try { await page.keyboard.press('PageDown'); } catch (e) {}
      await new Promise(r => setTimeout(r, 100));
    }
    try { await page.keyboard.press('End'); } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
}

/** Scroll pagination / Next button into view so it becomes visible and clickable. */
async function scrollPaginationIntoView(page) {
  await scrollPageWithInput(page, { rounds: 15, useKeyboard: true });
  await page.evaluate(() => {
    const pagination = document.querySelector('.artdeco-pagination');
    if (pagination) pagination.scrollIntoView({ behavior: 'instant', block: 'end' });
    const nextBtn = document.querySelector('button.artdeco-pagination__button--next, button[class*="artdeco-pagination__button--next"], button[aria-label="Next"], button[aria-label*="Next"]');
    if (nextBtn) nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
}

/** Reset browser zoom / scaling so pagination controls are visible. */
async function normalizeZoom(page) {
  // Reset zoom (Windows/Linux: Ctrl+0, macOS: Cmd+0)
  try { await page.keyboard.press('ControlOrMeta+0'); } catch (e) {}
  // Some environments start zoomed-in; zoom out slightly as a safety net.
  try { await page.keyboard.press('ControlOrMeta+Minus'); } catch (e) {}
  try { await page.keyboard.press('ControlOrMeta+Minus'); } catch (e) {}
  // Give the UI a moment to reflow.
  try { await page.waitForTimeout(150); } catch (e) {}
}

/** Same logic as Sales Nav extension: in-page click so LinkedIn's handlers fire. Returns true if clicked. */
async function clickNextButton(page) {
  const clicked = await page.evaluate(() => {
    const selectors = [
      'button.artdeco-pagination__button--next',
      '.artdeco-pagination__button--next',
      'button[class*="artdeco-pagination__button--next"]',
      'button[aria-label="Next"]',
      'button[aria-label="Next page"]',
      'a[aria-label="Next"]',
      '.artdeco-pagination button:last-of-type',
      'a.next',
      '.pagination__next a',
      'li.artdeco-pagination__indicator--number-active + li button',
      'li.artdeco-pagination__indicator--number-active + li a'
    ];
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el && el.getAttribute('aria-disabled') !== 'true' && !el.disabled) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return true;
      }
    }
    const nodes = document.querySelectorAll('button, a');
    for (let j = 0; j < nodes.length; j++) {
      const text = (nodes[j].innerText || nodes[j].textContent || '').trim().toLowerCase();
      if (text === 'next' || text === 'next page') {
        if (nodes[j].getAttribute('aria-disabled') !== 'true' && !nodes[j].disabled) {
          nodes[j].scrollIntoView({ block: 'center', behavior: 'instant' });
          nodes[j].click();
          return true;
        }
      }
    }
    return false;
  }).catch(() => false);
  if (clicked) return true;
  const selectors = [
    'button.artdeco-pagination__button--next',
    'button[class*="artdeco-pagination__button--next"]',
    'button[aria-label="Next"]',
    'a[aria-label="Next"]',
    '.artdeco-pagination button:last-of-type'
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const disabled = await btn.getAttribute('disabled').catch(() => null);
      const ariaDisabled = await btn.getAttribute('aria-disabled').catch(() => null);
      if (disabled === '' || disabled === 'true' || ariaDisabled === 'true') continue;
      await btn.click({ timeout: 3000, noWaitAfter: true });
      return true;
    } catch (e) {
      continue;
    }
  }
  return false;
}

// Personal email domains to exclude
const personalEmailDomains = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'ymail.com',
  'msn.com', 'mail.com', 'zoho.com'
];

function isPersonalEmail(email) {
  if (!email) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return personalEmailDomains.includes(domain);
}

function extractDomain(email) {
  if (!email) return '';
  return email.split('@')[1] || '';
}

// Helper function to truncate strings to database column limits
function truncateField(value, maxLength = 100) {
  if (!value || typeof value !== 'string') return value;
  return value.length > maxLength ? value.substring(0, maxLength) : value;
}

function generateEmails(firstName, lastName, domain) {
  if (!domain) return [];
  const patterns = [`info@${domain}`];
  const first = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const last = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (first || last) {
    patterns.push(
    `${first}.${last}@${domain}`,
    `${first}@${domain}`,
    `${first}${last}@${domain}`,
    `${first.charAt(0)}${last}@${domain}`,
    `${first}_${last}@${domain}`,
      `${first}-${last}@${domain}`
    );
  }
  return patterns.filter(email => email.includes('@') && !email.includes('undefined'));
}


async function extractProfileData(page) {
  try {
    await page.waitForSelector('h1', { timeout: 10000 });
    
    return await page.evaluate(() => {
      const nameElement = document.querySelector('h1');
      const fullName = nameElement?.innerText?.trim() || '';
      
      const headlineElement = document.querySelector('.text-body-medium');
      const headline = headlineElement?.innerText?.trim() || '';
      
      let location = '';
      const locationElement = document.querySelector('span.text-body-small.inline.t-black--light.break-words');
      if (locationElement) {
        location = locationElement.innerText?.trim() || '';
        location = location.split('·')[0].trim();
      }
      
      let jobTitle = '';
      let company = '';
      
      if (headline.includes(' at ')) {
        const parts = headline.split(' at ');
        jobTitle = parts[0].trim();
        company = parts[1]?.split('·')[0]?.trim() || '';
      } else if (headline.includes(' @ ')) {
        const parts = headline.split(' @ ');
        jobTitle = parts[0].trim();
        company = parts[1]?.split('·')[0]?.trim() || '';
      } else if (headline.includes('|')) {
        const parts = headline.split('|');
        jobTitle = parts[0].trim();
        company = parts[1]?.trim() || '';
      } else {
        const parts = headline.split('·')[0]?.trim().split(/\s+/).filter(Boolean) || [];
        if (parts.length >= 2) {
          jobTitle = parts.slice(0, 2).join(' ');
          company = parts.slice(2).join(' ').trim();
      } else {
        jobTitle = headline.split('·')[0]?.trim() || '';
        }
      }
      
      // Try to get company from experience section if not found
      if (!company) {
        const expCompany = document.querySelector('.experience-item__subtitle');
        if (expCompany) {
          company = expCompany.innerText?.trim() || '';
        }
      }
      
      return { fullName, jobTitle, company, headline, location };
    });
  } catch (error) {
    console.log('Error extracting profile data:', error.message);
    return null;
  }
}

/**
 * Diagnostic: discover DOM structure on a Sales Nav lead page for selector tuning.
 * Returns title, url, and candidate elements (tag, class, text) so we can see what's on the page.
 */
async function discoverSalesNavLeadDOM(page) {
  try {
    return await page.evaluate(() => {
      const out = { title: document.title || '', url: window.location.href || '', candidates: {}, mainLines: [] };
      const collect = (selector, key) => {
        const el = document.querySelector(selector);
        if (el) {
          const text = (el.innerText || el.textContent || '').trim().substring(0, 120);
          out.candidates[key] = { selector, tag: el.tagName, class: (el.className || '').substring(0, 80), text };
        }
      };
      const collectAll = (selector, key) => {
        const nodes = document.querySelectorAll(selector);
        const arr = [];
        nodes.forEach((el, i) => {
          if (i < 5) {
            const text = (el.innerText || el.textContent || '').trim().substring(0, 100);
            if (text) arr.push({ tag: el.tagName, class: (el.className || '').substring(0, 60), text });
          }
        });
        if (arr.length) out.candidates[key] = arr;
      };
      collect('h1', 'h1');
      collect('h2', 'h2');
      collect('.text-heading-xlarge', 'text-heading-xlarge');
      collect('.text-body-medium', 'text-body-medium');
      collect('.artdeco-entity-lockup__title', 'artdeco-entity-lockup__title');
      collect('.artdeco-entity-lockup__subtitle', 'artdeco-entity-lockup__subtitle');
      collect('[data-anonymize="person-name"]', 'person-name');
      collect('[data-anonymize="headline"]', 'headline');
      collect('[data-anonymize="location"]', 'location');
      collectAll('[class*="lead-name"]', 'lead-name');
      collectAll('[class*="headline"]', 'headline-class');
      collectAll('[class*="title"]', 'title-class');
      collectAll('[class*="company"]', 'company-class');
      collectAll('[class*="location"]', 'location-class');
      const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.scaffold-layout__main') || document.body;
      const raw = (main ? (main.innerText || main.textContent) : document.body.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 150);
      out.mainLines = raw.slice(0, 20);
      return out;
    });
  } catch (e) {
    return { error: e.message };
  }
}

/** Reject generic Sales Nav / LinkedIn page text so we don't save it as a person's name. */
function isGenericSalesNavOrLinkedInName(name) {
  if (!name || typeof name !== 'string') return true;
  const t = name.trim();
  if (t.length < 3) return true;
  const lower = t.toLowerCase();
  const generic = ['sales navigator lead', 'sales navigator', 'lead', 'linkedin', 'log in', 'sign in', 'linkedin lead', 'lead profile', 'lead |'];
  if (generic.some(g => lower === g || lower.startsWith(g + ' ') || lower.endsWith(' ' + g))) return true;
  if (/^linkedin\s*[|\-–—]|[|\-–—]\s*linkedin$/i.test(t)) return true;
  return false;
}

/**
 * Extract name, title, company, location from Sales Navigator lead view (different DOM than /in/ profile).
 * Uses same priority as extension: [data-anonymize="person-name"] then h1, etc. Rejects generic page titles.
 */
async function extractProfileDataFromSalesLeadPage(page) {
  try {
    const raw = await page.evaluate(() => {
      let fullName = '';
      let headline = '';
      let jobTitle = '';
      let company = '';
      let location = '';
      const sel = (arr) => { for (const s of arr) { const e = document.querySelector(s); if (e) return (e.innerText || e.textContent || '').trim(); } return ''; };
      // Extension order: person-name first, then h1, then lockup title
      fullName = sel([
        '[data-anonymize="person-name"]', 'h1', '.text-heading-xlarge', '.artdeco-entity-lockup__title',
        '[class*="lead-name"]', '[class*="profile-card"] h1', '[class*="entity-lockup"] .artdeco-entity-lockup__title'
      ]);
      headline = sel([
        '[data-anonymize="headline"]', '[data-anonymize="title"]', '.text-body-medium', '[class*="headline"]',
        '.artdeco-entity-lockup__subtitle', '.pv-text-details__left-panel .text-body-medium',
        '[class*="entity-lockup"] .artdeco-entity-lockup__subtitle', '[class*="profile-card"] .text-body-medium'
      ]);
      location = sel([
        '[data-anonymize="location"]', 'span.text-body-small.inline', '[class*="location"]', '.text-body-small',
        '.artdeco-entity-lockup__caption', '[class*="entity-lockup"] .text-body-small', '[class*="profile-card"] .text-body-small'
      ]);
      if (headline) {
        if (headline.includes(' at ')) {
          const p = headline.split(' at ');
          jobTitle = p[0].trim();
          company = (p[1] || '').split('·')[0].trim();
        } else if (headline.includes(' @ ')) {
          const p = headline.split(' @ ');
          jobTitle = p[0].trim();
          company = (p[1] || '').split('·')[0].trim();
        } else {
          const parts = (headline.split('·')[0] || '').trim().split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            jobTitle = parts.slice(0, 2).join(' ');
            company = parts.slice(2).join(' ').trim();
          } else {
            jobTitle = headline.split('·')[0].trim();
          }
        }
      }
      if (!fullName && headline) fullName = headline.replace(/\s+at\s+.*/i, '').replace(/\s+@\s+.*/i, '').trim();
      if (!fullName || !headline) {
        const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.scaffold-layout__main') || document.body;
        const lines = (main ? (main.innerText || main.textContent) : document.body.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 1 && l.length < 120);
        if (!fullName && lines[0] && !/linkedin|log in|sign|cookie|privacy|menu|search|sales navigator|^lead\s*$/i.test(lines[0])) fullName = lines[0];
        if (!headline && lines[1]) headline = lines[1];
        if (headline && !jobTitle) jobTitle = headline.split(' at ')[0].split(' @ ')[0].trim();
        if (headline && !company && headline.includes(' at ')) company = headline.split(' at ')[1].split('·')[0].trim();
        if (!location && lines[2] && lines[2].length < 80) location = lines[2];
      }
      return { fullName, jobTitle, company, headline, location };
    });
    if (!raw) return null;
    if (raw.fullName && isGenericSalesNavOrLinkedInName(raw.fullName)) raw.fullName = '';
    return raw;
  } catch (e) {
    return null;
  }
}

function matchesJobTitle(profileData, targetTitles) {
  if (!targetTitles || targetTitles.length === 0) return true;
  if (!profileData || !profileData.jobTitle) return false;
  
  const jobTitleLower = profileData.jobTitle.toLowerCase();
  const headlineLower = (profileData.headline || '').toLowerCase();
  
  for (const title of targetTitles) {
    const titleLower = title.toLowerCase().trim();
    if (jobTitleLower.includes(titleLower) || headlineLower.includes(titleLower)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract website URL from LinkedIn profile (Contact info, intro section, or first external link).
 * @param {Page} page - Playwright page on a profile
 * @returns {Promise<string|null>} - Normalized URL or null
 */
async function extractProfileWebsite(page) {
  try {
    const url = await page.evaluate(() => {
      const linkedinOrigin = 'linkedin.com';
      const skipHosts = ['linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com'];
      const isExternal = (href) => {
        if (!href || !href.startsWith('http')) return false;
        try {
          const host = new URL(href).hostname.toLowerCase();
          return !skipHosts.some(h => host.includes(h));
        } catch (e) { return false; }
      };
      // Prefer "Website" / "Personal website" / "Contact info" links
      const links = Array.from(document.querySelectorAll('a[href^="http"]'));
      for (const a of links) {
        const href = (a.getAttribute('href') || '').trim();
        const text = (a.innerText || a.textContent || '').trim().toLowerCase();
        if (isExternal(href) && href.length < 200) {
          if (/website|personal site|homepage|web site|link|contact|blog/.test(text) || text === href) return href;
        }
      }
      for (const a of links) {
        const href = (a.getAttribute('href') || '').trim();
        if (isExternal(href) && href.length < 200) return href;
      }
      return null;
    });
    if (!url || typeof url !== 'string') return null;
    let normalized = url.trim();
    if (!normalized.startsWith('http')) normalized = 'https://' + normalized;
    if (normalized.length > 5) return normalized;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Visit a website and its contact pages to extract business emails.
 * @param {Page} page - Playwright page
 * @param {string} websiteUrl - Base website URL
 * @param {Function} progressCallback - Optional progress
 * @returns {Promise<string|null>} - First business email found or null
 */
async function visitWebsiteContactPageForEmails(page, websiteUrl, progressCallback = () => {}) {
  if (!websiteUrl || !page) return null;
  let baseUrl = websiteUrl.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const sameOrigin = (u) => {
    try { return new URL(u).origin === new URL(baseUrl).origin; } catch (e) { return false; }
  };
  try {
    // 1) Load the site and find Contact us / Get in touch links on the page
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: CONTACT_PAGE_TIMEOUT_MS });
    await linkedinDelay('betweenPageVisits');
    const linkUrls = await getContactLinkUrlsFromPage(page, baseUrl, MAX_CONTACT_PAGES_TO_TRY);
    for (const contactUrl of linkUrls) {
      if (contactUrl === baseUrl) continue;
      try {
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: CONTACT_PAGE_TIMEOUT_MS });
        await linkedinDelay('betweenPageVisits');
        const content = await page.evaluate(() => ({
          text: document.body && (document.body.innerText || ''),
          html: document.body && (document.body.innerHTML || '')
        }));
        const emails = extractEmails(content.text || '', content.html || '');
        const business = filterBusinessEmails(emails);
        if (business.length > 0) return business[0];
      } catch (e) { continue; }
    }
    // 2) Fallback: try guessed contact paths
    const guessedUrls = getContactPageUrls(baseUrl).filter(sameOrigin).slice(0, MAX_CONTACT_PAGES_TO_TRY);
    for (const contactUrl of guessedUrls) {
      if (contactUrl === baseUrl) continue;
      try {
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: CONTACT_PAGE_TIMEOUT_MS });
        await linkedinDelay('betweenPageVisits');
        const content = await page.evaluate(() => ({
          text: document.body && (document.body.innerText || ''),
          html: document.body && (document.body.innerHTML || '')
        }));
        const emails = extractEmails(content.text || '', content.html || '');
        const business = filterBusinessEmails(emails);
        if (business.length > 0) return business[0];
      } catch (e) { continue; }
    }
    // 3) Fallback: homepage (already loaded in step 1, but re-extract in case we navigated away)
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: CONTACT_PAGE_TIMEOUT_MS });
      await linkedinDelay('betweenPageVisits');
      const content = await page.evaluate(() => ({
        text: document.body && (document.body.innerText || ''),
        html: document.body && (document.body.innerHTML || '')
      }));
      const emails = extractEmails(content.text || '', content.html || '');
      const business = filterBusinessEmails(emails);
      if (business.length > 0) return business[0];
    } catch (e) {}
  } catch (e) {}
  return null;
}

/** Strip job titles and legal suffixes so domain slug uses only the actual company name (e.g. "Bafukeng Minerals"). */
function companyNameForDomain(companyName) {
  if (!companyName || typeof companyName !== 'string') return '';
  let s = companyName.trim();
  // Remove (Pty) Ltd, Pty Ltd, etc.
  s = s.replace(/\s*\(?\s*[Pp]ty\s*\)?\s*[Ll][td][td]\.?\s*$/i, '').replace(/\s*[Pp]ty\s+[Ll][td][td]\.?\s*$/i, '').trim();
  // Take part after " at " or " - " or " | " (avoid "CFO at Bafukeng Minerals" -> use Bafukeng Minerals)
  const atIdx = s.toLowerCase().indexOf(' at ');
  if (atIdx >= 0) s = s.slice(atIdx + 4).trim();
  const dashIdx = s.indexOf(' - ');
  if (dashIdx >= 0) s = s.slice(dashIdx + 3).trim();
  const pipeIdx = s.indexOf(' | ');
  if (pipeIdx >= 0) s = s.slice(pipeIdx + 3).trim();
  // Drop leading single job-title word (CEO, CFO, Director, etc.) if followed by company name
  const jobPrefix = /^(cfo|ceo|cto|coo|cmo|director|manager|head|lead|founder|partner)\s+/i;
  if (jobPrefix.test(s)) s = s.replace(jobPrefix, '').trim();
  return s;
}

/**
 * Resolve company name to a valid mail domain (MX exists). Tries common TLDs and optional LinkedIn company page.
 * Uses company name only (no job title or Pty Ltd in slug).
 */
async function resolveCompanyDomain(companyName, page, progressCallback = () => {}) {
  if (!companyName || typeof companyName !== 'string') return null;
  const clean = companyNameForDomain(companyName);
  if (!clean) return null;
  const slug = clean.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (slug.length < 2) return null;
  const tlds = ['com', 'co.za', 'org', 'net', 'io', 'co.uk'];
  for (const tld of tlds) {
    const domain = tld.includes('.') ? `${slug}.${tld}` : `${slug}.${tld}`;
    try {
      const mx = await resolveMx(domain);
      if (mx && mx.length > 0) return domain;
    } catch (e) {
      continue;
    }
  }
  const short = clean.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (short && short.length >= 2 && short !== slug) {
    for (const tld of ['com', 'co.za', 'org']) {
      const domain = `${short}.${tld}`;
      try {
        const mx = await resolveMx(domain);
        if (mx && mx.length > 0) return domain;
      } catch (e) {
        continue;
      }
    }
  }
  return null;
}

/**
 * Search LinkedIn by keywords (people search) with optional filters and automatic Next-page pagination.
 * @param {Page} page - Playwright page instance
 * @param {string} keywords - Main search keywords
 * @param {number} maxProfiles - Maximum profiles to collect (100+ supported via pagination)
 * @param {Function} progressCallback - Progress callback
 * @param {Function} [checkCancellation] - Optional cancellation check
 * @param {string} [location] - Optional location filter (text)
 * @param {string} [jobTitle] - Optional job title filter (text)
 * @param {string} [company] - Optional company filter (text)
 * @param {string} [industry] - Optional industry filter (text)
 * @returns {Array<string>} - Array of profile URLs
 */
async function searchLinkedInByKeywords(page, keywords, maxProfiles, progressCallback, checkCancellation = null, location = null, jobTitle = null, company = null, industry = null) {
  // Build search query from keyword + optional filters (all as text for LinkedIn search)
  const parts = [keywords];
  if (location && typeof location === 'string' && location.trim()) parts.push(location.trim());
  if (jobTitle && typeof jobTitle === 'string' && jobTitle.trim()) parts.push(jobTitle.trim());
  if (company && typeof company === 'string' && company.trim()) parts.push(company.trim());
  if (industry && typeof industry === 'string' && industry.trim()) parts.push(industry.trim());
  const searchQuery = parts.join(' ');

  progressCallback({ status: `Searching LinkedIn for "${searchQuery}"...`, profilesFound: 0, profilesScraped: 0 });

  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`;
  console.log(`Searching LinkedIn with URL: ${searchUrl}`);
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await normalizeZoom(page);
  await page.waitForSelector('.search-results-container, .reusable-search__result-container, .entity-result, [data-chameleon-result-urn]', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  
  const profileUrls = [];
  let currentPageNum = 1;
  const maxPages = Math.min(250, Math.max(1, Math.ceil(maxProfiles / 10))); // 1000 profiles = 100 pages
  const INFINITE_SCROLL_ROUNDS = 60;   // when there's no Next button, scroll to load more (support 1000+)
  const NO_NEW_URLS_LIMIT = 6;          // stop infinite scroll after this many rounds with no new URLs

  async function extractUrlsFromPage() {
    return await safeEvaluate(page, () => {
      const urls = [];
      const seen = new Set();
      const selectors = [
        '.reusable-search__result-container a[href*="/in/"]',
        '.entity-result__item a[href*="/in/"]',
        '.entity-result a[href*="/in/"]',
        '.entity-result__title-text a[href*="/in/"]',
        '.base-search__result a[href*="/in/"]',
        'a[href*="/in/"]'
      ];
      for (const selector of selectors) {
        try {
          const links = document.querySelectorAll(selector);
          links.forEach(link => {
            if (link?.href && link.href.includes('/in/')) {
                const urlMatch = link.href.match(/\/in\/([^\/\?]+)/);
                if (urlMatch && urlMatch[1]) {
                  const profileId = urlMatch[1];
                if (profileId && !profileId.includes('search') && !profileId.includes('miniprofile') && !profileId.includes('pub') && profileId.length > 2) {
                  const cleanUrl = 'https://www.linkedin.com/in/' + profileId;
                    if (!seen.has(cleanUrl)) {
                      seen.add(cleanUrl);
                      urls.push(cleanUrl);
                    }
                  }
              }
            }
          });
        } catch (e) {}
      }
      return [...new Set(urls)];
    }, []);
  }

  /** Scroll results list and page all the way to the end so "Next" button is visible. */
  async function scrollToVeryBottom() {
    // Use real mouse wheel + keyboard so the page actually scrolls (evaluate-only often doesn't on LinkedIn)
    await scrollPageWithInput(page, { rounds: 35, wheelStep: 700, useKeyboard: true });
    await linkedinDelay('afterNav');
    // Also push any scrollable containers to bottom in case the main scroll is inside a div
    await page.evaluate(() => {
      const sel = '.scaffold-finite-scroll__content, .search-results-container, [role="main"]';
      document.querySelectorAll(sel).forEach(el => {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      });
      window.scrollTo(0, document.body.scrollHeight);
      const pagination = document.querySelector('.artdeco-pagination');
      if (pagination) pagination.scrollIntoView({ behavior: 'instant', block: 'end' });
    }).catch(() => {});
    await linkedinDelay('afterNav');
    await page.waitForTimeout(500).catch(() => {}); // allow Next button to render
  }

  while (profileUrls.length < maxProfiles && currentPageNum <= maxPages) {
    if (checkCancellation && checkCancellation()) break;

    progressCallback({
      status: `Collecting profiles (page ${currentPageNum}) — ${profileUrls.length} found...`,
      profilesFound: profileUrls.length,
      profilesScraped: 0
    });

    // Scroll to the very bottom first so LinkedIn shows the "Next" button if it exists
    await scrollToVeryBottom();

    let newUrls = await extractUrlsFromPage();
    if (Array.isArray(newUrls) === false) newUrls = [];
    let added = 0;
    for (const url of newUrls) {
      if (!profileUrls.includes(url)) {
        profileUrls.push(url);
        added++;
      }
    }
    console.log(`Page ${currentPageNum}: extracted ${newUrls.length} URLs, ${added} new, total: ${profileUrls.length}`);

    if (profileUrls.length >= maxProfiles) break;

    // Check for Next (same as Sales Nav extension: artdeco + link + text "next")
    let hasNext = await safeEvaluate(page, () => {
      const sel = 'button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"], a[aria-label="Next"], .artdeco-pagination button:last-of-type';
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      const buttons = document.querySelectorAll('button, a');
      for (let i = 0; i < buttons.length; i++) {
        const t = (buttons[i].innerText || buttons[i].textContent || '').trim().toLowerCase();
        if (t === 'next' || t === 'next page') return !buttons[i].disabled && buttons[i].getAttribute('aria-disabled') !== 'true';
      }
      return false;
    }, false);

    if (!hasNext) {
      await scrollPaginationIntoView(page);
      await page.waitForTimeout(600).catch(() => {});
      hasNext = await safeEvaluate(page, () => {
        const btn = document.querySelector('button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"], a[aria-label="Next"]');
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
        const all = document.querySelectorAll('button, a');
        for (let i = 0; i < all.length; i++) {
          const t = (all[i].innerText || all[i].textContent || '').trim().toLowerCase();
          if (t === 'next' || t === 'next page') return !all[i].disabled && all[i].getAttribute('aria-disabled') !== 'true';
        }
        return false;
      }, false);
    }

    if (hasNext) {
      const clicked = await clickNextButton(page);
      if (!clicked) break;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await linkedinDelay('afterNav');
      await normalizeZoom(page);
      await page.waitForTimeout(2000).catch(() => {}); // let next page start rendering
      const found = await page.waitForSelector('.entity-result, .reusable-search__result-container, .search-results-container, a[href*="/in/"]', { timeout: 25000 }).catch(() => null);
      if (!found) {
        const found2 = await page.waitForSelector('.scaffold-layout__list-container, [role="main"] a[href*="/in/"]', { timeout: 8000 }).catch(() => null);
        if (!found2) {
          console.log('Timeout waiting for new results after Next');
          break;
        }
      }
      currentPageNum++;
      continue;
    }

    // No Next button — use infinite scroll: scroll down repeatedly with real input, collect URLs after each batch
    console.log('No Next button; using infinite scroll to load more results.');
    let noNewCount = 0;
    for (let s = 0; s < INFINITE_SCROLL_ROUNDS && profileUrls.length < maxProfiles; s++) {
      if (checkCancellation && checkCancellation()) break;
      progressCallback({
        status: `Infinite scroll (${s + 1}/${INFINITE_SCROLL_ROUNDS}) — ${profileUrls.length} found...`,
        profilesFound: profileUrls.length,
        profilesScraped: 0
      });
      const beforeCount = profileUrls.length;
      await scrollPageWithInput(page, { rounds: 12, wheelStep: 500, useKeyboard: true });
      await page.evaluate(() => {
        const sel = '.scaffold-finite-scroll__content, .search-results-container, [role="main"]';
        document.querySelectorAll(sel).forEach(el => {
          if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        });
        window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});
      await linkedinDelay('scrollMed');
      await linkedinDelay('afterNav');
      newUrls = await extractUrlsFromPage();
      for (const url of newUrls) {
        if (!profileUrls.includes(url)) profileUrls.push(url);
      }
    if (profileUrls.length === beforeCount) {
      noNewCount++;
        if (noNewCount >= NO_NEW_URLS_LIMIT) {
          console.log(`No new URLs after ${NO_NEW_URLS_LIMIT} scrolls, stopping infinite scroll`);
          break;
        }
    } else {
      noNewCount = 0;
      }
      console.log(`Infinite scroll round ${s + 1}: total ${profileUrls.length} URLs`);
    }
    break; // after infinite scroll we're done (no pagination)
  }

  const finalUrls = profileUrls.slice(0, maxProfiles);
  console.log(`LinkedIn keyword search done: ${finalUrls.length} profile URLs (target: ${maxProfiles})`);
  return finalUrls;
}

// ————— Sales Navigator —————
const SALES_NAV_PEOPLE_SEARCH_BASE = 'https://www.linkedin.com/sales/search/people';

/**
 * Build Sales Navigator people search URL. Sales Nav uses UI filters; we pass keywords as query if supported.
 * @param {Object} params - { keywords, location, jobTitle, company, industry }
 * @returns {string} Full URL
 */
function buildSalesNavigatorSearchUrl(params) {
  const { keywords = '', location = '', jobTitle = '', company = '', industry = '' } = params || {};
  const url = new URL(SALES_NAV_PEOPLE_SEARCH_BASE);
  if (keywords && keywords.trim()) url.searchParams.set('keywords', keywords.trim());
  if (location && location.trim()) url.searchParams.set('geoIncluded', location.trim());
  if (jobTitle && jobTitle.trim()) url.searchParams.set('titleIncluded', jobTitle.trim());
  if (company && company.trim()) url.searchParams.set('currentCompany', company.trim());
  if (industry && industry.trim()) url.searchParams.set('industry', industry.trim());
  return url.toString();
}

/**
 * Check if we are on a Sales Navigator login/upgrade gate (need manual login).
 */
async function isSalesNavLoginRequired(page) {
  return await safeEvaluate(page, () => {
    const url = window.location.href.toLowerCase();
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/auth')) return true;
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    if (/log in to (view|access|use)|start (your )?free trial|upgrade to sales navigator/i.test(bodyText)) return true;
    return false;
  }, false);
}

/** Check if current page is login or CAPTCHA/challenge (user must complete manually). */
async function isLoginOrCaptchaPage(page) {
  return await safeEvaluate(page, () => {
    const url = (window.location.href || '').toLowerCase();
    if (url.includes('/login') || url.includes('/checkpoint') || url.includes('/auth') || url.includes('/challenge')) return true;
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    if (/captcha|verify you're human|security check|unusual activity|confirm it's you|log in|sign in/i.test(bodyText)) return true;
    return false;
  }, false);
}

/** When login or CAPTCHA is detected, wait up to 10 minutes for user to complete it in the browser. */
const LOGIN_CAPTCHA_WAIT_MS = 10 * 60 * 1000; // 10 minutes

async function waitForUserToCompleteLoginOrCaptcha(page, progressCallback) {
  progressCallback({
    status: 'Login or CAPTCHA detected — please complete it in the browser. Waiting up to 10 minutes...',
    profilesFound: 0,
    profilesScraped: 0
  });
  try {
    await page.waitForSelector(
      'h1, .pv-top-card, .text-heading-xlarge, .artdeco-entity-lockup__title, .feed-identity-module, .search-results-container, a[href*="/in/"], a[href*="/sales/lead/"], .global-nav__me-photo',
      { timeout: LOGIN_CAPTCHA_WAIT_MS }
    );
    progressCallback({ status: 'Resuming scrape...', profilesFound: 0, profilesScraped: 0 });
  } catch (e) {
    progressCallback({ status: 'Timeout waiting for login/CAPTCHA — continuing with next profile.', profilesFound: 0, profilesScraped: 0 });
  }
}

/**
 * Extract profile URLs from Sales Navigator people search result list.
 * Sales Nav often uses /sales/lead/ID links (not /in/); we collect both. Lead URLs open to profile view.
 */
async function extractSalesNavProfileUrlsFromPage(page) {
  return await safeEvaluate(page, () => {
    const urls = [];
    const seen = new Set();
    // Sales Navigator result list: links can be /in/username OR /sales/lead/ACwAAA... (lead ID)
    const links = document.querySelectorAll('a[href*="/in/"], a[href*="/sales/lead/"]');
    links.forEach(link => {
      const href = (link && link.href) ? link.href : '';
      if (!href || href.includes('/miniprofile/') || href.includes('/pub/')) return;
      if (href.includes('/in/')) {
        const match = href.match(/\/in\/([^\/\?]+)/);
        if (match && match[1]) {
          const slug = match[1];
          if (slug !== 'search' && slug.length > 2) {
            const clean = 'https://www.linkedin.com/in/' + slug;
            if (!seen.has(clean)) {
              seen.add(clean);
              urls.push(clean);
            }
          }
        }
      } else if (href.includes('/sales/lead/')) {
        const match = href.match(/\/sales\/lead\/([A-Za-z0-9_-]+)/);
        if (match && match[1]) {
          const leadId = match[1];
          if (leadId.length > 5) {
            const clean = 'https://www.linkedin.com/sales/lead/' + leadId.split('?')[0];
            if (!seen.has(clean)) {
              seen.add(clean);
              urls.push(clean);
            }
          }
        }
      }
    });
    return [...new Set(urls)];
  }, []);
}

/**
 * Search LinkedIn Sales Navigator people search: navigate to URL, optionally fill keyword, collect lead profile URLs with pagination.
 * @param {Page} page
 * @param {Object} filters - { keywords, location, jobTitle, company, industry }
 * @param {number} maxProfiles
 * @param {Function} progressCallback
 * @param {Function} [checkCancellation]
 * @returns {Promise<string[]>} Profile URLs
 */
async function searchSalesNavigator(page, filters, maxProfiles, progressCallback, checkCancellation = null) {
  const { keywords = '', location = '', jobTitle = '', company = '', industry = '' } = filters || {};
  const searchUrl = buildSalesNavigatorSearchUrl({ keywords, location, jobTitle, company, industry });
  progressCallback({ status: 'Opening Sales Navigator people search...', profilesFound: 0, profilesScraped: 0 });
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await normalizeZoom(page);
  await linkedinDelay('afterNav');

  const loginRequired = await isSalesNavLoginRequired(page);
  if (loginRequired) {
    progressCallback({ status: 'Please log in to Sales Navigator in the browser window...', profilesFound: 0, profilesScraped: 0 });
    await page.waitForSelector(
      '.search-results-container, .scaffold-layout__list-container, .artdeco-entity-lockup, a[href*="/in/"], a[href*="/sales/lead/"], [data-chameleon-result-urn]',
      { timeout: 300000 }
    ).catch(() => {});
    const stillLogin = await isSalesNavLoginRequired(page);
    if (stillLogin) throw new Error('Sales Navigator login required. Please log in in the browser and try again.');
    progressCallback({ status: 'Sales Navigator ready.', profilesFound: 0, profilesScraped: 0 });
  }

  // Wait for result links (Sales Nav often uses /sales/lead/ IDs, not /in/)
  await page.waitForSelector('a[href*="/in/"], a[href*="/sales/lead/"], .search-results-container, .scaffold-layout__list-container, [data-chameleon-result-urn]', { timeout: 25000 }).catch(() => {});
  await linkedinDelay('afterNav');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // If no results yet, Sales Nav may need search to be run from the page (URL params often ignored)
  let firstExtract = await extractSalesNavProfileUrlsFromPage(page);
  if (!Array.isArray(firstExtract)) firstExtract = [];
  if (firstExtract.length === 0 && keywords && keywords.trim()) {
    progressCallback({ status: 'Running Sales Navigator search from page...', profilesFound: 0, profilesScraped: 0 });
    const searchRan = await page.evaluate((kw) => {
      const input = document.querySelector('input[placeholder*="Keyword"], input[placeholder*="Search"], input[type="search"], input[name*="keyword"]') || document.querySelector('.search-global-typeahead__input') || document.querySelector('input[aria-label*="Search"]');
      if (input) {
        input.focus();
        input.value = kw;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const form = input.closest('form');
        if (form) form.submit();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        return true;
      }
      return false;
    }, keywords.trim()).catch(() => false);
    if (searchRan) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await linkedinDelay('afterNav');
      await page.waitForSelector('a[href*="/in/"], a[href*="/sales/lead/"]', { timeout: 20000 }).catch(() => {});
    }
  }

  const profileUrls = [];
  let currentPageNum = 1;
  const maxPages = Math.min(250, Math.max(1, Math.ceil(maxProfiles / 10)));
  const INFINITE_SCROLL_ROUNDS = 60;
  const NO_NEW_URLS_LIMIT = 6;

  async function scrollToBottomSalesNav() {
    await scrollPageWithInput(page, { rounds: 35, wheelStep: 700, useKeyboard: true });
    await page.evaluate(() => {
      const sel = '.scaffold-finite-scroll__content, .scaffold-layout__list-container, .search-results-container, [role="main"]';
      document.querySelectorAll(sel).forEach(el => {
        if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
      });
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelector('.artdeco-pagination')?.scrollIntoView({ behavior: 'instant', block: 'end' });
    }).catch(() => {});
    await linkedinDelay('afterNav');
    await page.waitForTimeout(500).catch(() => {});
  }

  while (profileUrls.length < maxProfiles && currentPageNum <= maxPages) {
    if (checkCancellation && checkCancellation()) break;
    progressCallback({
      status: `Sales Navigator: collecting profiles (page ${currentPageNum}) — ${profileUrls.length} found...`,
      profilesFound: profileUrls.length,
      profilesScraped: 0
    });
    await scrollToBottomSalesNav();
    let newUrls = await extractSalesNavProfileUrlsFromPage(page);
    if (!Array.isArray(newUrls)) newUrls = [];
    let added = 0;
    for (const url of newUrls) {
      if (!profileUrls.includes(url)) {
        profileUrls.push(url);
        added++;
      }
    }
    console.log(`Sales Nav page ${currentPageNum}: ${newUrls.length} URLs, ${added} new, total: ${profileUrls.length}`);

    if (profileUrls.length >= maxProfiles) break;

    let hasNext = await safeEvaluate(page, () => {
      const sel = 'button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"], a[aria-label="Next"], .artdeco-pagination button:last-of-type';
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      const buttons = document.querySelectorAll('button, a');
      for (let i = 0; i < buttons.length; i++) {
        const t = (buttons[i].innerText || buttons[i].textContent || '').trim().toLowerCase();
        if (t === 'next' || t === 'next page') return !buttons[i].disabled && buttons[i].getAttribute('aria-disabled') !== 'true';
      }
      return false;
    }, false);
    if (!hasNext) {
      await scrollPaginationIntoView(page);
      await page.waitForTimeout(600).catch(() => {});
      hasNext = await safeEvaluate(page, () => {
        const btn = document.querySelector('button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"], a[aria-label="Next"]');
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
        const all = document.querySelectorAll('button, a');
        for (let i = 0; i < all.length; i++) {
          const t = (all[i].innerText || all[i].textContent || '').trim().toLowerCase();
          if (t === 'next' || t === 'next page') return !all[i].disabled && all[i].getAttribute('aria-disabled') !== 'true';
        }
        return false;
      }, false);
    }

    if (hasNext) {
      const clicked = await clickNextButton(page);
      if (!clicked) break;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await linkedinDelay('afterNav');
      await normalizeZoom(page);
      await page.waitForTimeout(2000).catch(() => {}); // let next page start rendering
      const found = await page.waitForSelector('.entity-result, .artdeco-entity-lockup, .search-results-container, a[href*="/in/"], a[href*="/sales/lead/"]', { timeout: 25000 }).catch(() => null);
      if (!found) {
        const found2 = await page.waitForSelector('.scaffold-layout__list-container, [role="main"] a[href*="/in/"], [role="main"] a[href*="/sales/lead/"]', { timeout: 8000 }).catch(() => null);
        if (!found2) {
          console.log('Sales Nav: timeout waiting for results after Next');
          break;
        }
      }
      currentPageNum++;
      continue;
    }

    let noNewCount = 0;
    for (let s = 0; s < INFINITE_SCROLL_ROUNDS && profileUrls.length < maxProfiles; s++) {
      if (checkCancellation && checkCancellation()) break;
      progressCallback({
        status: `Sales Navigator: infinite scroll (${s + 1}/${INFINITE_SCROLL_ROUNDS}) — ${profileUrls.length} found...`,
        profilesFound: profileUrls.length,
        profilesScraped: 0
      });
      const beforeCount = profileUrls.length;
      await scrollPageWithInput(page, { rounds: 12, wheelStep: 500, useKeyboard: true });
      await page.evaluate(() => {
        const sel = '.scaffold-finite-scroll__content, .scaffold-layout__list-container, .search-results-container, [role="main"]';
        document.querySelectorAll(sel).forEach(el => {
          if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        });
        window.scrollTo(0, document.body.scrollHeight);
      }).catch(() => {});
      await linkedinDelay('scrollMed');
      await linkedinDelay('afterNav');
      newUrls = await extractSalesNavProfileUrlsFromPage(page);
      if (!Array.isArray(newUrls)) newUrls = [];
      for (const url of newUrls) {
        if (!profileUrls.includes(url)) profileUrls.push(url);
      }
      if (profileUrls.length === beforeCount) {
        noNewCount++;
        if (noNewCount >= NO_NEW_URLS_LIMIT) break;
      } else noNewCount = 0;
    }
    break;
  }

  const final = profileUrls.slice(0, maxProfiles);
  console.log(`Sales Navigator search done: ${final.length} profile URLs (target: ${maxProfiles})`);
  return final;
}

async function goToCompanyPeoplePage(page, companyName, progressCallback) {
  progressCallback({ status: `Searching for ${companyName}...`, profilesFound: 0, profilesScraped: 0 });
  
  const searchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  await page.waitForSelector('.search-results-container', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); // Smart wait instead of fixed delay
  
  const allHrefs = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/company/"]'));
    return links.map(a => a.href).filter(href => 
      href.includes('/company/') && 
      !href.includes('/company/search') &&
      !href.includes('company-pages')
    );
  });
  
  if (allHrefs.length === 0) {
    throw new Error(`Could not find "${companyName}" on LinkedIn`);
  }
  
  const companyUrl = allHrefs[0].split('?')[0];
  const slugMatch = companyUrl.match(/\/company\/([^/]+)/);
  if (!slugMatch) throw new Error(`Could not parse company URL`);
  
  // Try to extract emails from company About page first
  const aboutPageUrl = `https://www.linkedin.com/company/${slugMatch[1]}/about/`;
  try {
    progressCallback({ status: `Checking ${companyName} company page for emails...`, profilesFound: 0, profilesScraped: 0 });
    await page.goto(aboutPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await linkedinDelay('afterNav');
    
    // Extract emails from company page
    const companyPageContent = await page.evaluate(() => {
      return {
        text: document.body.innerText || '',
        html: document.body.innerHTML || ''
      };
    });
    
    // This will be used later to merge with profile data
    const companyEmails = extractEmails(companyPageContent.text, companyPageContent.html);
    const businessEmails = filterBusinessEmails(companyEmails);
    
    // Store company emails for later use
    page.companyEmails = businessEmails;
  } catch (error) {
    console.log('Could not access company About page:', error.message);
    page.companyEmails = [];
  }
  
  const peoplePageUrl = `https://www.linkedin.com/company/${slugMatch[1]}/people/`;
  progressCallback({ status: `Going to ${companyName} employees page...`, profilesFound: 0, profilesScraped: 0 });
  
  // Use domcontentloaded so we don't wait for LinkedIn's endless network activity (networkidle often times out)
  await page.goto(peoplePageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.org-people-profile-card, .scaffold-finite-scroll__content, [data-chameleon-result-urn]', { timeout: 20000 }).catch(() => {});
  
  return slugMatch[1];
}

async function collectProfilesFromPeoplePage(page, maxProfiles, progressCallback, checkCancellation = null) {
  const profileUrls = [];
  let scrollAttempts = 0;
  let noNewCount = 0;
  
  await page.waitForSelector('.org-people-profile-card, .scaffold-finite-scroll__content', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); // Smart wait
  
  while (profileUrls.length < maxProfiles && scrollAttempts < 150 && noNewCount < 6) {
    // Check for cancellation
    if (checkCancellation && checkCancellation()) {
      break;
    }
    
    progressCallback({ 
      status: `Collecting profiles (${profileUrls.length} found)...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    // Scroll in smaller increments for more natural behavior
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await linkedinDelay('scrollShort');
    }
    await linkedinDelay('scrollMed');
    
    const beforeCount = profileUrls.length;
    const newUrls = await page.evaluate(() => {
      const urls = [];
      const cards = document.querySelectorAll('.org-people-profile-card, .scaffold-finite-scroll__content .artdeco-entity-lockup');
      cards.forEach(card => {
        const link = card.querySelector('a[href*="/in/"]');
        if (link?.href?.includes('/in/')) {
          const cleanUrl = link.href.split('?')[0];
          if (!urls.includes(cleanUrl) && !cleanUrl.includes('/miniprofile/')) {
            urls.push(cleanUrl);
          }
        }
      });
      return urls;
    });
    
    for (const url of newUrls) {
      if (!profileUrls.includes(url)) profileUrls.push(url);
    }
    
    if (profileUrls.length === beforeCount) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }
    scrollAttempts++;
  }
  
  return profileUrls.slice(0, maxProfiles);
}

/**
 * @param {Object} config - { searchMode, companyName, companyDomain, maxProfiles, jobTitles, industry, keywords, location }
 * @param {Function} progressCallback - Progress callback (counts/phase only)
 * @param {Object} options - { checkCancellation, stopMode: 'slow'|'fast' }
 */
async function runLinkedInScraper(config, progressCallback, options = {}) {
  const { searchMode = 'keyword', companyName = '', companyDomain = '', maxProfiles = 20, jobTitles = null, industry = null, keywords = null, location = null, jobTitle = null, company = null } = config || {};
  const checkCancellation = options.checkCancellation || (() => false);
  const fastStop = options.stopMode === 'fast';
  const jobTitlesToFilter = (jobTitles && jobTitles.length) ? jobTitles : (jobTitle ? [jobTitle] : []);
  const scrapedProfiles = [];
  let browser;
  let profileLoopStartTime = null; // for ETA (slow stop)
  let cancelledEarly = false;
  
  try {
    progressCallback({ status: 'Launching browser...', profilesFound: 0, profilesScraped: 0 });
    
    // Use launchBrowser helper which handles bundled browser path
    browser = await launchBrowser({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--force-device-scale-factor=1',
        '--high-dpi-support=1'
      ]
    });
    
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    
    progressCallback({ status: 'Opening LinkedIn...', profilesFound: 0, profilesScraped: 0 });
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 60000 });
    await normalizeZoom(page);
    // No extra delay needed
    
    // Check if logged in
    const isLoggedIn = await page.evaluate(() => {
      return !window.location.href.includes('/login') && 
             (document.querySelector('.global-nav__me-photo') || 
              document.querySelector('.feed-identity-module') ||
              document.querySelector('.search-global-typeahead'));
    });
    
    if (!isLoggedIn) {
      progressCallback({ status: 'Please log in to LinkedIn in the browser window...', profilesFound: 0, profilesScraped: 0 });
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.global-nav__me-photo, .feed-identity-module, .search-global-typeahead', { timeout: 300000 });
      progressCallback({ status: 'Login successful!', profilesFound: 0, profilesScraped: 0 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); // Smart wait
      await normalizeZoom(page);
    }
    
    // User target = number of contacts WITH email/contact details we want.
    // Fetch a pool of profiles (batch size × 10, capped) so we can keep scraping until we hit that target.
    const targetEmailCount = maxProfiles;
    const batchSize = Math.min(Math.max(maxProfiles, 1), 2000);
    const urlPoolSize = Math.min(batchSize * 10, 2000);
    
    let profileUrls = [];
    
    if (searchMode === 'salesNavigator') {
      profileUrls = await searchSalesNavigator(
        page,
        { keywords: keywords || '', location: location || '', jobTitle: jobTitle || '', company: company || '', industry: industry || '' },
        urlPoolSize,
        progressCallback,
        checkCancellation
      );
      if (profileUrls.length === 0) {
        throw new Error('No profiles found in Sales Navigator. Try different keywords/filters or ensure you are logged into Sales Navigator.');
      }
    } else if (searchMode === 'keyword' && keywords) {
      profileUrls = await searchLinkedInByKeywords(page, keywords, urlPoolSize, progressCallback, checkCancellation, location, jobTitle, company, industry);
      
      if (profileUrls.length === 0) {
        throw new Error(`No profiles found matching "${keywords}". Try:\n- Using different keywords\n- Removing location (e.g., just "software engineer")\n- Using company name instead\n- Checking if you're logged into LinkedIn`);
      }
    } else {
      await goToCompanyPeoplePage(page, companyName, progressCallback);
      profileUrls = await collectProfilesFromPeoplePage(page, urlPoolSize, progressCallback, checkCancellation);
      
      if (profileUrls.length === 0) {
        throw new Error(`No profiles found on company page for "${companyName}". The company may not have public employee listings on LinkedIn.`);
      }
    }
    
    progressCallback({ 
      status: `Scraping up to ${profileUrls.length} profiles until we have ${targetEmailCount} contacts with email...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    profileLoopStartTime = Date.now();
    for (let i = 0; i < profileUrls.length && scrapedProfiles.length < targetEmailCount; i++) {
      // Check for cancellation before each profile
      if (checkCancellation && checkCancellation()) {
        cancelledEarly = true;
        progressCallback({ 
          status: fastStop ? 'Fast stop — saving without emails or profiles' : 'Scraping cancelled by user', 
          profilesFound: profileUrls.length, 
          profilesScraped: scrapedProfiles.length,
          cancelled: true
        });
        break;
      }
      
      const remaining = profileUrls.length - i;
      let estimatedSecondsRemaining = null;
      if (profileLoopStartTime && i > 0 && remaining > 0) {
        const elapsed = Date.now() - profileLoopStartTime;
        const avgMsPerProfile = elapsed / i;
        estimatedSecondsRemaining = Math.round((remaining * avgMsPerProfile) / 1000);
      }
      progressCallback({ 
        status: `Scraping profile ${i + 1}/${profileUrls.length} — ${scrapedProfiles.length}/${targetEmailCount} contacts with email so far`, 
        profilesFound: profileUrls.length, 
        profilesScraped: scrapedProfiles.length,
        ...(estimatedSecondsRemaining != null && { estimatedSecondsRemaining })
      });
      
      try {
        let profilePageUrl = profileUrls[i];
        await page.goto(profilePageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await linkedinDelay('afterNav');
        // If login or CAPTCHA appeared, wait up to 10 minutes for user to complete it in the browser
        const onLoginOrCaptcha = await isLoginOrCaptchaPage(page);
        if (onLoginOrCaptcha) {
          await waitForUserToCompleteLoginOrCaptcha(page, progressCallback);
          await page.goto(profilePageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await linkedinDelay('afterNav');
        }
        // If this was a Sales Nav lead URL, try to open the standard /in/ profile for consistent extraction
        if (profilePageUrl.includes('/sales/lead/')) {
          await page.waitForSelector('a[href*="/in/"], h1, .artdeco-entity-lockup__title', { timeout: 8000 }).catch(() => {});
          const inUrl = await page.evaluate(() => {
            const links = document.querySelectorAll('a[href*="/in/"]');
            for (const a of links) {
              if (a.href && a.href.includes('/in/')) {
                const m = a.href.match(/\/in\/([^\/\?]+)/);
                if (m && m[1] && m[1].length > 2 && !m[1].includes('search')) return 'https://www.linkedin.com/in/' + m[1];
              }
            }
            return null;
          }).catch(() => null);
          if (inUrl) {
            await page.goto(inUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            profilePageUrl = inUrl;
          }
        }
        await page.waitForSelector('h1, .pv-top-card, .text-heading-xlarge, .artdeco-entity-lockup__title', { timeout: 15000 }).catch(() => {});

        let profileData = await extractProfileData(page);
        // Sales Nav lead view: standard profile selectors may not exist; try lead-page extraction
        let onSalesLeadPage = profilePageUrl.includes('/sales/lead/');
        if (!onSalesLeadPage) { try { onSalesLeadPage = page.url().includes('/sales/lead/'); } catch (_) {} }
        if ((!profileData || !profileData.fullName) && onSalesLeadPage) {
          // Diagnostic: log DOM structure on first Sales Nav lead so we can tune selectors
          if (i === 0) {
            try {
              const domDiscovery = await discoverSalesNavLeadDOM(page);
              console.log('[Sales Nav DOM] First lead page discovery:', JSON.stringify(domDiscovery, null, 2));
            } catch (e) { console.log('[Sales Nav DOM] Discovery error:', e.message); }
          }
          const leadData = await extractProfileDataFromSalesLeadPage(page);
          if (leadData) {
            if (i === 0) console.log('[Sales Nav DOM] First lead extracted:', leadData);
            if (leadData.fullName) profileData = leadData;
          }
        }
        // Fallback: use page title (e.g. "FirstName LastName | LinkedIn") — but never generic Sales Nav text
        if (!profileData || !profileData.fullName) {
          const title = await page.title().catch(() => '');
          const nameFromTitle = title.replace(/\s*[\|\-–—]\s*LinkedIn.*$/i, '').trim();
          if (nameFromTitle && nameFromTitle.length > 1 && nameFromTitle.length < 80 && !isGenericSalesNavOrLinkedInName(nameFromTitle)) {
            profileData = profileData || {};
            profileData.fullName = nameFromTitle;
            if (!profileData.headline) profileData.headline = '';
            if (!profileData.jobTitle) profileData.jobTitle = '';
            if (!profileData.company) profileData.company = '';
            if (!profileData.location) profileData.location = '';
          }
        }
        
        // For keyword/salesNavigator searches, try to extract company from profile if not provided
        if ((searchMode === 'keyword' || searchMode === 'salesNavigator') && !companyDomain && profileData?.company) {
          // Fallback handled below via inferredDomain
        }
        
        if (profileData?.fullName) {
          // Check job title filter (company mode: jobTitles array; keyword/salesNav: jobTitle string)
          if (jobTitlesToFilter.length > 0 && !matchesJobTitle(profileData, jobTitlesToFilter)) {
            progressCallback({ 
              status: `Skipping (title mismatch): ${profileData.fullName}`, 
              profilesFound: profileUrls.length, 
              profilesScraped: scrapedProfiles.length 
            });
            continue;
          }
          
          const nameParts = profileData.fullName.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          // Try to extract actual emails from profile page
          let profilePageContent = { text: '', html: '' };
          try {
            profilePageContent = await page.evaluate(() => ({
              text: document.body.innerText || '',
              html: document.body.innerHTML || ''
            }));
          } catch (_) {}
          
          const profileEmails = extractEmails(profilePageContent.text, profilePageContent.html);
          const businessEmails = filterBusinessEmails(profileEmails);
          
          let primaryEmail = businessEmails.length > 0 ? businessEmails[0] : null;
          
          // If no email on profile: try website → Contact Us (or equivalent) to extract contact details
          if (!primaryEmail) {
            const profileWebsite = await extractProfileWebsite(page);
            if (profileWebsite) {
              progressCallback({ status: `No email on profile — checking website: ${profileData.fullName}`, profilesFound: profileUrls.length, profilesScraped: scrapedProfiles.length });
              primaryEmail = await visitWebsiteContactPageForEmails(page, profileWebsite, progressCallback);
              if (primaryEmail) {
                progressCallback({ status: `Found email via contact page: ${profileData.fullName}`, profilesFound: profileUrls.length, profilesScraped: scrapedProfiles.length });
              }
              // Return to LinkedIn for next profile (we left to visit the website)
              try {
                await page.goto(profilePageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await linkedinDelay('afterNav');
              } catch (e) {
                console.log('Could not return to profile after website visit:', e.message);
              }
            }
          }
          
          // If still no email: resolve company domain, generate likely emails, verify which are valid
          if (!primaryEmail && profileData?.company) {
            progressCallback({ status: `Resolving company domain & verifying emails: ${profileData.fullName}`, profilesFound: profileUrls.length, profilesScraped: scrapedProfiles.length });
            const resolvedDomain = await resolveCompanyDomain(profileData.company, page, progressCallback);
            if (resolvedDomain) {
              const emailVariations = generateEmails(firstName, lastName, resolvedDomain);
              for (let v = 0; v < Math.min(emailVariations.length, MAX_GENERATED_EMAILS_TO_VERIFY); v++) {
                const candidate = emailVariations[v];
                const result = await verifyEmailMxSyntax(candidate);
                if (result.isValid === true) {
                  primaryEmail = candidate;
                  progressCallback({ status: `Verified generated email: ${profileData.fullName}`, profilesFound: profileUrls.length, profilesScraped: scrapedProfiles.length });
                  break;
                }
              }
            }
          }
          
          // Legacy: use company domain from config or inferred for generation (no verification)
          let finalCompanyDomain = companyDomain;
          if ((searchMode === 'keyword' || searchMode === 'salesNavigator') && profileData?.company && !finalCompanyDomain) {
            const forDomain = companyNameForDomain(profileData.company);
            if (forDomain) {
              const inferredDomain = forDomain.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '') + '.com';
              finalCompanyDomain = inferredDomain;
            }
          }
          if ((searchMode === 'keyword' || searchMode === 'salesNavigator') && !finalCompanyDomain && primaryEmail) {
            finalCompanyDomain = extractDomain(primaryEmail);
          }
          
          if (!primaryEmail && finalCompanyDomain) {
            const emailVariations = generateEmails(firstName, lastName, finalCompanyDomain);
            primaryEmail = emailVariations[0] || '';
          }
          
          // Filter by location if provided (company mode only; keyword/salesNav use search filters)
          if (location && typeof location === 'string' && location.trim() && searchMode === 'company') {
            const profileLocation = profileData.location?.toLowerCase() || '';
            const searchLocation = location.trim().toLowerCase();
            
            // Check if location matches (partial match is OK)
            if (profileLocation && !profileLocation.includes(searchLocation)) {
              progressCallback({ 
                status: `Skipping (location mismatch): ${profileData.fullName} - ${profileData.location}`, 
                profilesFound: profileUrls.length, 
                profilesScraped: scrapedProfiles.length 
              });
              continue;
            }
          }
          
          // Only save contact if we have an email (from profile, website, or guessed/verified from company)
          const validEmail = primaryEmail && !isPersonalEmail(primaryEmail) ? primaryEmail : null;
          if (!validEmail) {
            if (firstName || lastName) {
              console.log(`Skipping profile ${i + 1} (${firstName || ''} ${lastName || ''}): no email and could not guess one`);
            }
            // Don't add to database when there's no email
          } else if (firstName || lastName) {
            // Build search query for this contact
            let searchQueryForContact = '';
            if (searchMode === 'keyword' && keywords) {
              searchQueryForContact = location && typeof location === 'string' && location.trim() 
                ? `${keywords} ${location.trim()}` 
                : keywords;
            } else if (searchMode === 'salesNavigator') {
              searchQueryForContact = [keywords, location, jobTitle, company, industry].filter(Boolean).join(' ').trim() || 'Sales Navigator';
            } else if (searchMode === 'company' && companyName) {
              searchQueryForContact = companyName;
            }
            const contactSource = searchMode === 'salesNavigator' ? 'linkedin_sales_navigator' : 'linkedin';
            
            scrapedProfiles.push({
              first_name: truncateField(firstName, 100),
              last_name: truncateField(lastName, 100),
              email: validEmail,
              company: truncateField(profileData.company || companyName || 'Unknown', 100),
              job_title: truncateField(profileData.jobTitle, 100),
              location: truncateField(profileData.location, 100),
              email_domain: truncateField(extractDomain(validEmail), 100),
              source: contactSource,
              email_verified: false,
              verification_status: 'unverified',
              industry: truncateField(industry, 100),
              keywords: truncateField(keywords, 100),
              linkedin_url: profilePageUrl || profileUrls[i],
              search_query: truncateField(searchQueryForContact, 200)
            });
          } else {
            console.log(`Skipping profile ${i + 1}: No name found`);
          }
        } else if ((searchMode === 'salesNavigator' || (profileUrls[i] && profileUrls[i].includes('/sales/lead/'))) && (profilePageUrl || profileUrls[i])) {
          // Sales Nav / lead URL but no email: skip (do not add null-email contacts)
        }
      } catch (error) {
        console.log(`Error scraping profile ${i + 1}: ${error.message}`);
        // Do not add null-email contacts; skip failed extractions
      }
      // Do not add fallback null-email leads; only contacts with email are saved
      
      await linkedinDelay('betweenProfiles');
    }
    
    // Only contacts with email are returned (unless fast stop: then minimal records, no email/url)
    
    // Return contacts; main/runner handles Supabase. No contact arrays over IPC.
      let profilesToDedupe = scrapedProfiles;
      if (cancelledEarly && fastStop) {
        profilesToDedupe = scrapedProfiles.map(p => ({
          ...p,
          email: null,
          linkedin_url: null
        }));
      }
      const uniqueProfiles = [];
      const seenEmails = new Set();
      const seenUrls = new Set();
      const seenKeys = new Set();
      for (const profile of profilesToDedupe) {
        if (profile.email) {
          if (!seenEmails.has(profile.email.toLowerCase())) {
            seenEmails.add(profile.email.toLowerCase());
            uniqueProfiles.push(profile);
          }
        } else if (profile.linkedin_url) {
          if (!seenUrls.has(profile.linkedin_url)) {
            seenUrls.add(profile.linkedin_url);
            uniqueProfiles.push(profile);
          }
        } else {
          const key = `${profile.first_name}_${profile.last_name}_${profile.company}`.toLowerCase();
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueProfiles.push(profile);
          }
        }
      }
    progressCallback({ status: `Complete! ${uniqueProfiles.length} contacts.`, profilesFound: profileUrls.length, profilesScraped: uniqueProfiles.length, completed: true });
    await linkedinDelay('final');
    await browser.close();
    return uniqueProfiles;
    
  } catch (error) {
    progressCallback({ 
      status: `Error: ${error.message}`, 
      profilesFound: 0, 
      profilesScraped: scrapedProfiles.length,
      error: true
    });
    if (browser) await browser.close();
    throw error;
  }
}

module.exports = { runLinkedInScraper };