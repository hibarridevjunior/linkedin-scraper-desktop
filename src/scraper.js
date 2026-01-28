const { launchBrowser } = require('./browser-helper');
const { createClient } = require('@supabase/supabase-js');
const { extractEmails, filterBusinessEmails, createContactFromEmail } = require('./email-extractor');

// Supabase configuration
const SUPABASE_URL = 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  const first = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const last = lastName.toLowerCase().replace(/[^a-z]/g, '');
  
  if (!first || !domain) return [];
  
  const patterns = [
    `${first}.${last}@${domain}`,
    `${first}@${domain}`,
    `${first}${last}@${domain}`,
    `${first.charAt(0)}${last}@${domain}`,
    `${first}_${last}@${domain}`,
    `${first}-${last}@${domain}`,
  ];
  
  return patterns.filter(email => email.includes('@') && !email.includes('undefined'));
}

function randomSleep(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
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
        jobTitle = headline.split('·')[0]?.trim() || '';
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
 * Search LinkedIn by keywords (people search)
 * @param {Page} page - Playwright page instance
 * @param {string} keywords - Search keywords (e.g., "software engineer", "marketing manager")
 * @param {number} maxProfiles - Maximum profiles to collect
 * @param {Function} progressCallback - Progress callback
 * @returns {Array<string>} - Array of profile URLs
 */
async function searchLinkedInByKeywords(page, keywords, maxProfiles, progressCallback, checkCancellation = null, location = null) {
  // Build search query with location if provided
  let searchQuery = keywords;
  if (location && typeof location === 'string' && location.trim()) {
    const locationTrimmed = location.trim();
    searchQuery = `${keywords} ${locationTrimmed}`;
    progressCallback({ status: `Searching LinkedIn for "${keywords}" in "${locationTrimmed}"...`, profilesFound: 0, profilesScraped: 0 });
  } else {
    progressCallback({ status: `Searching LinkedIn for "${keywords}"...`, profilesFound: 0, profilesScraped: 0 });
  }
  
  // LinkedIn people search URL
  // For location filtering, we add it to keywords for now (LinkedIn's geoUrn requires location IDs)
  let searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchQuery)}`;
  
  // Try to add location filter if location is provided separately (not in keywords)
  // Note: LinkedIn uses geoUrn with location IDs, but we'll use keyword approach for simplicity
  console.log(`Searching LinkedIn with URL: ${searchUrl}`);
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for page to load - try multiple possible selectors
  await page.waitForSelector('.search-results-container, .reusable-search__result-container, .search-results, [data-chameleon-result-urn]', { timeout: 20000 }).catch(() => {
    console.log('Warning: Search results container not found, continuing anyway...');
  });
  // Reduced delay - waitForSelector already ensures page is ready
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  
  const profileUrls = [];
  let scrollAttempts = 0;
  let noNewCount = 0;
  
  while (profileUrls.length < maxProfiles && scrollAttempts < 20 && noNewCount < 4) {
    // Check for cancellation
    if (checkCancellation && checkCancellation()) {
      break;
    }
    
    progressCallback({ 
      status: `Collecting profiles (${profileUrls.length} found)...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    // Scroll to load more results - more aggressive scrolling for keyword searches
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, 500);
        // Also try scrolling the results container if it exists
        const resultsContainer = document.querySelector('.scaffold-finite-scroll__content, .search-results-container, [role="main"]');
        if (resultsContainer) {
          resultsContainer.scrollTop += 500;
        }
      });
      await randomSleep(300, 500); // Slightly longer delay to let content load
    }
    await randomSleep(1500, 2000); // Wait longer for LinkedIn to load more results
    
    const beforeCount = profileUrls.length;
    const newUrls = await page.evaluate(() => {
      const urls = [];
      const seen = new Set();
      
      // Try multiple selectors for LinkedIn search results (updated for current LinkedIn UI)
      const selectors = [
        '.reusable-search__result-container a[href*="/in/"]',
        '.search-result__info a[href*="/in/"]',
        '.entity-result__item a[href*="/in/"]',
        '.entity-result a[href*="/in/"]',
        '.search-result a[href*="/in/"]',
        '.entity-result__title-text a[href*="/in/"]',
        '.base-search__result a[href*="/in/"]',
        '.search-result__wrapper a[href*="/in/"]',
        'a[href*="/in/"][href*="search"]',
        'a[href*="/in/"]' // Catch-all for any profile link
      ];
      
      // Also try to find all links first, then filter
      const allLinks = document.querySelectorAll('a[href*="/in/"]');
      console.log(`Found ${allLinks.length} total links with /in/ in the page`);
      
      for (const selector of selectors) {
        try {
          const links = document.querySelectorAll(selector);
          console.log(`Selector "${selector}" found ${links.length} links`);
          links.forEach(link => {
            if (link?.href && link.href.includes('/in/')) {
              try {
                // Extract clean profile URL
                const urlMatch = link.href.match(/\/in\/([^\/\?]+)/);
                if (urlMatch && urlMatch[1]) {
                  const profileId = urlMatch[1];
                  // Skip if it's a search page, miniprofile, or other non-profile pages
                  if (profileId && 
                      !profileId.includes('search') && 
                      !profileId.includes('miniprofile') &&
                      !profileId.includes('pub') &&
                      profileId.length > 2) {
                    const cleanUrl = `https://www.linkedin.com/in/${profileId}`;
                    if (!seen.has(cleanUrl)) {
                      seen.add(cleanUrl);
                      urls.push(cleanUrl);
                    }
                  }
                }
              } catch (e) {
                // Skip invalid URLs
              }
            }
          });
        } catch (e) {
          // Continue with next selector
        }
      }
      
      const uniqueUrls = [...new Set(urls)];
      console.log(`Extracted ${uniqueUrls.length} unique profile URLs from page`);
      return uniqueUrls;
    });
    
    // Add new URLs that aren't already in our list
    let addedCount = 0;
    for (const url of newUrls) {
      if (!profileUrls.includes(url)) {
        profileUrls.push(url);
        addedCount++;
      }
    }
    console.log(`Added ${addedCount} new unique profile URLs`);
    
    console.log(`Found ${newUrls.length} new profile URLs, total: ${profileUrls.length}`);
    
    // If we found new URLs, reset the noNewCount
    if (profileUrls.length === beforeCount) {
      noNewCount++;
      console.log(`No new profiles found (attempt ${noNewCount}/6)`);
    } else {
      noNewCount = 0;
    }
    
    // If we've reached maxProfiles, we can stop early
    if (profileUrls.length >= maxProfiles) {
      console.log(`Reached target of ${maxProfiles} profiles, stopping scroll`);
      break;
    }
    
    scrollAttempts++;
  }
  
  console.log(`Keyword search completed: Found ${profileUrls.length} profile URLs (target: ${maxProfiles})`);
  
  // Return all found profiles up to maxProfiles
  const finalUrls = profileUrls.slice(0, maxProfiles);
  console.log(`Returning ${finalUrls.length} profile URLs to scrape`);
  
  return finalUrls;
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
    await randomSleep(2000, 3000);
    
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
  
  await page.goto(peoplePageUrl, { waitUntil: 'networkidle', timeout: 60000 });
  // No extra delay needed - networkidle already waits for page to be ready
  
  return slugMatch[1];
}

