/**
 * Google Search Email Scraper
 * 
 * Scrapes email addresses from Google Search results
 * Searches for company emails and extracts them from result snippets and pages
 */

const { launchBrowser } = require('./browser-helper');
const { createClient } = require('@supabase/supabase-js');
const { extractEmails, filterBusinessEmails, getBestEmail, createContactFromEmail } = require('./email-extractor');

const SUPABASE_URL = 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function randomSleep(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract emails from Google Search result snippets
 * @param {Page} page - Playwright page instance
 * @param {Object} limits
 * @param {number} limits.maxResultLinks - max links to scan on page
 * @param {number} limits.maxUniqueResults - max unique result URLs to keep
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
        await randomSleep(3000, 5000);
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
    
    // Extract emails from snippets
    for (const result of searchResults) {
      const snippetText = (result.title + ' ' + result.snippet).toLowerCase();
      const emails = extractEmails(result.snippet, '');
      const businessEmails = filterBusinessEmails(emails);
      
      for (const email of businessEmails) {
        results.push({
          email,
          context: result.snippet,
          url: result.url,
          title: result.title
        });
      }
    }
    
    console.log(`Found ${results.length} emails in search result snippets`);
  } catch (error) {
    console.log('Error extracting from search results:', error.message);
  }
  
  return { emailResults: results, resultItems: searchResults };
}

/**
 * Visit a URL and extract emails from the page
 * @param {Page} page - Playwright page instance
 * @param {string} url - URL to visit
 * @param {string} companyName - Company name for context
 * @param {string} originalQuery - Original search query (before "email contact" was added)
 * @returns {Array<Object>} - Array of contact objects
 */
async function extractEmailsFromPage(page, url, companyName, originalQuery = null) {
  const contacts = [];
  
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    // No extra delay needed
    
    // Wait for page to be stable
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch (e) {
      // Ignore timeout
    }
    
    // Get page content with error handling
    let pageContent = { text: '', html: '', title: '' };
    try {
      pageContent = await page.evaluate(() => {
        return {
          text: document.body.innerText || '',
          html: document.body.innerHTML || '',
          title: document.title || ''
        };
      });
    } catch (error) {
      if (error.message.includes('Execution context was destroyed') || 
          error.message.includes('navigation')) {
        console.log(`Page navigated during content extraction for ${url}, skipping...`);
        return contacts;
      }
      throw error;
    }
    
    // Extract all emails
    const allEmails = extractEmails(pageContent.text, pageContent.html);
    const businessEmails = filterBusinessEmails(allEmails);
    
    // Get company name from page if not provided
    let company = companyName;
    if (!company) {
      try {
        company = await page.evaluate(() => {
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
          
          // Try h1 (but filter out generic text)
          const h1 = document.querySelector('h1')?.innerText?.trim();
          if (h1 && h1.length < 60 && !genericTitles.includes(h1.toLowerCase())) {
            return h1;
          }
          
          // Try page title (but filter out generic text)
          const title = document.title.split('|')[0].split('-')[0].split('—')[0].split('–')[0].trim();
          if (title && title.length < 60 && !genericTitles.includes(title.toLowerCase())) {
            return title;
          }
          
          // Extract from URL domain as last resort
          try {
            const hostname = new URL(window.location.href).hostname;
            const domainName = hostname.replace('www.', '').split('.')[0];
            // Capitalize first letter
            return domainName.charAt(0).toUpperCase() + domainName.slice(1);
          } catch (e) {
            return '';
          }
        });
      } catch (e) {
        // If evaluation fails, try to extract from URL
        try {
          const urlObj = new URL(url);
          const domainName = urlObj.hostname.replace('www.', '').split('.')[0];
          company = domainName.charAt(0).toUpperCase() + domainName.slice(1);
        } catch (e2) {
          company = '';
        }
      }
    }
    
    // Clean up company name - remove generic suffixes
    if (company) {
      const genericSuffixes = [' - contact us', ' | contact us', ' contact', ' - contact', ' | contact'];
      genericSuffixes.forEach(suffix => {
        if (company.toLowerCase().endsWith(suffix.toLowerCase())) {
          company = company.substring(0, company.length - suffix.length).trim();
        }
      });
    }
    
    // Create contact objects for each email
    for (const email of businessEmails) {
      const contact = createContactFromEmail(email, pageContent.text, {
        company: company || null,
        company_website: url,
        source: 'google_search',
        search_query: originalQuery // Store original search query (before "email contact" was added)
      });
      
      if (contact) {
        contacts.push(contact);
      }
    }
    
  } catch (error) {
    console.log(`Error extracting from ${url}:`, error.message);
  }
  
  return contacts;
}

/**
 * Run Google Search email scraper
 * @param {string} searchQuery - Search query (e.g., "company name email contact")
 * @param {number} maxResults - Maximum number of results to process
 * @param {string} industry - Industry tag (optional)
 * @param {string} keywords - Keywords tag (optional)
 * @param {Function} progressCallback - Progress callback function
 * @returns {Array<Object>} - Array of contact objects
 */
