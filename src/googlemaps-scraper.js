const { launchBrowser } = require('./browser-helper');
const { createClient } = require('@supabase/supabase-js');
const { extractEmails, filterBusinessEmails, getBestEmail, extractCompanyFromDomain } = require('./email-extractor');

/**
 * Generate potential website domains based on business name
 * @param {string} businessName - Name of the business
 * @returns {Array<string>} - Array of potential domain names
 */
function generatePotentialDomains(businessName) {
  if (!businessName) return [];
  
  const domains = [];
  const cleanName = businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .replace(/\s+/g, '') // Remove spaces
    .trim();
  
  if (cleanName.length > 0) {
    // Direct domain: businessname.com
    domains.push(`${cleanName}.com`);
    domains.push(`${cleanName}.co.za`); // South Africa TLD
    domains.push(`${cleanName}.net`);
    domains.push(`${cleanName}.org`);
    
    // With "car hire" or similar keywords removed
    const withoutKeywords = cleanName
      .replace(/carhire|carhire|rental|hire|services|group|pty|ltd|inc|llc/gi, '')
      .trim();
    
    if (withoutKeywords && withoutKeywords !== cleanName) {
      domains.push(`${withoutKeywords}.com`);
      domains.push(`${withoutKeywords}.co.za`);
    }
  }
  
  return domains;
}

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

function cleanPhoneNumber(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 9) return null;
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '+27' + cleaned.substring(1);
  }
  return cleaned;
}

function isMobileNumber(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('27')) {
    const prefix = cleaned.substring(2, 3);
    return ['6', '7', '8'].includes(prefix);
  }
  if (cleaned.startsWith('0')) {
    const prefix = cleaned.substring(1, 2);
    return ['6', '7', '8'].includes(prefix);
  }
  return false;
}

// ============================================
// WEBSITE ENRICHMENT FUNCTIONS
// ============================================

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

// Use centralized email extractor (already imported above)
// This function is kept for backward compatibility but now uses the shared extractor
function extractEmailsLocal(text, html = '') {
  // Use the centralized email extractor which handles filtering
  const allEmails = extractEmails(text, html);
  // Filter to business emails only
  return filterBusinessEmails(allEmails);
}

/**
 * Enrich business data by scraping its website
 * @param {Page} page - Playwright page instance
 * @param {string} websiteUrl - Website URL to scrape
 * @param {string} businessName - Name of the business
 * @param {Function} progressCallback - Progress callback
 * @returns {Object} - Enriched data with emails and description
 */
