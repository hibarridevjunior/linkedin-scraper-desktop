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
    await randomSleep(1500, 2500);

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
        await randomSleep(1000, 2000);
        
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
        await randomSleep(1000, 2000);
        
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
        await randomSleep(1000, 2000);
        
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
    progressCallback({ 
      status: `Phase 1: Searching Google Maps for "${searchQuery}"...`, 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'maps_search'
    });
    
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}/@-26.0,28.0,7z`;
    
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomSleep(3000, 5000);
    
    await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});
    await randomSleep(2000, 3000);
    
    progressCallback({ 
      status: 'Phase 1: Scrolling to collect business listings...', 
      profilesFound: 0, 
      profilesScraped: 0,
      phase: 'maps_scroll'
    });
    
    // Scroll to collect businesses
    let scrollAttempts = 0;
    const maxScrolls = Math.min(20, Math.ceil(maxResults / 5));
    let lastCount = 0;
    let noNewCount = 0;
    
    while (scrollAttempts < maxScrolls && noNewCount < 3) {
      const currentCount = await page.evaluate(() => {
        const items = document.querySelectorAll('[role="feed"] > div > div > a[href*="/maps/place/"]');
        return items.length;
      });
      
      progressCallback({ 
        status: `Phase 1: Found ${currentCount} businesses, scrolling for more...`, 
        profilesFound: currentCount, 
        profilesScraped: 0,
        phase: 'maps_scroll'
      });
      
      if (currentCount === lastCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
        lastCount = currentCount;
      }
      
      if (currentCount >= maxResults) break;
      
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
      });
      
      await randomSleep(2000, 3000);
      scrollAttempts++;
    }
    
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
    const linksToProcess = uniqueLinks.slice(0, maxResults);
    
    progressCallback({ 
      status: `Phase 1: Extracting details from ${linksToProcess.length} businesses...`, 
      profilesFound: linksToProcess.length, 
      profilesScraped: 0,
      phase: 'maps_extract'
    });
    
    // Collect basic data from Google Maps
    const businessesData = [];
    
    for (let i = 0; i < linksToProcess.length; i++) {
      progressCallback({ 
        status: `Phase 1: Getting Maps data ${i + 1}/${linksToProcess.length}...`, 
        profilesFound: linksToProcess.length, 
        profilesScraped: i,
        phase: 'maps_extract'
      });
      
      try {
        await page.goto(linksToProcess[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(2000, 3500);
        await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});
        
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
        }
      } catch (error) {
        console.log(`Error getting Maps data for business ${i + 1}: ${error.message}`);
      }
      
      await randomSleep(1000, 2000);
    }
    
    // ========== PHASE 2: ENRICH WITH WEBSITE DATA ==========
    if (enableEnrichment && businessesData.length > 0) {
      progressCallback({ 
        status: `Phase 2: Enriching ${businessesData.length} businesses with website data...`, 
        profilesFound: businessesData.length, 
        profilesScraped: 0,
        phase: 'enrich'
      });
      
      for (let i = 0; i < businessesData.length; i++) {
        const business = businessesData[i];
        
        progressCallback({ 
          status: `Phase 2: Enriching ${i + 1}/${businessesData.length} - ${business.name}...`, 
          profilesFound: businessesData.length, 
          profilesScraped: scrapedBusinesses.length,
          phase: 'enrich',
          currentBusiness: business.name
        });
        
        // Get enriched data from website
        let enrichedData = { emails: [], description: '', additionalPhones: [] };
        
        // If email found directly on Maps page, add it
        if (business.emailFromMaps) {
          enrichedData.emails.push(business.emailFromMaps);
        }
        
        // Try to enrich from website if available
        if (business.website) {
          const websiteData = await enrichFromWebsite(page, business.website, business.name, progressCallback);
          // Merge website emails with Maps page email
          enrichedData.emails = [...enrichedData.emails, ...websiteData.emails];
          enrichedData.description = websiteData.description || enrichedData.description;
          enrichedData.additionalPhones = [...enrichedData.additionalPhones, ...websiteData.additionalPhones];
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
                await randomSleep(1000, 1500);
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
          company: business.name,
          first_name: business.name,
          last_name: '',
          email: primaryEmail,
          phone_number: !isMobile ? phone : null,
          whatsapp_number: isMobile ? phone : null,
          mobile_number: isMobile ? phone : null,
          location: business.address || null,
          company_website: business.website || null,
          company_summary: description.slice(0, 500) || null,
          job_title: null,
          email_domain: primaryEmail ? primaryEmail.split('@')[1] : null,
          source: 'google_maps',
          email_verified: false,
          verification_status: primaryEmail ? 'unverified' : 'no_email',
          industry: industry || business.category || null,
          keywords: keywords || null
        };
        
        scrapedBusinesses.push(completeRecord);
        
        // Small delay between enrichments
        await randomSleep(1000, 2000);
      }
    } else {
      // No enrichment - just process Maps data
      for (const business of businessesData) {
        const phone = cleanPhoneNumber(business.phone);
        const isMobile = isMobileNumber(phone);
        
        scrapedBusinesses.push({
          company: business.name,
          first_name: business.name,
          last_name: '',
          email: null,
          phone_number: !isMobile ? phone : null,
          whatsapp_number: isMobile ? phone : null,
          mobile_number: isMobile ? phone : null,
          location: business.address || null,
          company_website: business.website || null,
          company_summary: business.category || null,
          job_title: null,
          email_domain: null,
          source: 'google_maps',
          email_verified: false,
          verification_status: 'no_email',
          industry: industry || business.category || null,
          keywords: keywords || null
        });
      }
    }
    
    // ========== PHASE 3: SAVE TO DATABASE ==========
    if (scrapedBusinesses.length > 0) {
      progressCallback({ 
        status: `Phase 3: Saving ${scrapedBusinesses.length} businesses to database...`, 
        profilesFound: linksToProcess.length, 
        profilesScraped: scrapedBusinesses.length,
        phase: 'save'
      });
      
      // Remove duplicates by company name
      const uniqueBusinesses = [...new Map(scrapedBusinesses.map(b => [b.company, b])).values()];
      
      // Separate records with emails (can upsert) from those without (must insert)
      const withEmail = uniqueBusinesses.filter(b => b.email);
      const withoutEmail = uniqueBusinesses.filter(b => !b.email);
      
      // Upsert records with email
      if (withEmail.length > 0) {
        const { error: upsertError } = await supabase
          .from('contacts')
          .upsert(withEmail, { onConflict: 'email' });
        
        if (upsertError) {
          console.error('Supabase upsert error:', upsertError);
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
      
      console.log(`Successfully saved ${uniqueBusinesses.length} businesses (${withEmail.length} with emails)`);
    }
    
    // Calculate stats
    const emailCount = scrapedBusinesses.filter(b => b.email).length;
    const phoneCount = scrapedBusinesses.filter(b => b.phone_number || b.mobile_number).length;
    
    progressCallback({ 
      status: `Complete! ${scrapedBusinesses.length} businesses saved. ${emailCount} with emails, ${phoneCount} with phones.`, 
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
    
    await randomSleep(2000, 3000);
    await browser.close();
    
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