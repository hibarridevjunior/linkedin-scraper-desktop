/**
 * Unified Email Scraper Service
 * 
 * Orchestrates email scraping from multiple sources:
 * - LinkedIn (company pages & profiles)
 * - Google Search results
 * - Google Maps business listings
 * - Individual company websites
 * 
 * Handles deduplication, progress reporting, and error handling
 */

const { runLinkedInScraper } = require('./scraper');
const { runGoogleSearchScraper } = require('./google-search-scraper');
const { runGoogleMapsScraper } = require('./googlemaps-scraper');
const { runWebsiteScraper, runBulkWebsiteScraper } = require('./website-scraper');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/** Max results per source for unified email scrape (bulk up to 2,500). */
const MAX_RESULTS_PER_SOURCE = 2500;

/**
 * Build list of jobs for unified email scrape. One job per enabled source.
 * Main process uses this to build the queue; no parallel Google or LinkedIn.
 * @param {Object} config - { query, sources: { linkedin, googleSearch, googleMaps, websites }, maxResultsPerSource, industry, keywords }
 * @returns {Array<{ type: string, config: Object }>} - Jobs for the runner
 */
function buildEmailScraperJobs(config) {
  const {
    query,
    sources = {},
    maxResultsPerSource = 20,
    industry = null,
    keywords = null
  } = config;
  const maxPer = Math.min(MAX_RESULTS_PER_SOURCE, Math.max(1, maxResultsPerSource || 20));
  const jobs = [];

  if (sources.linkedin) {
    jobs.push({
      type: 'linkedin',
      config: {
        searchMode: 'company',
        companyName: query,
        companyDomain: (query || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '') + '.com',
        maxProfiles: maxPer,
        jobTitles: [],
        industry,
        keywords,
        location: null
      }
    });
  }
  if (sources.googleSearch) {
    jobs.push({
      type: 'google_search',
      config: {
        searchQuery: `${(query || '').trim()} email contact`,
        originalQuery: query,
        maxResults: maxPer,
        industry,
        keywords: keywords || query
      }
    });
  }
  if (sources.googleMaps) {
    jobs.push({
      type: 'google_maps',
      config: {
        searchQuery: query,
        maxResults: maxPer,
        industry,
        keywords,
        enableEnrichment: true
      }
    });
  }
  if (sources.websites && ((query || '').includes('http') || (query || '').includes('.com') || (query || '').includes('.co.za'))) {
    jobs.push({
      type: 'website',
      config: {
        websiteUrl: query,
        industry,
        keywords,
        isBulk: (query || '').split(/[,;\n\r]+/).filter(Boolean).length > 1
      }
    });
  }
  return jobs;
}

/**
 * Merge contact data from multiple sources
 * Keeps the most complete record for each email (or company name if no email)
 * @param {Array<Object>} contacts - Array of contact objects
 * @returns {Array<Object>} - Deduplicated and merged contacts
 */
