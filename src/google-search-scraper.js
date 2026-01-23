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
 * @returns {Array<Object>} - Array of {email, context, url}
 */
async function extractEmailsFromSearchResults(page) {
  const results = [];
  
  try {
    // Get all search result elements
    const searchResults = await page.evaluate(() => {
      const items = [];
      const resultElements = document.querySelectorAll('div[data-sokoban-container] a[href*="http"]');
      
      resultElements.forEach((link, index) => {
        if (index >= 10) return; // Limit to top 10 results
        
        const url = link.href;
        const title = link.querySelector('h3')?.innerText || '';
        const snippet = link.closest('div[data-sokoban-container]')?.querySelector('span[style*="-webkit-line-clamp"]')?.innerText || '';
        
        if (url && url.startsWith('http')) {
          items.push({ url, title, snippet });
        }
      });
      
      return items;
    });
    
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
  } catch (error) {
    console.log('Error extracting from search results:', error.message);
  }
  
  return results;
}

/**
 * Visit a URL and extract emails from the page
 * @param {Page} page - Playwright page instance
 * @param {string} url - URL to visit
 * @param {string} companyName - Company name for context
 * @returns {Array<Object>} - Array of contact objects
 */
async function extractEmailsFromPage(page, url, companyName) {
  const contacts = [];
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomSleep(2000, 3000);
    
    // Get page content
    const pageContent = await page.evaluate(() => {
      return {
        text: document.body.innerText || '',
        html: document.body.innerHTML || '',
        title: document.title || ''
      };
    });
    
    // Extract all emails
    const allEmails = extractEmails(pageContent.text, pageContent.html);
    const businessEmails = filterBusinessEmails(allEmails);
    
    // Get company name from page if not provided
    let company = companyName;
    if (!company) {
      company = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.innerText;
        const title = document.title.split('|')[0].split('-')[0].trim();
        return h1 || title || '';
      });
    }
    
    // Create contact objects for each email
    for (const email of businessEmails) {
      const contact = createContactFromEmail(email, pageContent.text, {
        company: company || null,
        company_website: url,
        source: 'google_search'
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
async function runGoogleSearchScraper(searchQuery, maxResults = 20, industry = null, keywords = null, progressCallback) {
  const scrapedContacts = [];
  let browser;
  
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
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomSleep(3000, 5000);
    
    // Wait for results
    await page.waitForSelector('div[data-sokoban-container]', { timeout: 15000 }).catch(() => {});
    await randomSleep(2000, 3000);
    
    // ========== PHASE 2: EXTRACT EMAILS FROM SEARCH RESULTS ==========
    progressCallback({ 
      status: 'Extracting emails from search results...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'extract'
    });
    
    const emailResults = await extractEmailsFromSearchResults(page);
    
    // Process search result emails
    for (let i = 0; i < emailResults.length && scrapedContacts.length < maxResults; i++) {
      const result = emailResults[i];
      
      progressCallback({ 
        status: `Processing email ${i + 1}/${emailResults.length}...`, 
        profilesFound: emailResults.length, 
        profilesScraped: scrapedContacts.length,
        phase: 'extract'
      });
      
      const contact = createContactFromEmail(result.email, result.context, {
        company: result.title || null,
        company_website: result.url,
        source: 'google_search',
        industry,
        keywords
      });
      
      if (contact) {
        scrapedContacts.push(contact);
      }
      
      await randomSleep(1000, 2000);
    }
    
    // ========== PHASE 3: VISIT TOP RESULTS FOR MORE EMAILS ==========
    if (scrapedContacts.length < maxResults) {
      progressCallback({ 
        status: 'Visiting top search results for more emails...', 
        profilesFound: emailResults.length, 
        profilesScraped: scrapedContacts.length,
        phase: 'visit'
      });
      
      // Get unique URLs from search results
      const uniqueUrls = [...new Set(emailResults.map(r => r.url))].slice(0, 5);
      
      for (let i = 0; i < uniqueUrls.length && scrapedContacts.length < maxResults; i++) {
        const url = uniqueUrls[i];
        
        progressCallback({ 
          status: `Visiting result ${i + 1}/${uniqueUrls.length}...`, 
          profilesFound: uniqueUrls.length, 
          profilesScraped: scrapedContacts.length,
          phase: 'visit'
        });
        
        try {
          const pageContacts = await extractEmailsFromPage(page, url, null);
          
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
        
        await randomSleep(2000, 4000);
      }
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
    
    await randomSleep(2000, 3000);
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