async function enrichFromWebsite(page, websiteUrl, businessName, progressCallback) {
  const enrichedData = {
    emails: [],
    description: '',
    additionalPhones: []
  };

  if (!websiteUrl) return enrichedData;

  try {
    // Normalize URL
    let url = websiteUrl;
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }
    url = url.replace(/\/$/, '');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomSleep(500, 800); // Small delay for page stability

    // Get meta description
    const metaDescription = await page.evaluate(() => {
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc?.content) return metaDesc.content;
      
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc?.content) return ogDesc.content;
      
      // Fallback: get first meaningful paragraph
      const paragraphs = Array.from(document.querySelectorAll('p'));
      for (const p of paragraphs) {
        const text = p.innerText?.trim();
        if (text && text.length > 50 && text.length < 500) {
          return text;
        }
      }
      
      return '';
    });

    enrichedData.description = metaDescription?.slice(0, 500) || '';

    // Collect text from homepage
    let allText = await page.evaluate(() => document.body.innerText || '');
    let allHtml = await page.evaluate(() => document.body.innerHTML || '');

    // Find and visit Contact page
    const contactLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const contactUrls = [];
      
      links.forEach(link => {
        const href = (link.href || '').toLowerCase();
        const text = (link.innerText || '').toLowerCase();
        
        if (href.includes('contact') || text.includes('contact') ||
            href.includes('get-in-touch') || text.includes('get in touch') ||
            href.includes('reach-us') || text.includes('reach us')) {
          if (link.href && !contactUrls.includes(link.href)) {
            contactUrls.push(link.href);
          }
        }
      });
      
      return contactUrls.slice(0, 2);
    });

    // Visit contact page if found
    if (contactLinks.length > 0) {
      try {
        await page.goto(contactLinks[0], { waitUntil: 'domcontentloaded', timeout: 15000 });
        await randomSleep(500, 800); // Small delay for page stability
        
        const contactText = await page.evaluate(() => document.body.innerText || '');
        const contactHtml = await page.evaluate(() => document.body.innerHTML || '');
        allText += '\n' + contactText;
        allHtml += '\n' + contactHtml;
      } catch (e) {
        // Contact page failed, continue with what we have
      }
    }

    // Also check for About page for better description and emails
    const aboutLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const aboutUrls = [];
      
      links.forEach(link => {
        const href = (link.href || '').toLowerCase();
        const text = (link.innerText || '').toLowerCase();
        
        if (href.includes('about') || text.includes('about') || text.includes('about us')) {
          if (link.href && !aboutUrls.includes(link.href)) {
            aboutUrls.push(link.href);
          }
        }
      });
      
      return aboutUrls.slice(0, 1);
    });
    
    // Also check for Team/Staff page (often has contact emails)
    const teamLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const teamUrls = [];
      
      links.forEach(link => {
        const href = (link.href || '').toLowerCase();
        const text = (link.innerText || '').toLowerCase();
        
        if (href.includes('team') || text.includes('team') || 
            href.includes('staff') || text.includes('staff') ||
            href.includes('people') || text.includes('people')) {
          if (link.href && !teamUrls.includes(link.href)) {
            teamUrls.push(link.href);
          }
        }
      });
      
      return teamUrls.slice(0, 1);
    });

    // Visit About page for description and emails
    if (aboutLinks.length > 0) {
      try {
        await page.goto(aboutLinks[0], { waitUntil: 'domcontentloaded', timeout: 15000 });
        await randomSleep(500, 800); // Small delay for page stability
        
        const aboutDesc = await page.evaluate(() => {
          const paragraphs = Array.from(document.querySelectorAll('p'));
          const longParagraphs = paragraphs
            .map(p => p.innerText?.trim())
            .filter(text => text && text.length > 100)
            .slice(0, 2);
          return longParagraphs.join(' ');
        });
        
        if (aboutDesc && aboutDesc.length > enrichedData.description.length) {
          enrichedData.description = aboutDesc.slice(0, 500);
        }
        
        const aboutText = await page.evaluate(() => document.body.innerText || '');
        const aboutHtml = await page.evaluate(() => document.body.innerHTML || '');
        allText += '\n' + aboutText;
        allHtml += '\n' + aboutHtml;
      } catch (e) {
        // About page failed, continue
      }
    }
    
    // Visit Team/Staff page for more emails
    if (teamLinks.length > 0) {
      try {
        await page.goto(teamLinks[0], { waitUntil: 'domcontentloaded', timeout: 15000 });
        await randomSleep(500, 800); // Small delay for page stability
        
        const teamText = await page.evaluate(() => document.body.innerText || '');
        const teamHtml = await page.evaluate(() => document.body.innerHTML || '');
        allText += '\n' + teamText;
        allHtml += '\n' + teamHtml;
      } catch (e) {
        // Team page failed, continue
      }
    }

    // Extract emails and phones from all collected text
    // Use centralized email extractor with business email filtering
    enrichedData.emails = extractEmails(allText, allHtml);
    // Filter to business emails only (excludes gmail, yahoo, etc.)
    enrichedData.emails = filterBusinessEmails(enrichedData.emails);
    enrichedData.additionalPhones = extractPhoneNumbers(allText);

  } catch (error) {
    console.log(`Website enrichment failed for ${businessName}: ${error.message}`);
  }

  return enrichedData;
}

