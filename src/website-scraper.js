/**
 * Website scraper — one job config; returns contacts; no Supabase.
 * Job boundaries: one browser per job; browser closed after job. Cancellation checks between sites.
 * IPC progress: only counts/phase via progressCallback; no contact arrays or Playwright refs.
 */

const { launchBrowser } = require('./browser-helper');
const { extractEmails, extractMailtoEmails, filterBusinessEmails, getBestEmail, extractCompanyName } = require('./email-extractor');
const { websiteDelay } = require('./cooldown-config');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');

// Helper function to truncate strings to database column limits
function truncateField(value, maxLength = 100) {
  if (!value || typeof value !== 'string') return value;
  return value.length > maxLength ? value.substring(0, maxLength) : value;
}

/**
 * Fetch and parse a single sitemap XML; returns either page URLs or child sitemap URLs (for index).
 * @param {string} sitemapUrl - URL to sitemap
 * @returns {Promise<{ type: 'urlset', urls: string[] } | { type: 'sitemapindex', sitemaps: string[] }>}
 */
function fetchSitemapOnce(sitemapUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(sitemapUrl);
    const client = url.protocol === 'https:' ? https : http;
    client.get(sitemapUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          parseString(data, (err, result) => {
            if (err) {
              reject(err);
              return;
            }
            if (result.sitemapindex && result.sitemapindex.sitemap) {
              const sitemaps = result.sitemapindex.sitemap.map(s => s.loc && s.loc[0]).filter(Boolean);
              resolve({ type: 'sitemapindex', sitemaps });
              return;
            }
            if (result.urlset && result.urlset.url) {
              const urls = (result.urlset.url || [])
                .map(u => u.loc && u.loc[0])
                .filter(Boolean);
              resolve({ type: 'urlset', urls });
              return;
            }
            resolve({ type: 'urlset', urls: [] });
          });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

const SITEMAP_INDEX_MAX_DEPTH = 5;

/**
 * Fetch all page URLs from an XML sitemap (or sitemap index). Follows all child sitemaps.
 * @param {string} sitemapUrl - URL to sitemap or sitemap index
 * @param {number} depth - Current recursion depth (internal)
 * @returns {Promise<string[]>} - Flat array of page URLs
 */
async function fetchAllUrlsFromSitemap(sitemapUrl, depth = 0) {
  if (depth >= SITEMAP_INDEX_MAX_DEPTH) return [];
  const result = await fetchSitemapOnce(sitemapUrl);
  if (result.type === 'urlset') {
    return result.urls;
  }
  const all = [];
  for (const childUrl of result.sitemaps) {
    try {
      const childUrls = await fetchAllUrlsFromSitemap(childUrl, depth + 1);
      all.push(...childUrls);
    } catch (e) {
      console.log(`Skipping child sitemap ${childUrl}: ${e.message}`);
    }
  }
  return all;
}

/**
 * Find XML sitemap URL(s) for a website (can return multiple from robots.txt).
 * @param {string} baseUrl - Base website URL
 * @returns {Promise<string[]|null>} - Array of sitemap URLs, or null if none found
 */
async function findSitemaps(baseUrl) {
  const commonSitemapPaths = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/sitemap1.xml',
    '/sitemap_1.xml',
    '/sitemap.txt'
  ];

  try {
    const url = new URL(baseUrl);
    const base = `${url.protocol}//${url.host}`;

    for (const path of commonSitemapPaths) {
      try {
        const sitemapUrl = base + path;
        await new Promise((resolve, reject) => {
          const client = url.protocol === 'https:' ? https : http;
          const req = client.get(sitemapUrl, (res) => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Status ${res.statusCode}`));
          });
          req.on('error', reject);
          req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
        return [sitemapUrl];
      } catch (e) {
        // continue
      }
    }

    const robotsUrl = base + '/robots.txt';
    try {
      const robotsContent = await new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(robotsUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
      const lines = robotsContent.split(/\r?\n/).map(l => l.trim());
      const sitemaps = lines
        .filter(l => /^sitemap:\s+/i.test(l))
        .map(l => l.replace(/^sitemap:\s+/i, '').trim())
        .filter(Boolean);
      if (sitemaps.length) return sitemaps;
    } catch (e) {
      // robots not found or error
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Fetch page URLs from an HTML sitemap (page that lists links).
 * @param {string} baseUrl - Base website URL (e.g. https://example.com)
 * @returns {Promise<string[]>} - Array of same-domain page URLs found on HTML sitemap
 */
async function fetchUrlsFromHtmlSitemap(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const tryPaths = [
    '/sitemap.html',
    '/sitemap/',
    '/sitemap/index.html',
    '/page-sitemap.html',
    '/html-sitemap.html',
    '/sitemap_index.html'
  ];
  let html = '';
  let resolvedBase = base;
  try {
    const url = new URL(baseUrl);
    resolvedBase = `${url.protocol}//${url.host}`;
  } catch (e) {
    return [];
  }
  const client = resolvedBase.startsWith('https') ? https : http;

  for (const path of tryPaths) {
    try {
      const sitemapUrl = resolvedBase + path;
      html = await new Promise((resolve, reject) => {
        const req = client.get(sitemapUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Status ${res.statusCode}`));
            return;
          }
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
      break;
    } catch (e) {
      html = '';
    }
  }
  if (!html) return [];

  const baseHost = new URL(resolvedBase).hostname.replace(/^www\./, '');
  const urls = [];
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRegex.exec(html)) !== null) {
    let u = m[1].trim();
    if (!u || u.startsWith('#') || u.startsWith('mailto:') || u.startsWith('tel:')) continue;
    try {
      if (u.startsWith('/')) u = resolvedBase + u;
      else if (!u.startsWith('http')) u = resolvedBase + '/' + u;
      const parsed = new URL(u);
      const host = parsed.hostname.replace(/^www\./, '');
      if (host === baseHost) urls.push(parsed.href.split('?')[0].replace(/\/$/, ''));
    } catch (e) {}
  }
  return [...new Set(urls)];
}

function extractPhoneNumbers(text) {
  if (!text) return [];
  
  const patterns = [
    /\+27[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /0\d{2}[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /0[6-8]\d[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/g
  ];
  
  const allMatches = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    allMatches.push(...matches);
  }
  
  const cleaned = allMatches
    .map(p => p.replace(/[\s.-]/g, ''))
    .filter(p => {
      const digits = p.replace(/\D/g, '');
      return digits.length >= 9 && digits.length <= 15;
    });
  
  return [...new Set(cleaned)];
}

// Email extraction now uses centralized email-extractor module (imported above)

function categorizePhoneNumbers(phones) {
  const landlines = [];
  const mobiles = [];
  
  phones.forEach(phone => {
    const cleaned = phone.replace(/\D/g, '');
    let isMobile = false;
    
    if (cleaned.startsWith('27')) {
      const prefix = cleaned.substring(2, 3);
      isMobile = ['6', '7', '8'].includes(prefix);
    } else if (cleaned.startsWith('0')) {
      const prefix = cleaned.substring(1, 2);
      isMobile = ['6', '7', '8'].includes(prefix);
    }
    
    if (isMobile) mobiles.push(phone);
    else landlines.push(phone);
  });
  
  return { landlines, mobiles };
}

/**
 * Normalize and validate a URL
 * @param {string} url - URL to normalize
 * @returns {string|null} - Normalized URL or null if invalid
 */
/**
 * Find "Contact us" / "Get in touch" etc. links on the current page (same origin only).
 * Call when the page is already loaded (e.g. homepage or a result page).
 * @param {import('playwright').Page} page - Playwright page (must be loaded)
 * @param {string} baseUrl - Base URL for same-origin check
 * @param {number} maxLinks - Max URLs to return
 * @returns {Promise<string[]>} - Absolute URLs of contact-like links
 */
async function getContactLinkUrlsFromPage(page, baseUrl, maxLinks = 5) {
  try {
    const base = baseUrl.trim().startsWith('http') ? baseUrl : 'https://' + baseUrl;
    const baseOrigin = new URL(base).origin;
    const urls = await page.evaluate((origin, max) => {
      const links = Array.from(document.querySelectorAll('a[href^="http"]'));
      const contactLike = [];
      const seen = new Set();
      const patterns = [
        'contact', 'get in touch', 'get-in-touch', 'reach us', 'reach-us',
        'write to us', 'email us', 'call us', 'find us', 'get in touch',
        'touch with us', 'contact us', 'contactus', 'getintouch'
      ];
      for (const a of links) {
        const href = (a.getAttribute('href') || '').trim();
        if (!href || href.length > 300) continue;
        try {
          const u = new URL(href);
          if (u.origin !== origin) continue;
        } catch (e) { continue; }
        const text = (a.innerText || a.textContent || '').toLowerCase().trim().replace(/\s+/g, ' ');
        const hrefLower = href.toLowerCase();
        const match = patterns.some(p => text.includes(p) || hrefLower.includes(p.replace(/\s+/g, '-')));
        if (match && !seen.has(href)) {
          seen.add(href);
          contactLike.push(href);
        }
      }
      return contactLike.slice(0, max);
    }, baseOrigin, maxLinks);
    return Array.isArray(urls) ? urls : [];
  } catch (e) {
    return [];
  }
}

/**
 * Build candidate URLs for the "Contact us" page from a base URL (same origin).
 * Used as fallback when no contact links are found on the page.
 * @param {string} baseUrl - Any URL on the site (e.g. homepage or search result URL)
 * @returns {string[]} - List of URLs to try (contact, contact-us, etc.)
 */
function getContactPageUrls(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    const pathWithoutFile = u.pathname.replace(/\/[^/]*$/, '') || '';
    const basePath = pathWithoutFile.endsWith('/') ? pathWithoutFile : pathWithoutFile + '/';
    const paths = [
      '/contact',
      '/contact-us',
      '/contact_us',
      '/contactus',
      '/get-in-touch',
      '/reach-us',
      '/contact.html',
      '/contact-us/',
      '/contact/'
    ];
    const urls = paths.map((p) => origin + (p.startsWith('/') ? p : basePath + p));
    return [...new Set(urls)];
  } catch (e) {
    return [];
  }
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  
  let normalized = url.trim();
  
  // Skip empty strings
  if (!normalized) return null;
  
  // Add protocol if missing
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  
  // Basic validation
  try {
    const urlObj = new URL(normalized);
    // Must have a valid hostname with at least one dot
    if (!urlObj.hostname.includes('.')) return null;
    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * Scrape a single website for contact information
 * @param {Page} page - Playwright page instance
 * @param {string} websiteUrl - Website URL to scrape
 * @param {Object} options - Additional options (industry, keywords)
 * @returns {Object|null} - Scraped data or null if failed
 */
async function scrapeSingleWebsite(page, websiteUrl, options = {}) {
  const { industry, keywords, maxPages = 500, useSitemap = true, checkCancellation = null } = options;
  
  try {
    const url = normalizeUrl(websiteUrl);
    if (!url) {
      console.log(`Invalid URL: ${websiteUrl}`);
      return null;
    }
    
    // Collect all URLs to scrape
    let urlsToScrape = [url]; // Always include homepage
    
    // Try to find and parse XML and/or HTML sitemap (all pages)
    if (useSitemap) {
      try {
        console.log(`Looking for sitemap(s) for ${url}...`);
        const baseDomain = new URL(url).hostname.replace(/^www\./, '');
        const sameDomain = (u) => {
          try {
            const host = new URL(u).hostname.replace(/^www\./, '');
            return host === baseDomain;
          } catch (e) { return false; }
        };

        const xmlSitemaps = await findSitemaps(url);
        let allPageUrls = [];
        if (xmlSitemaps && xmlSitemaps.length) {
          console.log(`Found ${xmlSitemaps.length} XML sitemap(s), fetching all pages...`);
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
          const htmlUrls = await fetchUrlsFromHtmlSitemap(url);
          if (htmlUrls.length) {
            console.log(`Found HTML sitemap: ${htmlUrls.length} page URLs`);
            allPageUrls = htmlUrls;
          }
        }
        if (allPageUrls.length) {
          const filtered = [...new Set(allPageUrls)].filter(sameDomain).slice(0, maxPages - 1);
          urlsToScrape = [url, ...filtered];
          console.log(`Will scrape ${urlsToScrape.length} pages from sitemap(s)`);
        } else {
          urlsToScrape = [url];
          console.log(`No sitemap found for ${url}, will use homepage and contact links from page (or guessed paths)`);
        }
      } catch (error) {
        console.log(`Sitemap error for ${url}: ${error.message}, falling back to homepage + contact/about`);
      }
    }
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await websiteDelay('init');

    // When we only have the homepage (no sitemap), find Contact us links on the page first, else use guessed paths
    if (urlsToScrape.length === 1) {
      const baseDomain = new URL(url).hostname.replace(/^www\./, '');
      const sameDomain = (u) => {
        try { return new URL(u).hostname.replace(/^www\./, '') === baseDomain; } catch (e) { return false; }
      };
      const contactFromPage = await getContactLinkUrlsFromPage(page, url, 5);
      if (contactFromPage.length) {
        urlsToScrape = [url, ...contactFromPage.filter(sameDomain)];
        console.log(`Found ${contactFromPage.length} contact link(s) on page, will scrape those`);
      } else {
        const guessed = getContactPageUrls(url).filter(sameDomain);
        urlsToScrape = [url, ...guessed];
        console.log(`No contact links on page, using homepage + ${guessed.length} guessed contact path(s)`);
      }
    }

    // Limit total pages
    if (urlsToScrape.length > maxPages) {
      urlsToScrape = urlsToScrape.slice(0, maxPages);
    }
    
    // Get company name: try ld+json first, then title + og:site_name + url via extractCompanyName
    const pageMeta = await page.evaluate(() => {
      const ldJson = document.querySelector('script[type="application/ld+json"]');
      let ldName = null;
      if (ldJson) {
        try {
          const data = JSON.parse(ldJson.textContent);
          ldName = data.name || data.organization?.name || null;
        } catch (e) {}
      }
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      return {
        ldName,
        title: document.title || '',
        ogSiteName: ogSiteName?.content?.trim() || null
      };
    });
    const pageUrl = page.url();
    let companyName = (pageMeta.ldName && !['contact us', 'contact', 'about', 'home', 'welcome'].includes(String(pageMeta.ldName).toLowerCase()))
      ? pageMeta.ldName
      : extractCompanyName({ title: pageMeta.title, url: pageUrl, ogSiteName: pageMeta.ogSiteName });
    if (!companyName) {
      try {
        const host = new URL(pageUrl).hostname.replace(/^www\./, '').split('.')[0];
        companyName = host ? host.charAt(0).toUpperCase() + host.slice(1) : 'Unknown Company';
      } catch (e) {
        companyName = 'Unknown Company';
      }
    }
    
    // Clean up company name - remove generic suffixes
    let cleanedCompanyName = companyName;
    if (cleanedCompanyName) {
      const genericSuffixes = [' - contact us', ' | contact us', ' contact', ' - contact', ' | contact', ' - home', ' | home'];
      genericSuffixes.forEach(suffix => {
        if (cleanedCompanyName.toLowerCase().endsWith(suffix.toLowerCase())) {
          cleanedCompanyName = cleanedCompanyName.substring(0, cleanedCompanyName.length - suffix.length).trim();
        }
      });
    }

    // Website source: Name = <title> or main <h1> only. Do NOT extract or save any person's name from body content.
    const pageDisplayName = await page.evaluate(() => {
      const title = (document.title || '').trim();
      const titlePart = title ? title.split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim() : '';
      if (titlePart && titlePart.length < 150) return titlePart;
      const h1 = document.querySelector('h1');
      const h1Text = (h1?.innerText || '').trim();
      if (h1Text && h1Text.length < 150) return h1Text;
      return '';
    });
    
    // Get meta description
    const metaDescription = await page.evaluate(() => {
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc?.content) return metaDesc.content;
      
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc?.content) return ogDesc.content;
      
      // Fallback: first meaningful paragraph
      const paragraphs = Array.from(document.querySelectorAll('p'));
      for (const p of paragraphs) {
        const text = p.innerText?.trim();
        if (text && text.length > 50 && text.length < 500) {
          return text;
        }
      }
      
      return '';
    });
    
    // Collect text from all pages
    let allText = await page.evaluate(() => document.body.innerText || '');
    let allHtml = await page.evaluate(() => document.body.innerHTML || '');
    let companyDescription = metaDescription || '';
    
    // If we have sitemap URLs, visit each one
    if (urlsToScrape.length > 1) {
      console.log(`Scraping ${urlsToScrape.length} pages from sitemap...`);
      
      for (let i = 1; i < urlsToScrape.length; i++) { // Start from 1 (skip homepage, already done)
        // Check for cancellation before each page
        if (checkCancellation && checkCancellation()) {
          progressCallback({ 
            status: 'Scraping cancelled by user', 
            cancelled: true
          });
          break;
        }
        
        const pageUrl = urlsToScrape[i];
        
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await websiteDelay('betweenPages');
          
          const pageText = await page.evaluate(() => document.body.innerText || '');
          const pageHtml = await page.evaluate(() => document.body.innerHTML || '');
          allText += '\n' + pageText;
          allHtml += '\n' + pageHtml;
          
          // Update description if we find a better one
          const pageDescription = await page.evaluate(() => {
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc?.content) return metaDesc.content;
            
            const paragraphs = Array.from(document.querySelectorAll('p'));
            const longParagraphs = paragraphs
              .map(p => p.innerText?.trim())
              .filter(text => text && text.length > 100)
              .slice(0, 3);
            return longParagraphs.join('\n');
          });
          
          if (pageDescription && pageDescription.length > companyDescription.length) {
            companyDescription = pageDescription;
          }
          
          // Progress update every 10 pages
          if (i % 10 === 0) {
            console.log(`Scraped ${i}/${urlsToScrape.length - 1} pages...`);
          }
        } catch (e) {
          console.log(`Error scraping page ${pageUrl}: ${e.message}`);
          // Continue with next page
        }
      }
    } else {
      // Fallback: Find contact and about page links if no sitemap
      const links = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a'));
        const contactLinks = [];
        const aboutLinks = [];
        
        allLinks.forEach(link => {
          const href = (link.href || '').toLowerCase();
          const text = (link.innerText || '').toLowerCase();
          
          if (href.includes('contact') || text.includes('contact') ||
              href.includes('get-in-touch') || text.includes('get in touch')) {
            if (link.href) contactLinks.push(link.href);
          }
          if (href.includes('about') || text.includes('about us') || text === 'about') {
            if (link.href) aboutLinks.push(link.href);
          }
        });
        
        return { 
          contactLinks: [...new Set(contactLinks)].slice(0, 2), 
          aboutLinks: [...new Set(aboutLinks)].slice(0, 2) 
        };
      });
      
      // Visit contact page
      if (links.contactLinks.length > 0) {
        try {
          await page.goto(links.contactLinks[0], { waitUntil: 'domcontentloaded', timeout: 20000 });
          await websiteDelay('betweenPages');
          
          const contactText = await page.evaluate(() => document.body.innerText || '');
          const contactHtml = await page.evaluate(() => document.body.innerHTML || '');
          allText += '\n' + contactText;
          allHtml += '\n' + contactHtml;
        } catch (e) {
          console.log(`Contact page error for ${companyName}: ${e.message}`);
        }
      }
      
      // Visit about page for better description
      if (links.aboutLinks.length > 0) {
        try {
          await page.goto(links.aboutLinks[0], { waitUntil: 'networkidle', timeout: 20000 });
          // No extra delay needed
          
          const aboutText = await page.evaluate(() => {
            const paragraphs = Array.from(document.querySelectorAll('p'));
            const longParagraphs = paragraphs
              .map(p => p.innerText?.trim())
              .filter(text => text && text.length > 100)
              .slice(0, 3);
            return longParagraphs.join('\n');
          });
          
          if (aboutText && aboutText.length > companyDescription.length) {
            companyDescription = aboutText;
          }
          
          allText += '\n' + aboutText;
        } catch (e) {
          console.log(`About page error for ${companyName}: ${e.message}`);
        }
      }
    }
    
    // Extract contact information
    const phones = extractPhoneNumbers(allText);
    const allEmails = extractEmails(allText, allHtml);
    const emails = filterBusinessEmails(allEmails).slice(0, 2); // max 2 emails per website
    const mailtoEmails = extractMailtoEmails(allHtml);
    const { landlines, mobiles } = categorizePhoneNumbers(phones);
    // Prefer mailto: and contact/info/sales to reduce bounces
    const primaryEmail = getBestEmail(emails.length ? emails : allEmails, { mailtoEmails }) || null;
    
    // Build contact record (website source: name from title/h1 only, not scraped person name)
    const contactData = {
      company: truncateField(cleanedCompanyName || companyName, 100),
      first_name: truncateField(pageDisplayName || '', 100),
      last_name: '',
      email: primaryEmail,
      phone_number: landlines[0] || null,
      mobile_number: mobiles[0] || null,
      whatsapp_number: mobiles[0] || null,
      company_website: url,
      company_summary: companyDescription.slice(0, 500) || null,
      location: null,
      job_title: null,
      email_domain: primaryEmail ? truncateField(primaryEmail.split('@')[1], 100) : null,
      source: 'website',
      email_verified: false,
      verification_status: primaryEmail ? 'unverified' : 'no_email',
      industry: truncateField(industry, 100),
      keywords: truncateField(keywords, 100),
      search_query: truncateField(url, 200), // Store website URL as search query
      // Extra data for reference
      _allEmails: emails,
      _allPhones: phones
    };
    
    return contactData;
    
  } catch (error) {
    console.log(`Error scraping ${websiteUrl}: ${error.message}`);
    return null;
  }
}

// ============================================
// SINGLE WEBSITE SCRAPER (Original function - backward compatible)
// ============================================

/**
 * @param {Object} config - { websiteUrl, industry, keywords }
 * @param {Function} progressCallback - Progress callback (counts/phase only)
 * @param {Object} options - { checkCancellation }
 */
async function runWebsiteScraper(config, progressCallback, options = {}) {
  const { websiteUrl, industry = null, keywords = null } = config || {};
  const checkCancellation = options.checkCancellation || (() => false);
  if (Array.isArray(websiteUrl) || (typeof websiteUrl === 'string' && (websiteUrl.includes(',') || websiteUrl.includes('\n')))) {
    return runBulkWebsiteScraper(config, progressCallback, options);
  }
  const scrapedData = [];
  let browser;
  try {
    progressCallback({ status: 'Launching browser...', profilesFound: 0, profilesScraped: 0 });
    browser = await launchBrowser({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    progressCallback({ status: `Scraping ${websiteUrl}...`, profilesFound: 1, profilesScraped: 0 });
    const result = await scrapeSingleWebsite(page, websiteUrl, { industry, keywords });
    if (result) {
      const { _allEmails, _allPhones, ...cleanResult } = result;
      scrapedData.push(cleanResult);
      const summary = `Found ${_allEmails?.length || 0} email(s), ${_allPhones?.length || 0} phone(s)`;
      progressCallback({ status: `Complete! ${summary}`, profilesFound: 1, profilesScraped: 1, completed: true });
    } else {
      progressCallback({ status: 'No contact information found.', profilesFound: 1, profilesScraped: 0, completed: true });
    }
    await websiteDelay('final');
    await browser.close();
    return scrapedData;
    
  } catch (error) {
    progressCallback({ 
      status: `Error: ${error.message}`, 
      profilesFound: 0, 
      profilesScraped: scrapedData.length,
      error: true
    });
    if (browser) await browser.close();
    throw error;
  }
}

// ============================================
// BULK WEBSITE SCRAPER (Multiple URLs at once)
// ============================================

/**
 * @param {Object} config - { websiteUrl (string or array), industry, keywords, isBulk }
 * @param {Function} progressCallback - Progress callback (counts/phase only)
 * @param {Object} options - { checkCancellation }
 */
async function runBulkWebsiteScraper(config, progressCallback, options = {}) {
  const { websiteUrl: websiteUrls, industry = null, keywords = null } = config || {};
  const checkCancellation = options.checkCancellation || (() => false);
  const scrapedData = [];
  let browser;
  let urls = [];
  if (typeof websiteUrls === 'string') {
    // Split by newlines only so URLs with commas (e.g. query params) are not broken; support \r\n and \n
    urls = websiteUrls.split(/\r?\n/).map(url => url.trim()).filter(url => url.length > 0);
    // Also allow comma/semicolon-separated if user pasted that (single line)
    if (urls.length === 1 && (urls[0].includes(',') || urls[0].includes(';'))) {
      urls = urls[0].split(/[,;]+/).map(u => u.trim()).filter(Boolean);
    }
  } else if (Array.isArray(websiteUrls)) {
    urls = websiteUrls.map(url => (typeof url === 'string' ? url : '').trim()).filter(url => url.length > 0);
  }
  
  // Normalize and validate all URLs
  const validUrls = urls
    .map(url => normalizeUrl(url))
    .filter(url => url !== null);
  
  if (validUrls.length === 0) {
    progressCallback({ 
      status: 'No valid URLs provided.', 
      profilesFound: 0, 
      profilesScraped: 0,
      error: true
    });
    return [];
  }
  
  // Remove duplicates
  const uniqueUrls = [...new Set(validUrls)];
  
  try {
    progressCallback({ 
      status: `Launching browser for ${uniqueUrls.length} websites...`, 
      profilesFound: uniqueUrls.length, 
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
    page.setDefaultTimeout(30000);
    
    // Scrape each website
    const successfulScrapes = [];
    const failedScrapes = [];
    
    for (let i = 0; i < uniqueUrls.length; i++) {
      if (checkCancellation()) {
        progressCallback({ status: 'Scraping cancelled by user', profilesFound: uniqueUrls.length, profilesScraped: scrapedData.length, cancelled: true });
        break;
      }
      const url = uniqueUrls[i];
      const displayUrl = url.replace('https://', '').replace('http://', '').substring(0, 40);
      progressCallback({ status: `Scraping ${i + 1}/${uniqueUrls.length}: ${displayUrl}...`, profilesFound: uniqueUrls.length, profilesScraped: scrapedData.length, phase: 'scraping' });
      try {
        const result = await scrapeSingleWebsite(page, url, { industry, keywords });
        if (result) {
          const { _allEmails, _allPhones, ...cleanResult } = result;
          scrapedData.push(cleanResult);
          successfulScrapes.push({ url, company: cleanResult.company, hasEmail: !!cleanResult.email, hasPhone: !!(cleanResult.phone_number || cleanResult.mobile_number) });
        } else {
          failedScrapes.push({ url, reason: 'No data extracted' });
        }
      } catch (error) {
        console.log(`Failed to scrape ${url}: ${error.message}`);
        failedScrapes.push({ url, reason: error.message });
      }
      if (i < uniqueUrls.length - 1) await websiteDelay('betweenSites');
    }
    const emailCount = scrapedData.filter(r => r.email).length;
    const phoneCount = scrapedData.filter(r => r.phone_number || r.mobile_number).length;
    progressCallback({ status: `Complete! Scraped ${scrapedData.length}/${uniqueUrls.length} websites. ${emailCount} emails, ${phoneCount} phones found.`, profilesFound: uniqueUrls.length, profilesScraped: scrapedData.length, phase: 'complete', completed: true, stats: { total: uniqueUrls.length, successful: scrapedData.length, failed: failedScrapes.length, withEmail: emailCount, withPhone: phoneCount }, failedUrls: failedScrapes });
    await websiteDelay('final');
    await browser.close();
    return scrapedData;
    
  } catch (error) {
    progressCallback({ 
      status: `Error: ${error.message}`, 
      profilesFound: uniqueUrls.length, 
      profilesScraped: scrapedData.length,
      phase: 'error',
      error: true
    });
    if (browser) await browser.close();
    throw error;
  }
}

module.exports = {
  findSitemaps,
  fetchAllUrlsFromSitemap,
  fetchUrlsFromHtmlSitemap,
  getContactPageUrls,
  getContactLinkUrlsFromPage,
  runWebsiteScraper,
  runBulkWebsiteScraper
};