function mergeContacts(contacts) {
  const emailMap = new Map();
  const noEmailMap = new Map(); // For contacts without emails, keyed by company name
  
  for (const contact of contacts) {
    if (contact.email) {
      // Contacts with email: deduplicate by email
      const email = contact.email.toLowerCase();
      const existing = emailMap.get(email);
      
      if (!existing) {
        // First time seeing this email
        emailMap.set(email, { ...contact });
      } else {
        // Merge with existing contact (prefer non-null values)
        const merged = { ...existing };
        
        // Merge fields, preferring new data if existing is null
        Object.keys(contact).forEach(key => {
          if (contact[key] !== null && contact[key] !== undefined && contact[key] !== '') {
            if (!merged[key] || merged[key] === null || merged[key] === '') {
              merged[key] = contact[key];
            }
          }
        });
        
        // If sources are different, combine them
        if (contact.source && existing.source && contact.source !== existing.source) {
          merged.source = `${existing.source},${contact.source}`;
        }
        
        emailMap.set(email, merged);
      }
    } else {
      // Contacts without email: deduplicate by company name (or first_name if no company)
      const key = (contact.company || contact.first_name || '').toLowerCase().trim();
      
      if (!key) {
        // Skip contacts with no email, company, or name
        continue;
      }
      
      const existing = noEmailMap.get(key);
      
      if (!existing) {
        // First time seeing this company/name
        noEmailMap.set(key, { ...contact });
      } else {
        // Merge with existing contact (prefer non-null values)
        const merged = { ...existing };
        
        // Merge fields, preferring new data if existing is null
        Object.keys(contact).forEach(key => {
          if (contact[key] !== null && contact[key] !== undefined && contact[key] !== '') {
            if (!merged[key] || merged[key] === null || merged[key] === '') {
              merged[key] = contact[key];
            }
          }
        });
        
        // If sources are different, combine them
        if (contact.source && existing.source && contact.source !== existing.source) {
          merged.source = `${existing.source},${contact.source}`;
        }
        
        noEmailMap.set(key, merged);
      }
    }
  }
  
  // Combine both maps: contacts with emails first, then contacts without emails
  const result = [...Array.from(emailMap.values()), ...Array.from(noEmailMap.values())];
  
  console.log(`mergeContacts: ${contacts.length} input -> ${emailMap.size} with email + ${noEmailMap.size} without email = ${result.length} total`);
  
  return result;
}

/**
 * Run unified email scraper across multiple sources
 * @param {Object} config - Configuration object
 * @param {string} config.query - Search query or company name
 * @param {Object} config.sources - Source selection { linkedin, googleSearch, googleMaps, websites }
 * @param {number} config.maxResultsPerSource - Max results per source
 * @param {string} config.industry - Industry tag (optional)
 * @param {string} config.keywords - Keywords tag (optional)
 * @param {Function} progressCallback - Progress callback function
 * @returns {Object} - { success, results, stats, errors }
 */