async function collectProfilesFromPeoplePage(page, maxProfiles, progressCallback, checkCancellation = null) {
  const profileUrls = [];
  let scrollAttempts = 0;
  let noNewCount = 0;
  
  await page.waitForSelector('.org-people-profile-card, .scaffold-finite-scroll__content', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); // Smart wait
  
  while (profileUrls.length < maxProfiles && scrollAttempts < 20 && noNewCount < 4) {
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
      await randomSleep(100, 200); // Reduced delay
    }
    await randomSleep(300, 500); // Reduced delay
    
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

async function runLinkedInScraper(companyName, companyDomain, maxProfiles = 20, jobTitles = null, industry = null, keywords = null, progressCallback, searchMode = 'company', checkCancellation = null, location = null) {
  const scrapedProfiles = [];
  let browser;
  
  try {
    progressCallback({ status: 'Launching browser...', profilesFound: 0, profilesScraped: 0 });
    
    // Use launchBrowser helper which handles bundled browser path
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
    
    progressCallback({ status: 'Opening LinkedIn...', profilesFound: 0, profilesScraped: 0 });
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 60000 });
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
    }
    
    let profileUrls = [];
    
    // Choose search mode: company or keyword
    if (searchMode === 'keyword' && keywords) {
      // Search by keywords
      const location = arguments[8] || null; // Get location parameter (9th argument)
      profileUrls = await searchLinkedInByKeywords(page, keywords, maxProfiles, progressCallback, checkCancellation, location);
      
      if (profileUrls.length === 0) {
        // Provide more helpful error message
        throw new Error(`No profiles found matching "${keywords}". Try:\n- Using different keywords\n- Removing location (e.g., just "software engineer")\n- Using company name instead\n- Checking if you're logged into LinkedIn`);
      }
    } else {
      // Search by company (default)
      await goToCompanyPeoplePage(page, companyName, progressCallback);
      profileUrls = await collectProfilesFromPeoplePage(page, maxProfiles, progressCallback, checkCancellation);
      
      if (profileUrls.length === 0) {
        throw new Error(`No profiles found on company page for "${companyName}". The company may not have public employee listings on LinkedIn.`);
      }
    }
    
    progressCallback({ 
      status: `Scraping ${profileUrls.length} profiles...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    for (let i = 0; i < profileUrls.length; i++) {
      // Check for cancellation before each profile
      if (checkCancellation && checkCancellation()) {
        progressCallback({ 
          status: 'Scraping cancelled by user', 
          profilesFound: profileUrls.length, 
          profilesScraped: scrapedProfiles.length,
          cancelled: true
        });
        break;
      }
      
      progressCallback({ 
        status: `Scraping ${i + 1}/${profileUrls.length}...`, 
        profilesFound: profileUrls.length, 
        profilesScraped: scrapedProfiles.length 
      });
      
      try {
        await page.goto(profileUrls[i], { waitUntil: 'networkidle', timeout: 30000 });
        // No extra delay needed - networkidle already waits
        
        const profileData = await extractProfileData(page);
        
        // For keyword searches, try to extract company from profile if not provided
        if (searchMode === 'keyword' && !companyDomain && profileData?.company) {
          // Try to extract domain from company name
          const companyNameFromProfile = profileData.company;
          // This is a fallback - we don't have the actual domain
        }
        
        if (profileData?.fullName) {
          // Check job title filter
          if (jobTitles?.length > 0 && !matchesJobTitle(profileData, jobTitles)) {
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
          const profilePageContent = await page.evaluate(() => {
            return {
              text: document.body.innerText || '',
              html: document.body.innerHTML || ''
            };
          });
          
          const profileEmails = extractEmails(profilePageContent.text, profilePageContent.html);
          const businessEmails = filterBusinessEmails(profileEmails);
          
          // Use extracted email if found, otherwise generate
          let primaryEmail = businessEmails.length > 0 ? businessEmails[0] : null;
          
          // Extract company domain from profile if available (for keyword searches)
          let finalCompanyDomain = companyDomain;
          if (searchMode === 'keyword' && profileData?.company && !finalCompanyDomain) {
            // Try to infer domain from company name (fallback)
            const inferredDomain = profileData.company.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '') + '.com';
            finalCompanyDomain = inferredDomain;
          }
          
          // For keyword searches without domain, try to extract from email if found
          if (searchMode === 'keyword' && !finalCompanyDomain && primaryEmail) {
            finalCompanyDomain = extractDomain(primaryEmail);
          }
          
          if (!primaryEmail && finalCompanyDomain) {
            // Fallback to generated email (only if we have a domain)
            const emailVariations = generateEmails(firstName, lastName, finalCompanyDomain);
            primaryEmail = emailVariations[0] || '';
          }
          
          // Filter by location if provided (for company searches)
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
          
          // Save profile if we have a name (email is optional but preferred)
          if (firstName || lastName) {
            // Only add email if it's valid and not personal
            const validEmail = primaryEmail && !isPersonalEmail(primaryEmail) ? primaryEmail : null;
            
            // Build search query for this contact
            let searchQueryForContact = '';
            if (searchMode === 'keyword' && keywords) {
              searchQueryForContact = location && typeof location === 'string' && location.trim() 
                ? `${keywords} ${location.trim()}` 
                : keywords;
            } else if (searchMode === 'company' && companyName) {
              searchQueryForContact = companyName;
            }
            
            scrapedProfiles.push({
              first_name: truncateField(firstName, 100),
              last_name: truncateField(lastName, 100),
              email: validEmail,
              company: truncateField(profileData.company || companyName || 'Unknown', 100),
              job_title: truncateField(profileData.jobTitle, 100),
              location: truncateField(profileData.location, 100),
              email_domain: validEmail ? truncateField(extractDomain(validEmail), 100) : null,
              source: 'linkedin',
              email_verified: false,
              verification_status: validEmail ? 'unverified' : 'no_email',
              industry: truncateField(industry, 100),
              keywords: truncateField(keywords, 100),
              linkedin_url: profileUrls[i], // URLs can be longer, but this field might not have a limit
              search_query: truncateField(searchQueryForContact, 200) // Store original search query
            });
          } else {
            console.log(`Skipping profile ${i + 1}: No name found`);
          }
        }
      } catch (error) {
        console.log(`Error scraping profile ${i + 1}: ${error.message}`);
      }
      
      // Reduced delay between profiles
      await randomSleep(400, 700);
    }
    
    // Save to Supabase
    console.log(`Total profiles scraped: ${scrapedProfiles.length} out of ${profileUrls.length} profile URLs`);
    if (scrapedProfiles.length > 0) {
      progressCallback({ 
        status: `Saving ${scrapedProfiles.length} contacts to database...`, 
        profilesFound: profileUrls.length, 
        profilesScraped: scrapedProfiles.length 
      });
      
      // Remove duplicates by email (or LinkedIn URL if no email)
      const uniqueProfiles = [];
      const seenEmails = new Set();
      const seenUrls = new Set();
      
      for (const profile of scrapedProfiles) {
        if (profile.email) {
          // Deduplicate by email
          if (!seenEmails.has(profile.email.toLowerCase())) {
            seenEmails.add(profile.email.toLowerCase());
            uniqueProfiles.push(profile);
          }
        } else if (profile.linkedin_url) {
          // Deduplicate by LinkedIn URL if no email
          if (!seenUrls.has(profile.linkedin_url)) {
            seenUrls.add(profile.linkedin_url);
            uniqueProfiles.push(profile);
          }
        } else {
          // Fallback: deduplicate by name + company
          const key = `${profile.first_name}_${profile.last_name}_${profile.company}`.toLowerCase();
          if (!seenUrls.has(key)) {
            seenUrls.add(key);
            uniqueProfiles.push(profile);
          }
        }
      }
      
      const { data, error } = await supabase
        .from('contacts')
        .upsert(uniqueProfiles, { 
          onConflict: 'email',
          ignoreDuplicates: true 
        });
      
      if (error) {
        console.error('Supabase save error:', error);
        throw new Error(`Failed to save contacts: ${error.message}`);
      } else {
        console.log(`Successfully saved ${uniqueProfiles.length} unique contacts (${uniqueProfiles.filter(p => p.email).length} with emails)`);
      }
    }
    
    progressCallback({ 
      status: `Complete! ${scrapedProfiles.length} contacts saved.`, 
      profilesFound: profileUrls.length, 
      profilesScraped: scrapedProfiles.length,
      completed: true
    });
    
    await randomSleep(500, 1000); // Reduced final delay
    await browser.close();
    
    return scrapedProfiles;
    
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