async function runGoogleSearchScraper(searchQuery, maxResults = 20, industry = null, keywords = null, progressCallback, options = {}) {
  const scrapedContacts = [];
  let browser;
  
  // Get cancellation check function and original query from options
  const checkCancellation = options.checkCancellation || (() => false);
  const originalQuery = options.originalQuery || searchQuery; // Use original query if provided, otherwise use searchQuery
  
  // Scale internal limits from the user's target (maxResults)
  // These are *not* fixed caps like 10/30 anymore; they scale up with the requested target.
  // Still includes a safety ceiling to avoid infinite/risky runs on Google.
  const maxUniqueResults = Math.min(300, Math.max(30, maxResults * 5));
  const maxResultLinks = Math.min(800, Math.max(60, maxResults * 12));
  const maxUrlsToVisit = Math.min(800, Math.max(30, maxResults * 12));
  
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
    await randomSleep(3000, 5000);
    
    // Wait for results - try multiple selectors
    try {
      await page.waitForSelector('div[data-sokoban-container], div.g, #main, #search', { timeout: 15000 });
    } catch (e) {
      console.log('Waiting for search results timed out, continuing anyway...');
    }
    await randomSleep(2000, 3000);
    
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
        await randomSleep(2000, 3000); // Reduced delay for CAPTCHA check
        
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
    
    // ========== PHASE 2: EXTRACT EMAILS FROM SEARCH RESULTS ==========
    progressCallback({ 
      status: 'Extracting emails from search results...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'extract'
    });
    
    // Scroll down to load more results when the user requests many targets
    if (maxResults > 10) {
      console.log('Scrolling to load more search results...');
      try {
        // Scroll down multiple times to trigger lazy loading
        const scrollSteps = Math.min(10, Math.max(3, Math.ceil(maxResults / 10)));
        for (let scroll = 0; scroll < scrollSteps; scroll++) {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await randomSleep(1500, 2500);
        }
        // Scroll back to top
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await randomSleep(1000, 1500);
      } catch (e) {
        console.log('Error scrolling:', e.message);
      }
    }
    
    const { emailResults, resultItems } = await extractEmailsFromSearchResults(page, {
      maxResultLinks,
      maxUniqueResults
    });
    
    // Process search result emails
    for (let i = 0; i < emailResults.length && scrapedContacts.length < maxResults; i++) {
      // Check for cancellation before each result
      if (checkCancellation && checkCancellation()) {
        progressCallback({ 
          status: 'Scraping cancelled by user', 
          profilesFound: emailResults.length, 
          profilesScraped: scrapedContacts.length,
          cancelled: true,
          phase: 'extract'
        });
        break;
      }
      
      const result = emailResults[i];
      
      progressCallback({ 
        status: `Processing email ${i + 1}/${emailResults.length}...`, 
        profilesFound: emailResults.length, 
        profilesScraped: scrapedContacts.length,
        phase: 'extract'
      });
      
      // Extract better company name from URL if title is generic
      let companyName = result.title || null;
      if (companyName) {
        const genericTitles = ['contact us', 'contact', 'about', 'home', 'welcome'];
        if (genericTitles.includes(companyName.toLowerCase().trim())) {
          // Extract from URL instead
          try {
            const urlObj = new URL(result.url);
            const domainName = urlObj.hostname.replace('www.', '').split('.')[0];
            companyName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
          } catch (e) {
            companyName = null;
          }
        }
      } else {
        // Extract from URL if no title
        try {
          const urlObj = new URL(result.url);
          const domainName = urlObj.hostname.replace('www.', '').split('.')[0];
          companyName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
        } catch (e) {
          companyName = null;
        }
      }
      
      const contact = createContactFromEmail(result.email, result.context, {
        company: companyName,
        company_website: result.url,
        source: 'google_search',
        industry,
        keywords,
        search_query: originalQuery // Store original search query
      });
      
      if (contact) {
        scrapedContacts.push(contact);
      }
      
      await randomSleep(400, 700); // Reduced delay between results
    }
    
    // ========== PHASE 3: VISIT TOP RESULTS FOR MORE EMAILS ==========
    // Always visit pages to extract emails (snippets rarely have emails)
    progressCallback({ 
      status: 'Visiting top search results for more emails...', 
      profilesFound: (resultItems && resultItems.length) ? resultItems.length : (emailResults.length || 10), 
      profilesScraped: scrapedContacts.length,
      phase: 'visit'
    });
    
    // Get URLs from search results, or extract URLs directly from page if extraction failed
    let uniqueUrls = [];
    if (resultItems && resultItems.length > 0) {
      uniqueUrls = [...new Set(resultItems.map(r => r.url))].slice(0, maxUrlsToVisit);
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
          const pageContacts = await extractEmailsFromPage(page, url, null, originalQuery);
          
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
        
        await randomSleep(800, 1500); // Reduced delay between page visits
      }
    } else {
      console.log('No URLs found to visit or already reached max results');
    }
    
    // ========== PHASE 4: SAVE TO DATABASE ==========
    if (scrapedContacts.length > 0) {
      progressCallback({ 
        status: `Saving ${scrapedContacts.length} contacts to database...`, 
        profilesFound: scrapedContacts.length, 
        profilesScraped: scrapedContacts.length,
        phase: 'save'
      });
      
      // Remove duplicates by email
      const uniqueContacts = [...new Map(scrapedContacts.map(c => [c.email, c])).values()];
      
      // Separate contacts with and without email (all should have email, but just in case)
      const withEmail = uniqueContacts.filter(c => c.email);
      
      if (withEmail.length > 0) {
        const { error } = await supabase
          .from('contacts')
          .upsert(withEmail, { onConflict: 'email', ignoreDuplicates: false });
        
        if (error) {
          console.error('Supabase save error:', error);
        } else {
          console.log(`Successfully saved ${withEmail.length} contacts from Google Search`);
        }
      }
    }
    
    progressCallback({ 
      status: `Complete! ${scrapedContacts.length} contacts found.`, 
      profilesFound: scrapedContacts.length, 
      profilesScraped: scrapedContacts.length,
      phase: 'complete',
      completed: true,
      stats: {
        total: scrapedContacts.length,
        withEmail: scrapedContacts.filter(c => c.email).length
      }
    });
    
    await randomSleep(500, 1000); // Reduced final delay
    await browser.close();
    
    return scrapedContacts;
    
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