async function runUnifiedEmailScraper(config, progressCallback, checkCancellationFn = null) {
  const {
    query,
    sources = {},
    maxResultsPerSource = 20,
    industry = null,
    keywords = null
  } = config;
  
  const allContacts = [];
  const errors = [];
  const sourceStats = {
    linkedin: { found: 0, errors: 0 },
    googleSearch: { found: 0, errors: 0 },
    googleMaps: { found: 0, errors: 0 },
    websites: { found: 0, errors: 0 }
  };
  
  // Progress callback wrapper that adds source context
  const createSourceProgressCallback = (sourceName) => {
    return (progress) => {
      progressCallback({
        ...progress,
        source: sourceName,
        overallProgress: {
          totalSources: Object.values(sources).filter(Boolean).length,
          completedSources: Object.keys(sourceStats).filter(s => 
            sources[s] && (sourceStats[s].found > 0 || sourceStats[s].errors > 0)
          ).length
        }
      });
    };
  };
  
  // Helper function to check cancellation - use passed function or fallback
  const checkCancellation = () => {
    try {
      // Use passed cancellation function first
      if (checkCancellationFn && typeof checkCancellationFn === 'function') {
        return checkCancellationFn();
      }
      // Fallback to global if available
      if (global && typeof global.isScrapingCancelled === 'function') {
        return global.isScrapingCancelled();
      }
      return false;
    } catch (e) {
      return false;
    }
  };
  
  // Helper function to calculate stats from contacts
  const calculateStats = (contacts) => {
    return {
      total: contacts.length,
      withEmail: contacts.filter(c => c && c.email).length,
      withPhone: contacts.filter(c => c && (c.phone_number || c.mobile_number || c.whatsapp_number)).length
    };
  };
  
  // ========== LINKEDIN SCRAPER ==========
  if (sources.linkedin) {
    try {
      progressCallback({
        status: 'Starting LinkedIn scraper...',
        source: 'linkedin',
        phase: 'init'
      });
      
      // Extract company name from query (assume it's a company name for LinkedIn)
      const companyName = query;
      const companyDomain = query.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '') + '.com';
      
      const linkedinResults = await runLinkedInScraper(
        companyName,
        companyDomain,
        maxResultsPerSource,
        [], // jobTitles - empty for all employees
        industry,
        keywords,
        createSourceProgressCallback('linkedin'),
        'company', // searchMode
        checkCancellation // Pass cancellation check
      );
      
      if (linkedinResults && linkedinResults.length > 0) {
        allContacts.push(...linkedinResults);
        sourceStats.linkedin.found = linkedinResults.length;
        
        // Send intermediate results to UI
        progressCallback({
          status: `LinkedIn scraper completed: Found ${linkedinResults.length} contacts`,
          source: 'linkedin',
          phase: 'complete',
          intermediateResults: linkedinResults,
          stats: calculateStats(linkedinResults)
        });
      }
    } catch (error) {
      console.error('LinkedIn scraper error:', error);
      errors.push({ source: 'linkedin', error: error.message });
      sourceStats.linkedin.errors++;
    }
  }
  
  // ========== GOOGLE SEARCH SCRAPER ==========
  if (sources.googleSearch) {
    try {
      progressCallback({
        status: 'Starting Google Search scraper...',
        source: 'googleSearch',
        phase: 'init'
      });
      
      const searchQuery = `${query} email contact`;
      const searchResults = await runGoogleSearchScraper(
        searchQuery,
        maxResultsPerSource,
        industry,
        keywords || query, // Pass original query as keywords if keywords not provided
        createSourceProgressCallback('googleSearch'),
        { checkCancellation: checkCancellation, originalQuery: query } // Pass original query
      );
      
      if (searchResults && searchResults.length > 0) {
        allContacts.push(...searchResults);
        sourceStats.googleSearch.found = searchResults.length;
        
        // Send intermediate results to UI
        progressCallback({
          status: `Google Search completed: Found ${searchResults.length} contacts`,
          source: 'googleSearch',
          phase: 'complete',
          intermediateResults: searchResults,
          stats: calculateStats(searchResults)
        });
      }
    } catch (error) {
      console.error('Google Search scraper error:', error);
      const errorMsg = error.message.includes('CAPTCHA') 
        ? 'Google CAPTCHA detected. Please solve it manually in the browser, or try other sources (LinkedIn, Google Maps, Websites).'
        : error.message;
      errors.push({ source: 'googleSearch', error: errorMsg });
      sourceStats.googleSearch.errors++;
      
      // Continue with other sources even if Google Search fails
      progressCallback({
        status: `Google Search failed: ${errorMsg}. Continuing with other sources...`,
        source: 'googleSearch',
        phase: 'error'
      });
    }
  }
  
  // ========== GOOGLE MAPS SCRAPER ==========
  if (sources.googleMaps) {
    try {
      progressCallback({
        status: 'Starting Google Maps scraper...',
        source: 'googleMaps',
        phase: 'init'
      });
      
      const mapsResults = await runGoogleMapsScraper(
        query, // This is the original search query
        maxResultsPerSource,
        industry,
        keywords,
        createSourceProgressCallback('googleMaps'),
        { 
          enableEnrichment: true, // Always enable enrichment for email scraping
          checkCancellation: checkCancellation // Pass cancellation check
        }
      );
      
      if (mapsResults && mapsResults.length > 0) {
        console.log(`Google Maps scraper returned ${mapsResults.length} businesses to email-scraper-service`);
        allContacts.push(...mapsResults);
        sourceStats.googleMaps.found = mapsResults.length;
        console.log(`Total contacts after adding Google Maps: ${allContacts.length}`);
        
        // Send intermediate results to UI
        progressCallback({
          status: `Google Maps completed: Found ${mapsResults.length} contacts`,
          source: 'googleMaps',
          phase: 'complete',
          intermediateResults: mapsResults,
          stats: calculateStats(mapsResults)
        });
      } else {
        console.log(`Google Maps scraper returned ${mapsResults ? mapsResults.length : 0} businesses (empty or null)`);
      }
    } catch (error) {
      console.error('Google Maps scraper error:', error);
      errors.push({ source: 'googleMaps', error: error.message });
      sourceStats.googleMaps.errors++;
    }
  }
  
  // Check cancellation before next source - but continue if we have contacts
  if (checkCancellation() && allContacts.length === 0) {
    // Only return early if cancelled AND no contacts found yet
    progressCallback({
      status: 'Scraping cancelled by user',
      cancelled: true,
      phase: 'complete'
    });
    return {
      success: false,
      results: allContacts,
      stats: calculateStats(allContacts),
      errors: errors,
      cancelled: true
    };
  }
  // If cancelled but we have contacts, continue to merge and return them
  
  // ========== WEBSITE SCRAPER ==========
  if (sources.websites && !checkCancellation()) {
    try {
      progressCallback({
        status: 'Starting Website scraper...',
        source: 'websites',
        phase: 'init'
      });
      
      // Try to extract website URLs from query or use query as URL
      // For now, treat query as a potential website URL
      const websiteUrls = query.includes('http') || query.includes('.com') || query.includes('.co.za')
        ? query
        : null;
      
      if (websiteUrls) {
        const websiteResults = await runBulkWebsiteScraper(
          websiteUrls,
          industry,
          keywords,
          createSourceProgressCallback('websites'),
          { checkCancellation: checkCancellation } // Pass cancellation check
        );
        
        if (websiteResults && websiteResults.length > 0) {
          allContacts.push(...websiteResults);
          sourceStats.websites.found = websiteResults.length;
          
          // Send intermediate results to UI
          progressCallback({
            status: `Website scraper completed: Found ${websiteResults.length} contacts`,
            source: 'websites',
            phase: 'complete',
            intermediateResults: websiteResults,
            stats: calculateStats(websiteResults)
          });
        }
      } else {
        // If query doesn't look like URLs, try to construct search
        progressCallback({
          status: 'Query does not appear to be website URLs. Skipping website scraper.',
          source: 'websites',
          phase: 'skip'
        });
      }
    } catch (error) {
      console.error('Website scraper error:', error);
      errors.push({ source: 'websites', error: error.message });
      sourceStats.websites.errors++;
    }
  }
  
  // ========== MERGE AND DEDUPLICATE ==========
  progressCallback({
    status: 'Merging and deduplicating contacts...',
    phase: 'merge'
  });
  
  console.log(`Total contacts collected from all sources: ${allContacts.length}`);
  console.log(`Source stats:`, sourceStats);
  
  const mergedContacts = mergeContacts(allContacts);
  
  console.log(`After deduplication: ${mergedContacts.length} unique contacts`);
  
  // ========== FINAL SAVE TO DATABASE ==========
  if (mergedContacts.length > 0) {
    progressCallback({
      status: `Saving ${mergedContacts.length} unique contacts to database...`,
      phase: 'save'
    });
    
    // Separate contacts with and without email (all should have email, but just in case)
    const withEmail = mergedContacts.filter(c => c.email);
    
    if (withEmail.length > 0) {
      const { error } = await supabase
        .from('contacts')
        .upsert(withEmail, { onConflict: 'email', ignoreDuplicates: false });
      
      if (error) {
        console.error('Final Supabase save error:', error);
        errors.push({ source: 'database', error: error.message });
      } else {
        console.log(`Successfully saved ${withEmail.length} unique contacts`);
      }
    }
  }
  
  // ========== CALCULATE FINAL STATS ==========
  const stats = {
    total: mergedContacts.length,
    withEmail: mergedContacts.filter(c => c.email).length,
    withPhone: mergedContacts.filter(c => c.phone_number || c.mobile_number).length,
    bySource: sourceStats
  };
  
  progressCallback({
    status: `Complete! Found ${mergedContacts.length} unique contacts across all sources.`,
    phase: 'complete',
    completed: true,
    stats
  });
  
  // Always return results, even if empty (so user knows what happened)
  const finalResult = {
    success: mergedContacts.length > 0 || errors.length === 0, // Success if we got results OR no errors occurred
    results: mergedContacts,
    stats,
    errors: errors.length > 0 ? errors : null
  };
  
  console.log('Final result:', {
    success: finalResult.success,
    resultsCount: finalResult.results.length,
    errorsCount: errors.length,
    stats: finalResult.stats
  });
  
  return finalResult;
}

module.exports = { buildEmailScraperJobs, runUnifiedEmailScraper, mergeContacts };