// ============================================
// MAIN GOOGLE MAPS SCRAPER WITH AUTO-ENRICHMENT
// ============================================

async function runGoogleMapsScraper(searchQuery, maxResults = 50, industry = null, keywords = null, progressCallback, options = {}) {
  const scrapedBusinesses = [];
  let browser;
  
  // Options for enrichment
  const enableEnrichment = options.enableEnrichment !== false; // Default: true
  const checkCancellation = options.checkCancellation || (() => false);
  
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
      geolocation: { latitude: -26.2041, longitude: 28.0473 },
      permissions: ['geolocation']
    });
    
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    
    // ========== PHASE 1: COLLECT BUSINESSES FROM GOOGLE MAPS ==========
    
    // Detect if query is a domain/URL and convert to company name
    let processedQuery = searchQuery;
    const isDomainOrUrl = /^https?:\/\//.test(searchQuery) || /\.(com|co\.za|net|org|io|co|za|za\.com)/i.test(searchQuery);
    
    if (isDomainOrUrl) {
      // Extract company name from domain
      try {
        const urlObj = new URL(searchQuery.startsWith('http') ? searchQuery : `https://${searchQuery}`);
        const hostname = urlObj.hostname.replace('www.', '');
        const domainParts = hostname.split('.');
        
        // Get the main domain name (before TLD)
        let companyName = domainParts[0];
        
        // Handle .co.za domains
        if (hostname.includes('.co.za')) {
          companyName = hostname.split('.co.za')[0].split('.').pop();
        } else if (domainParts.length >= 2) {
          companyName = domainParts[domainParts.length - 2];
        }
        
        // Capitalize and clean up
        companyName = companyName.charAt(0).toUpperCase() + companyName.slice(1).replace(/[^a-zA-Z0-9]/g, ' ');
        
        processedQuery = companyName;
        progressCallback({ 
          status: `Detected domain "${searchQuery}", searching for company "${companyName}"...`, 
          profilesFound: 0, 
          profilesScraped: 0,
          phase: 'maps_search'
        });
      } catch (e) {
        // If URL parsing fails, try to extract from the query directly
        const domainMatch = searchQuery.match(/([a-zA-Z0-9-]+)\.(com|co\.za|net|org|io)/i);
        if (domainMatch) {
          processedQuery = domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1);
          progressCallback({ 
            status: `Detected domain, searching for "${processedQuery}"...`, 
            profilesFound: 0, 
            profilesScraped: 0,
            phase: 'maps_search'
          });
        }
      }
    } else {
      progressCallback({ 
        status: `Phase 1: Searching Google Maps for "${searchQuery}"...`, 
        profilesFound: 0, 
        profilesScraped: 0,
        phase: 'maps_search'
      });
    }
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(processedQuery)}/@-26.0,28.0,7z`;
    
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});
    // Small delay to let map tiles load
    await randomSleep(1000, 1500);
    
    progressCallback({ 
      status: 'Phase 1: Scrolling to collect business listings...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'maps_scroll'
    });
    
    // Scroll to collect businesses
    let scrollAttempts = 0;
    // Increase max scrolls for larger result sets - allow more scrolling for 100+ results
    const maxScrolls = Math.max(30, Math.ceil(maxResults / 3));
    let lastCount = 0;
    let noNewCount = 0;
    // Increase threshold - allow more attempts before giving up (Google Maps can be slow to load)
    const maxNoNewCount = 6;
    
    console.log(`Starting scroll collection: maxResults=${maxResults}, maxScrolls=${maxScrolls}, maxNoNewCount=${maxNoNewCount}`);
    
    while (scrollAttempts < maxScrolls && noNewCount < maxNoNewCount) {
      // Check for cancellation during scrolling
      if (checkCancellation()) {
        progressCallback({ 
          status: 'Scraping cancelled by user', 
          profilesFound: 0, 
          profilesScraped: 0,
          cancelled: true,
          phase: 'maps_scroll'
        });
        break;
      }
      
      const currentCount = await page.evaluate(() => {
        const items = document.querySelectorAll('[role="feed"] > div > div > a[href*="/maps/place/"]');
        return items.length;
      });
      
      progressCallback({ 
        status: `Phase 1: Found ${currentCount} businesses (target: ${maxResults}), scrolling for more...`, 
        profilesFound: currentCount, 
        profilesScraped: 0,
        phase: 'maps_scroll'
      });
      
      if (currentCount === lastCount) {
        noNewCount++;
        console.log(`No new businesses found (attempt ${noNewCount}/${maxNoNewCount}). Current count: ${currentCount}`);
      } else {
        noNewCount = 0;
        lastCount = currentCount;
        console.log(`Found ${currentCount} businesses so far (target: ${maxResults})`);
      }
      
      if (currentCount >= maxResults) {
        console.log(`Reached target of ${maxResults} businesses (found ${currentCount}), stopping scroll`);
        break;
      }
      
      // More aggressive scrolling - scroll both the feed and window
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
          // Also try scrolling the window
          window.scrollBy(0, 500);
        }
      });
      
      // Longer delay to allow Google Maps to load more results
      await randomSleep(2500, 3500);
      scrollAttempts++;
    }
    
    console.log(`Scroll collection complete: scrollAttempts=${scrollAttempts}/${maxScrolls}, noNewCount=${noNewCount}/${maxNoNewCount}`);
    
    // Get all business links
    const businessLinks = await page.evaluate(() => {
      const links = [];
      const items = document.querySelectorAll('[role="feed"] > div > div > a[href*="/maps/place/"]');
      items.forEach(item => {
        if (item.href && !links.includes(item.href)) links.push(item.href);
      });
      return links;
    });
    
    const uniqueLinks = [...new Set(businessLinks)];
    let linksToProcess = uniqueLinks.slice(0, maxResults);
    
    // If no results found and query was a domain, try searching with the original domain
    if (linksToProcess.length === 0 && isDomainOrUrl && processedQuery !== searchQuery) {
      progressCallback({ 
        status: `No results for "${processedQuery}", trying original domain "${searchQuery}"...`, 
        profilesFound: 0, 
        profilesScraped: 0,
        phase: 'maps_search'
      });
      
      // Try searching with the original domain
      const fallbackUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}/@-26.0,28.0,7z`;
      await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});
      // Small delay to let map tiles load
      await randomSleep(1000, 1500);
      
      // Try to get links again
      const fallbackLinks = await page.evaluate(() => {
        const links = [];
        const items = document.querySelectorAll('[role="feed"] > div > div > a[href*="/maps/place/"]');
        items.forEach(item => {
          if (item.href && !links.includes(item.href)) links.push(item.href);
        });
        return links;
      });
      
      if (fallbackLinks.length > 0) {
        linksToProcess = [...new Set(fallbackLinks)].slice(0, maxResults);
        processedQuery = searchQuery; // Use original query for display
      }
    }
    
    if (linksToProcess.length === 0) {
      throw new Error(`No businesses found on Google Maps for "${searchQuery}". Try searching with the company name or location instead of a domain/URL.`);
    }
    
    progressCallback({ 
      status: `Phase 1: Extracting details from ${linksToProcess.length} businesses...`, 
      profilesFound: linksToProcess.length, 
      profilesScraped: 0,
      phase: 'maps_extract'
    });
    
    // Collect basic data from Google Maps
    const businessesData = [];
    
    for (let i = 0; i < linksToProcess.length; i++) {
      // Check for cancellation before each business
      if (checkCancellation()) {
        progressCallback({ 
          status: 'Scraping cancelled by user', 
          profilesFound: linksToProcess.length, 
          profilesScraped: scrapedBusinesses.length,
          cancelled: true,
          phase: 'maps_extract'
        });
        break;
      }
      
      progressCallback({ 
        status: `Phase 1: Getting Maps data ${i + 1}/${linksToProcess.length}...`, 
        profilesFound: linksToProcess.length, 
        profilesScraped: i,
        phase: 'maps_extract'
      });
      
      try {
        await page.goto(linksToProcess[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
        await randomSleep(500, 800); // Small delay for page stability
        
        const businessData = await page.evaluate(() => {
          const getName = () => document.querySelector('h1')?.innerText?.trim() || '';
          
          const getPhone = () => {
            const phoneBtn = document.querySelector('[data-item-id*="phone"] [aria-label]');
            if (phoneBtn) {
              const label = phoneBtn.getAttribute('aria-label');
              if (label) {
                const match = label.match(/[\d\s\+\(\)-]{9,}/);
                if (match) return match[0].trim();
              }
            }
            const telLinks = document.querySelectorAll('a[href^="tel:"]');
            for (const link of telLinks) {
              const href = link.getAttribute('href');
              if (href) return href.replace('tel:', '').trim();
            }
            return '';
          };
          
          const getAddress = () => {
            const addressBtn = document.querySelector('[data-item-id*="address"]');
            if (addressBtn) {
              const label = addressBtn.getAttribute('aria-label');
              if (label) return label.replace('Address:', '').trim();
            }
            return '';
          };
          
          const getWebsite = () => {
            // Try multiple selectors for website button (Google Maps UI changes frequently)
            const selectors = [
              '[data-item-id*="authority"]',
              '[data-item-id*="website"]',
              'a[href^="http"][data-value="Website"]',
              'a[aria-label*="Website"]',
              'a[aria-label*="website"]',
              '[jsaction*="website"] a',
              'button[data-value="Website"] + a'
            ];
            
            for (const selector of selectors) {
              const element = document.querySelector(selector);
              if (element) {
                const link = element.querySelector('a') || element;
                if (link && link.href && link.href.startsWith('http')) {
                  return link.href;
                }
              }
            }
            
            // Also check for any external links in the business info panel
            const allLinks = document.querySelectorAll('a[href^="http"]');
            for (const link of allLinks) {
              const href = link.href;
              if (href && !href.includes('google.com') && !href.includes('maps.google.com') && 
                  !href.includes('plus.google.com') && !href.includes('facebook.com') &&
                  !href.includes('twitter.com') && !href.includes('instagram.com')) {
                // Likely the business website
                return href;
              }
            }
            
            return '';
          };
          
          const getEmailFromMapsPage = () => {
            // Sometimes emails are directly visible on the Maps page
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
            const pageText = document.body.innerText || '';
            const matches = pageText.match(emailRegex) || [];
            
            // Filter out common non-business emails
            const businessEmails = matches.filter(email => {
              const lower = email.toLowerCase();
              const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com'];
              return !personalDomains.some(domain => lower.includes(domain));
            });
            
            return businessEmails.length > 0 ? businessEmails[0] : '';
          };
          
          const getCategory = () => {
            const categoryBtn = document.querySelector('[jsaction*="category"]');
            return categoryBtn?.innerText?.trim() || '';
          };
          
          return {
            name: getName(),
            phone: getPhone(),
            address: getAddress(),
            website: getWebsite(),
            category: getCategory(),
            emailFromMaps: getEmailFromMapsPage() // Email found directly on Maps page
          };
        });
        
        if (businessData.name) {
          businessesData.push(businessData);
          console.log(`Collected Maps data for business ${i + 1}/${linksToProcess.length}: ${businessData.name}`);
        } else {
          console.log(`Warning: Business ${i + 1}/${linksToProcess.length} has no name, skipping`);
        }
      } catch (error) {
        console.log(`Error getting Maps data for business ${i + 1}: ${error.message}`);
      }
      
      await randomSleep(1000, 2000);
    }
    
    console.log(`Phase 1 complete: Collected ${businessesData.length} businesses from Maps (requested ${linksToProcess.length})`);
    
    // ========== PHASE 2: ENRICH WITH WEBSITE DATA ==========
    console.log(`Phase 2: Starting enrichment for ${businessesData.length} businesses`);
    if (enableEnrichment && businessesData.length > 0) {
      progressCallback({ 
        status: `Phase 2: Enriching ${businessesData.length} businesses with website data...`, 
        profilesFound: businessesData.length, 
        profilesScraped: 0,
        phase: 'enrich'
      });
      
      for (let i = 0; i < businessesData.length; i++) {
        const business = businessesData[i];
        
        try {
          progressCallback({ 
            status: `Phase 2: Enriching ${i + 1}/${businessesData.length} - ${business.name}...`, 
            profilesFound: businessesData.length, 
            profilesScraped: scrapedBusinesses.length,
            phase: 'enrich',
            currentBusiness: business.name
          });
          
          // Get enriched data from website
          let enrichedData = { emails: [], description: '', additionalPhones: [] };
          
          try {
            // If email found directly on Maps page, add it
            if (business.emailFromMaps) {
              enrichedData.emails.push(business.emailFromMaps);
            }
            
            // Try to enrich from website if available
            if (business.website) {
              try {
                const websiteData = await enrichFromWebsite(page, business.website, business.name, progressCallback);
                // Merge website emails with Maps page email
                enrichedData.emails = [...enrichedData.emails, ...websiteData.emails];
                enrichedData.description = websiteData.description || enrichedData.description;
                enrichedData.additionalPhones = [...enrichedData.additionalPhones, ...websiteData.additionalPhones];
              } catch (e) {
                console.log(`Enrichment failed for ${business.name} website ${business.website}: ${e.message}`);
                // Continue with Maps data only
              }
            } else if (!enrichedData.emails.length) {
              // No website listed AND no email found on Maps page
              // Try to find website by checking common domain patterns (only if no emails found yet)
              const potentialDomains = generatePotentialDomains(business.name);
              
              // Only try the most likely domain (.com)
              if (potentialDomains.length > 0) {
                try {
                  const testUrl = `https://${potentialDomains[0]}`;
                  // Quick check - shorter timeout
                  const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
                  
                  if (response && response.ok()) {
                    // Website exists! Extract emails (quick extraction only)
                    await randomSleep(500, 800); // Small delay for page content to load
                    const pageText = await page.evaluate(() => document.body.innerText || '');
                    const pageHtml = await page.evaluate(() => document.body.innerHTML || '');
                    const foundEmails = extractEmails(pageText, pageHtml);
                    const businessEmails = filterBusinessEmails(foundEmails);
                    enrichedData.emails = [...enrichedData.emails, ...businessEmails];
                  }
                } catch (e) {
                  // Website doesn't exist or failed, continue
                }
              }
            }
          } catch (e) {
            console.log(`Error during enrichment for ${business.name}: ${e.message}`);
            // Continue with Maps data only
          }
          
          // Remove duplicates and filter to business emails only
          enrichedData.emails = filterBusinessEmails([...new Set(enrichedData.emails.map(e => e.toLowerCase()))]);
          
          // Combine Google Maps data with website data
          const phone = cleanPhoneNumber(business.phone);
          const isMobile = isMobileNumber(phone);
          
          // Get best email (prefer business email) - use centralized function
          const primaryEmail = getBestEmail(enrichedData.emails) || null;
          
          // Combine description from Maps category + website
          let description = enrichedData.description || '';
          if (business.category && !description.includes(business.category)) {
            description = business.category + (description ? '. ' + description : '');
          }
          
          const completeRecord = {
            company: truncateField(business.name, 100),
            first_name: truncateField(business.name, 100),
            last_name: '',
            email: primaryEmail,
            phone_number: !isMobile ? phone : null,
            whatsapp_number: isMobile ? phone : null,
            mobile_number: isMobile ? phone : null,
            location: truncateField(business.address, 100),
            company_website: business.website || null,
            company_summary: description.slice(0, 500) || null,
            job_title: null,
            email_domain: primaryEmail ? truncateField(primaryEmail.split('@')[1], 100) : null,
            source: 'google_maps',
            email_verified: false,
            verification_status: primaryEmail ? 'unverified' : 'no_email',
            industry: truncateField(industry || business.category, 100),
            keywords: truncateField(keywords, 100),
            search_query: truncateField(searchQuery, 200) // Store original search query
          };
          
          scrapedBusinesses.push(completeRecord);
          console.log(`Added business ${i + 1}/${businessesData.length}: ${business.name} (Total: ${scrapedBusinesses.length})`);
          console.log(`  - search_query: "${completeRecord.search_query}"`);
          
        } catch (error) {
          // Even if enrichment completely fails, add the business with Maps data only
          console.log(`Error processing business ${i + 1} (${business.name}): ${error.message}. Adding with Maps data only.`);
          
          const phone = cleanPhoneNumber(business.phone);
          const isMobile = isMobileNumber(phone);
          
          scrapedBusinesses.push({
            company: truncateField(business.name, 100),
            first_name: truncateField(business.name, 100),
            last_name: '',
            email: business.emailFromMaps || null,
            phone_number: !isMobile ? phone : null,
            whatsapp_number: isMobile ? phone : null,
            mobile_number: isMobile ? phone : null,
            location: truncateField(business.address, 100),
            company_website: business.website || null,
            company_summary: truncateField(business.category, 100),
            job_title: null,
            email_domain: business.emailFromMaps ? truncateField(business.emailFromMaps.split('@')[1], 100) : null,
            source: 'google_maps',
            email_verified: false,
            verification_status: business.emailFromMaps ? 'unverified' : 'no_email',
            industry: truncateField(industry || business.category, 100),
            keywords: truncateField(keywords, 100),
            search_query: truncateField(searchQuery, 200) // Store original search query
          });
          console.log(`Added business ${i + 1}/${businessesData.length} (fallback): ${business.name} (Total: ${scrapedBusinesses.length})`);
        }
        
        // Reduced delay between enrichments
        await randomSleep(400, 700);
      }
      console.log(`Phase 2: Enrichment complete. Total businesses in scrapedBusinesses: ${scrapedBusinesses.length}`);
    } else {
      // No enrichment - just process Maps data
      console.log(`Phase 2: Enrichment disabled. Processing ${businessesData.length} businesses without enrichment.`);
      for (const business of businessesData) {
        const phone = cleanPhoneNumber(business.phone);
        const isMobile = isMobileNumber(phone);
        
        scrapedBusinesses.push({
          company: truncateField(business.name, 100),
          first_name: truncateField(business.name, 100),
          last_name: '',
          email: null,
          phone_number: !isMobile ? phone : null,
          whatsapp_number: isMobile ? phone : null,
          mobile_number: isMobile ? phone : null,
          location: truncateField(business.address, 100),
          company_website: business.website || null,
          company_summary: truncateField(business.category, 100),
          job_title: null,
          email_domain: null,
          source: 'google_maps',
          email_verified: false,
          verification_status: 'no_email',
          industry: truncateField(industry || business.category, 100),
          keywords: truncateField(keywords, 100),
          search_query: truncateField(searchQuery, 200) // Store original search query
        });
      }
      console.log(`Phase 2: No enrichment. Total businesses in scrapedBusinesses: ${scrapedBusinesses.length}`);
    }
    
    console.log(`Before Phase 3: scrapedBusinesses.length = ${scrapedBusinesses.length}, businessesData.length = ${businessesData.length}`);
    
    // ========== PHASE 3: SAVE TO DATABASE ==========
    if (scrapedBusinesses.length > 0) {
      progressCallback({ 
        status: `Phase 3: Saving ${scrapedBusinesses.length} businesses to database...`, 
        profilesFound: linksToProcess.length, 
        profilesScraped: scrapedBusinesses.length,
        phase: 'save'
      });
      
      // Remove duplicates by company name first
      const uniqueByCompany = [...new Map(scrapedBusinesses.map(b => [b.company, b])).values()];
      
      // Then remove duplicates by email (for upsert operations)
      // Keep the first occurrence of each email
      const seenEmails = new Set();
      const uniqueByEmail = [];
      const duplicatesByEmail = [];
      
      for (const business of uniqueByCompany) {
        if (business.email) {
          const emailLower = business.email.toLowerCase();
          if (seenEmails.has(emailLower)) {
            duplicatesByEmail.push(business);
          } else {
            seenEmails.add(emailLower);
            uniqueByEmail.push(business);
          }
        } else {
          uniqueByEmail.push(business);
        }
      }
      
      console.log(`Deduplication: ${scrapedBusinesses.length} total -> ${uniqueByCompany.length} by company -> ${uniqueByEmail.length} by email (${duplicatesByEmail.length} duplicates removed)`);
      
      // Separate records with emails (can upsert) from those without (must insert)
      const withEmail = uniqueByEmail.filter(b => b.email);
      const withoutEmail = uniqueByEmail.filter(b => !b.email);
      
      // Upsert records with email
      if (withEmail.length > 0) {
        // Debug: Log first record to verify search_query is included
        if (withEmail.length > 0) {
          console.log(`Saving ${withEmail.length} contacts with email. First record search_query: "${withEmail[0].search_query}"`);
        }
        
        const { error: upsertError } = await supabase
          .from('contacts')
          .upsert(withEmail, { onConflict: 'email' });
        
        if (upsertError) {
          console.error('Supabase upsert error:', upsertError);
        } else {
          console.log(`Successfully upserted ${withEmail.length} contacts with search_query field`);
        }
      }
      
      // Insert records without email
      if (withoutEmail.length > 0) {
        const { error: insertError } = await supabase
          .from('contacts')
          .insert(withoutEmail);
        
        if (insertError) {
          console.error('Supabase insert error:', insertError);
        }
      }
      
      console.log(`Successfully saved ${uniqueByEmail.length} businesses (${withEmail.length} with emails)`);
    }
    
    // Calculate stats
    const emailCount = scrapedBusinesses.filter(b => b.email).length;
    const phoneCount = scrapedBusinesses.filter(b => b.phone_number || b.mobile_number).length;
    
    console.log(`Final count before return: scrapedBusinesses.length = ${scrapedBusinesses.length}`);
    
    progressCallback({ 
      status: `Complete! Found and saved ${scrapedBusinesses.length} businesses. ${emailCount} with emails, ${phoneCount} with phones.`, 
      profilesFound: linksToProcess.length, 
      profilesScraped: scrapedBusinesses.length,
      phase: 'complete',
      completed: true,
      stats: {
        total: scrapedBusinesses.length,
        withEmail: emailCount,
        withPhone: phoneCount
      }
    });
    
    await randomSleep(500, 1000); // Reduced final delay
    await browser.close();
    
    console.log(`✓ Google Maps scraper returning ${scrapedBusinesses.length} businesses to main process`);
    console.log(`Business names: ${scrapedBusinesses.map(b => b.company || b.first_name || 'Unknown').join(', ')}`);
    return scrapedBusinesses;
    
  } catch (error) {
    progressCallback({ 
      status: `Error: ${error.message}`, 
      profilesFound: 0, 
      profilesScraped: scrapedBusinesses.length,
      phase: 'error',
      error: true
    });
    if (browser) await browser.close();
    throw error;
  }
}

module.exports = { runGoogleMapsScraper };