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

async function goToCompanyPeoplePage(page, companyName, progressCallback) {
  progressCallback({ status: `Searching for ${companyName}...`, profilesFound: 0, profilesScraped: 0 });
  
  const searchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  await page.waitForSelector('.search-results-container', { timeout: 20000 }).catch(() => {});
  await randomSleep(3000, 4000);
  
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
  
  await page.goto(peoplePageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomSleep(3000, 5000);
  
  return slugMatch[1];
}

async function collectProfilesFromPeoplePage(page, maxProfiles, progressCallback) {
  const profileUrls = [];
  let scrollAttempts = 0;
  let noNewCount = 0;
  
  await page.waitForSelector('.org-people-profile-card, .scaffold-finite-scroll__content', { timeout: 15000 }).catch(() => {});
  await randomSleep(2000, 3000);
  
  while (profileUrls.length < maxProfiles && scrollAttempts < 20 && noNewCount < 4) {
    progressCallback({ 
      status: `Collecting profiles (${profileUrls.length} found)...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    // Scroll in smaller increments for more natural behavior
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await randomSleep(200, 400);
    }
    await randomSleep(1000, 1500);
    
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

async function runLinkedInScraper(companyName, companyDomain, maxProfiles = 20, jobTitles = null, industry = null, keywords = null, progressCallback) {
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
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await randomSleep(2000, 3000);
    
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
      await randomSleep(2000, 3000);
    }
    
    await goToCompanyPeoplePage(page, companyName, progressCallback);
    const profileUrls = await collectProfilesFromPeoplePage(page, maxProfiles, progressCallback);
    
    if (profileUrls.length === 0) {
      throw new Error('No profiles found on company page');
    }
    
    progressCallback({ 
      status: `Scraping ${profileUrls.length} profiles...`, 
      profilesFound: profileUrls.length, 
      profilesScraped: 0 
    });
    
    for (let i = 0; i < profileUrls.length; i++) {
      progressCallback({ 
        status: `Scraping ${i + 1}/${profileUrls.length}...`, 
        profilesFound: profileUrls.length, 
        profilesScraped: scrapedProfiles.length 
      });
      
      try {
        await page.goto(profileUrls[i], { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(2000, 3500);
        
        const profileData = await extractProfileData(page);
        
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
          
          if (!primaryEmail) {
            // Fallback to generated email
            const emailVariations = generateEmails(firstName, lastName, companyDomain);
            primaryEmail = emailVariations[0] || '';
          }
          
          if (primaryEmail && !isPersonalEmail(primaryEmail)) {
            scrapedProfiles.push({
              first_name: firstName,
              last_name: lastName,
              email: primaryEmail,
              company: profileData.company || companyName,
              job_title: profileData.jobTitle || null,
              location: profileData.location || null,
              email_domain: extractDomain(primaryEmail),
              source: 'linkedin',
              email_verified: false,
              verification_status: 'unverified',
              industry: industry || null,
              keywords: keywords || null,
              linkedin_url: profileUrls[i]
            });
          }
        }
      } catch (error) {
        console.log(`Error scraping profile ${i + 1}: ${error.message}`);
      }
      
      // Random delay between profiles
      await randomSleep(1500, 2500);
    }
    
    // Save to Supabase
    if (scrapedProfiles.length > 0) {
      progressCallback({ 
        status: `Saving ${scrapedProfiles.length} contacts to database...`, 
        profilesFound: profileUrls.length, 
        profilesScraped: scrapedProfiles.length 
      });
      
      // Remove duplicates by email
      const uniqueProfiles = [...new Map(scrapedProfiles.map(p => [p.email, p])).values()];
      
      const { data, error } = await supabase
        .from('contacts')
        .upsert(uniqueProfiles, { 
          onConflict: 'email',
          ignoreDuplicates: true 
        });
      
      if (error) {
        console.error('Supabase save error:', error);
      } else {
        console.log(`Successfully saved ${uniqueProfiles.length} contacts`);
      }
    }
    
    progressCallback({ 
      status: `Complete! ${scrapedProfiles.length} contacts saved.`, 
      profilesFound: profileUrls.length, 
      profilesScraped: scrapedProfiles.length,
      completed: true
    });
    
    await randomSleep(2000, 3000);
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