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

const SUPABASE_URL = 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Merge contact data from multiple sources
 * Keeps the most complete record for each email
 * @param {Array<Object>} contacts - Array of contact objects
 * @returns {Array<Object>} - Deduplicated and merged contacts
 */
function mergeContacts(contacts) {
  const emailMap = new Map();
  
  for (const contact of contacts) {
    if (!contact.email) continue;
    
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
  }
  
  return Array.from(emailMap.values());
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
async function runUnifiedEmailScraper(config, progressCallback) {
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
        createSourceProgressCallback('linkedin')
      );
      
      if (linkedinResults && linkedinResults.length > 0) {
        allContacts.push(...linkedinResults);
        sourceStats.linkedin.found = linkedinResults.length;
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
        keywords,
        createSourceProgressCallback('googleSearch')
      );
      
      if (searchResults && searchResults.length > 0) {
        allContacts.push(...searchResults);
        sourceStats.googleSearch.found = searchResults.length;
      }
    } catch (error) {
      console.error('Google Search scraper error:', error);
      errors.push({ source: 'googleSearch', error: error.message });
      sourceStats.googleSearch.errors++;
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
        query,
        maxResultsPerSource,
        industry,
        keywords,
        createSourceProgressCallback('googleMaps'),
        { enableEnrichment: true } // Always enable enrichment for email scraping
      );
      
      if (mapsResults && mapsResults.length > 0) {
        allContacts.push(...mapsResults);
        sourceStats.googleMaps.found = mapsResults.length;
      }
    } catch (error) {
      console.error('Google Maps scraper error:', error);
      errors.push({ source: 'googleMaps', error: error.message });
      sourceStats.googleMaps.errors++;
    }
  }
  
  // ========== WEBSITE SCRAPER ==========
  if (sources.websites) {
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
          createSourceProgressCallback('websites')
        );
        
        if (websiteResults && websiteResults.length > 0) {
          allContacts.push(...websiteResults);
          sourceStats.websites.found = websiteResults.length;
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
  
  const mergedContacts = mergeContacts(allContacts);
  
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
  
  return {
    success: true,
    results: mergedContacts,
    stats,
    errors: errors.length > 0 ? errors : null
  };
}

module.exports = { runUnifiedEmailScraper, mergeContacts };
