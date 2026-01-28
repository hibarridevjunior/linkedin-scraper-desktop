const { launchBrowser } = require('./browser-helper');
const { createClient } = require('@supabase/supabase-js');
const { extractEmails, filterBusinessEmails, getBestEmail } = require('./email-extractor');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');

const SUPABASE_URL = 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function randomSleep(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to truncate strings to database column limits
function truncateField(value, maxLength = 100) {
  if (!value || typeof value !== 'string') return value;
  return value.length > maxLength ? value.substring(0, maxLength) : value;
}

/**
 * Fetch and parse sitemap XML
 * @param {string} sitemapUrl - URL to sitemap
 * @returns {Promise<Array<string>>} - Array of URLs from sitemap
 */
function fetchSitemap(sitemapUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(sitemapUrl);
    const client = url.protocol === 'https:' ? https : http;
    
    client.get(sitemapUrl, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          parseString(data, (err, result) => {
            if (err) {
              reject(err);
              return;
            }
            
            const urls = [];
            
            // Handle sitemap index (contains multiple sitemaps)
            if (result.sitemapindex && result.sitemapindex.sitemap) {
              const sitemaps = result.sitemapindex.sitemap.map(s => s.loc[0]);
              // For now, just return the first sitemap URL (can be enhanced to fetch all)
              resolve(sitemaps);
              return;
            }
            
            // Handle regular sitemap (contains URLs)
            if (result.urlset && result.urlset.url) {
              result.urlset.url.forEach(urlEntry => {
                if (urlEntry.loc && urlEntry.loc[0]) {
                  urls.push(urlEntry.loc[0]);
                }
              });
            }
            
            resolve(urls);
          });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Find sitemap URL for a website
 * @param {string} baseUrl - Base website URL
 * @returns {Promise<string|null>} - Sitemap URL or null if not found
 */
async function findSitemap(baseUrl) {
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
    
    // Try common sitemap locations
    for (const path of commonSitemapPaths) {
      try {
        const sitemapUrl = base + path;
        const response = await new Promise((resolve, reject) => {
          const client = url.protocol === 'https:' ? https : http;
          const req = client.get(sitemapUrl, (res) => {
            if (res.statusCode === 200) {
              resolve(sitemapUrl);
            } else {
              reject(new Error(`Status ${res.statusCode}`));
            }
          });
          req.on('error', reject);
          req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
        });
        
        return response;
      } catch (e) {
        // Continue to next path
      }
    }
    
    // Try robots.txt for sitemap reference
    try {
      const robotsUrl = base + '/robots.txt';
      const robotsContent = await new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(robotsUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });
      
      const sitemapMatch = robotsContent.match(/Sitemap:\s*(.+)/i);
      if (sitemapMatch && sitemapMatch[1]) {
        return sitemapMatch[1].trim();
      }
    } catch (e) {
      // robots.txt not found or error
    }
    
    return null;
  } catch (error) {
    return null;
  }
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
  const { industry, keywords, maxPages = 50, useSitemap = true, checkCancellation = null } = options;
  
  try {
    const url = normalizeUrl(websiteUrl);
    if (!url) {
      console.log(`Invalid URL: ${websiteUrl}`);
      return null;
    }
    
    // Collect all URLs to scrape
    let urlsToScrape = [url]; // Always include homepage
    
    // Try to find and parse sitemap
    if (useSitemap) {
      try {
        console.log(`Looking for sitemap for ${url}...`);
        const sitemapUrl = await findSitemap(url);
        
        if (sitemapUrl) {
          console.log(`Found sitemap: ${sitemapUrl}`);
          const sitemapUrls = await fetchSitemap(sitemapUrl);
          
          // Filter URLs to same domain and limit count
          const baseDomain = new URL(url).hostname;
          const filteredUrls = sitemapUrls
            .filter(sitemapUrl => {
              try {
                const sitemapDomain = new URL(sitemapUrl).hostname;
                return sitemapDomain === baseDomain || sitemapDomain.replace('www.', '') === baseDomain.replace('www.', '');
              } catch (e) {
                return false;
              }
            })
            .slice(0, maxPages - 1); // -1 because we already have homepage
          
          urlsToScrape = [url, ...filteredUrls];
          console.log(`Will scrape ${urlsToScrape.length} pages from sitemap`);
        } else {
          console.log(`No sitemap found for ${url}, using homepage + contact/about pages`);
        }
      } catch (error) {
        console.log(`Sitemap error for ${url}: ${error.message}, falling back to homepage + contact/about`);
      }
    }
    
    // Limit total pages
    if (urlsToScrape.length > maxPages) {
      urlsToScrape = urlsToScrape.slice(0, maxPages);
    }
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomSleep(2000, 3000);
    
    // Get company name
    const companyName = await page.evaluate((pageUrl) => {
      // Generic page titles to skip
      const genericTitles = [
        'contact us', 'contact', 'about', 'about us', 'home', 'welcome',
        'get in touch', 'reach us', 'email us', 'phone', 'location',
        'privacy policy', 'terms', 'terms of service', 'careers', 'jobs',
        'blog', 'news', 'services', 'products', 'portfolio'
      ];
      
      // Try structured data first (most reliable)
      const ldJson = document.querySelector('script[type="application/ld+json"]');
      if (ldJson) {
        try {
          const data = JSON.parse(ldJson.textContent);
          if (data.name && !genericTitles.includes(data.name.toLowerCase())) {
            return data.name;
          }
          if (data.organization?.name && !genericTitles.includes(data.organization.name.toLowerCase())) {
            return data.organization.name;
          }
        } catch (e) {}
      }
      
      // Try meta tags
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      if (ogSiteName?.content && !genericTitles.includes(ogSiteName.content.toLowerCase())) {
        return ogSiteName.content;
      }
      
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle?.content && ogTitle.content.length < 60 && !genericTitles.includes(ogTitle.content.toLowerCase())) {
        return ogTitle.content;
      }
      
      // Try h1 (but filter out generic text)
      const h1 = document.querySelector('h1');
      if (h1?.innerText?.trim() && h1.innerText.length < 100) {
        const h1Text = h1.innerText.trim();
        if (!genericTitles.includes(h1Text.toLowerCase())) {
          return h1Text;
        }
      }
      
      // Fallback to title (but filter out generic text)
      const title = document.title;
      if (title) {
        const titleText = title.split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim();
        if (!genericTitles.includes(titleText.toLowerCase())) {
          return titleText;
        }
      }
      
      // Last resort: domain name
      try {
        const hostname = new URL(pageUrl).hostname;
        const domainName = hostname.replace('www.', '').split('.')[0];
        // Capitalize first letter
        return domainName.charAt(0).toUpperCase() + domainName.slice(1);
      } catch (e) {
        return 'Unknown Company';
      }
    }, url);
    
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
        if (checkCancellation()) {
          progressCallback({ 
            status: 'Scraping cancelled by user', 
            cancelled: true
          });
          break;
        }
        
        const pageUrl = urlsToScrape[i];
        
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await randomSleep(1500, 2500);
          
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
          await randomSleep(1500, 2500);
          
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
    // Use centralized email extractor with business email filtering
    const allEmails = extractEmails(allText, allHtml);
    const emails = filterBusinessEmails(allEmails); // Only business emails
    const { landlines, mobiles } = categorizePhoneNumbers(phones);
    
    // Get best email (prioritizes business emails)
    const primaryEmail = getBestEmail(allEmails) || null;
    
    // Build contact record
    const contactData = {
      company: truncateField(cleanedCompanyName || companyName, 100),
      first_name: truncateField(companyName, 100),
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

async function runWebsiteScraper(websiteUrl, industry = null, keywords = null, progressCallback, options = {}) {
  const checkCancellation = options.checkCancellation || (() => false);
  // If array is passed, use bulk scraper
  if (Array.isArray(websiteUrl)) {
    return runBulkWebsiteScraper(websiteUrl, industry, keywords, progressCallback, options);
  }
  
  const scrapedData = [];
  let browser;
  
  try {
    progressCallback({ status: 'Launching browser...', profilesFound: 0, profilesScraped: 0 });
    
    browser = await launchBrowser({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    
    progressCallback({ status: `Scraping ${websiteUrl}...`, profilesFound: 1, profilesScraped: 0 });
    
    const result = await scrapeSingleWebsite(page, websiteUrl, { industry, keywords });
    
    if (result) {
      // Remove internal fields before saving
      const { _allEmails, _allPhones, ...cleanResult } = result;
      scrapedData.push(cleanResult);
      
      // Save to Supabase
      if (cleanResult.email || cleanResult.phone_number || cleanResult.mobile_number) {
        let dbResult;
        if (cleanResult.email) {
          dbResult = await supabase
            .from('contacts')
            .upsert(cleanResult, { onConflict: 'email' });
        } else {
          dbResult = await supabase
            .from('contacts')
            .insert(cleanResult);
        }
        
        if (dbResult.error) {
          console.error('Supabase error:', dbResult.error);
        }
      }
      
      const summary = `Found ${_allEmails?.length || 0} email(s), ${_allPhones?.length || 0} phone(s)`;
      progressCallback({ 
        status: `Complete! ${summary}`, 
        profilesFound: 1, 
        profilesScraped: 1,
        completed: true
      });
    } else {
      progressCallback({ 
        status: 'No contact information found.', 
        profilesFound: 1, 
        profilesScraped: 0,
        completed: true
      });
    }
    
    await randomSleep(300, 500); // Reduced final delay
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
 * Scrape multiple websites at once
 * @param {string|string[]} websiteUrls - Single URL, comma-separated URLs, or array of URLs
 * @param {string} industry - Industry category
 * @param {string} keywords - Keywords for tagging
 * @param {Function} progressCallback - Progress callback function
 * @returns {Array} - Array of scraped contact data
 */
async function runBulkWebsiteScraper(websiteUrls, industry = null, keywords = null, progressCallback) {
  const scrapedData = [];
  let browser;
  
  // Parse URLs - handle string (comma/newline separated) or array
  let urls = [];
  if (typeof websiteUrls === 'string') {
    // Split by comma, newline, semicolon, or space
    urls = websiteUrls
      .split(/[,;\n\r]+/)
      .map(url => url.trim())
      .filter(url => url.length > 0);
  } else if (Array.isArray(websiteUrls)) {
    urls = websiteUrls.map(url => url.trim()).filter(url => url.length > 0);
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
      const url = uniqueUrls[i];
      const displayUrl = url.replace('https://', '').replace('http://', '').substring(0, 40);
      
      progressCallback({ 
        status: `Scraping ${i + 1}/${uniqueUrls.length}: ${displayUrl}...`, 
        profilesFound: uniqueUrls.length, 
        profilesScraped: scrapedData.length,
        phase: 'scraping',
        currentUrl: url
      });
      
      try {
        const result = await scrapeSingleWebsite(page, url, { industry, keywords });
        
        if (result) {
          // Remove internal fields
          const { _allEmails, _allPhones, ...cleanResult } = result;
          scrapedData.push(cleanResult);
          successfulScrapes.push({
            url,
            company: cleanResult.company,
            hasEmail: !!cleanResult.email,
            hasPhone: !!(cleanResult.phone_number || cleanResult.mobile_number)
          });
        } else {
          failedScrapes.push({ url, reason: 'No data extracted' });
        }
      } catch (error) {
        console.log(`Failed to scrape ${url}: ${error.message}`);
        failedScrapes.push({ url, reason: error.message });
      }
      
      // Reduced delay between websites (still need some to avoid rate limiting)
      if (i < uniqueUrls.length - 1) {
        await randomSleep(800, 1500); // Reduced but still safe
      }
    }
    
    // Save all results to database
    if (scrapedData.length > 0) {
      progressCallback({ 
        status: `Saving ${scrapedData.length} contacts to database...`, 
        profilesFound: uniqueUrls.length, 
        profilesScraped: scrapedData.length,
        phase: 'saving'
      });
      
      // Separate records with and without email
      const withEmail = scrapedData.filter(r => r.email);
      const withoutEmail = scrapedData.filter(r => !r.email && (r.phone_number || r.mobile_number));
      
      // Upsert records with email
      if (withEmail.length > 0) {
        const { error: upsertError } = await supabase
          .from('contacts')
          .upsert(withEmail, { onConflict: 'email' });
        
        if (upsertError) {
          console.error('Supabase upsert error:', upsertError);
        }
      }
      
      // Insert records without email (but have phone)
      if (withoutEmail.length > 0) {
        const { error: insertError } = await supabase
          .from('contacts')
          .insert(withoutEmail);
        
        if (insertError) {
          console.error('Supabase insert error:', insertError);
        }
      }
      
      console.log(`Saved ${withEmail.length + withoutEmail.length} contacts (${withEmail.length} with emails)`);
    }
    
    // Calculate stats
    const emailCount = scrapedData.filter(r => r.email).length;
    const phoneCount = scrapedData.filter(r => r.phone_number || r.mobile_number).length;
    
    progressCallback({ 
      status: `Complete! Scraped ${scrapedData.length}/${uniqueUrls.length} websites. ${emailCount} emails, ${phoneCount} phones found.`, 
      profilesFound: uniqueUrls.length, 
      profilesScraped: scrapedData.length,
      phase: 'complete',
      completed: true,
      stats: {
        total: uniqueUrls.length,
        successful: scrapedData.length,
        failed: failedScrapes.length,
        withEmail: emailCount,
        withPhone: phoneCount
      },
      failedUrls: failedScrapes
    });
    
    await randomSleep(300, 500); // Reduced final delay
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
  runWebsiteScraper,
  runBulkWebsiteScraper
};