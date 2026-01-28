// Import email extractor for name extraction (with fallback)
let extractNameFromEmail;
try {
  const emailExtractor = require('./email-extractor');
  extractNameFromEmail = emailExtractor.extractNameFromEmail;
} catch (e) {
  // Fallback function if require fails
  extractNameFromEmail = function(email) {
    if (!email || typeof email !== 'string') return null;
    const localPart = email.split('@')[0].toLowerCase();
    if (localPart.length < 3 || /^[0-9]+$/.test(localPart)) return null;
    
    // Pattern 1: first.last
    if (localPart.includes('.')) {
      const parts = localPart.split('.');
      if (parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2) {
        const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        return { firstName, lastName, fullName: `${firstName} ${lastName}` };
      }
    }
    
    // Pattern 2: first_last
    if (localPart.includes('_')) {
      const parts = localPart.split('_');
      if (parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2) {
        const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        return { firstName, lastName, fullName: `${firstName} ${lastName}` };
      }
    }
    
    // Pattern 3: first-last
    if (localPart.includes('-')) {
      const parts = localPart.split('-');
      if (parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2) {
        const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
        const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        return { firstName, lastName, fullName: `${firstName} ${lastName}` };
      }
    }
    
    return null;
  };
}

// Check if electronAPI is available
if (typeof window !== 'undefined' && !window.electronAPI) {
  console.error('electronAPI is not available. Make sure preload.js is loaded correctly.');
}

// DOM elements
const inputCard = document.getElementById("inputCard");
const progressCard = document.getElementById("progressCard");
const completeCard = document.getElementById("completeCard");
const errorCard = document.getElementById("errorCard");

const startBtn = document.getElementById("startBtn");
const newScrapeBtn = document.getElementById("newScrapeBtn");
const retryBtn = document.getElementById("retryBtn");
const stopScrapeBtn = document.getElementById("stopScrapeBtn");

// LinkedIn form
const linkedinForm = document.getElementById("linkedinForm");
const companyNameInput = document.getElementById("companyName");
const companyDomainInput = document.getElementById("companyDomain");
const linkedinKeywordInput = document.getElementById("linkedinKeyword");
const linkedinLocationInput = document.getElementById("linkedinLocation");
const maxProfilesInput = document.getElementById("maxProfiles");
const linkedinSearchModeRadios = document.querySelectorAll('input[name="linkedinSearchMode"]');

// Google Maps form
const googlemapsForm = document.getElementById("googlemapsForm");
const searchQueryInput = document.getElementById("searchQuery");
const maxResultsInput = document.getElementById("maxResults");
const mapsIndustrySelect = document.getElementById("mapsIndustry");
const mapsIndustryManualInput = document.getElementById("mapsIndustryManual");
const enableEnrichmentCheckbox = document.getElementById("enableEnrichment");

// Website form
const websiteForm = document.getElementById("websiteForm");
const websiteUrlInput = document.getElementById("websiteUrl");
const websiteIndustrySelect = document.getElementById("websiteIndustry");
const websiteIndustryManualInput = document.getElementById("websiteIndustryManual");
const websiteKeywordsInput = document.getElementById("websiteKeywords");

// Email Scraper form
const emailscraperForm = document.getElementById("emailscraperForm");
const emailScraperQueryInput = document.getElementById("emailScraperQuery");
const emailScraperMaxResultsInput = document.getElementById("emailScraperMaxResults");
const emailScraperIndustrySelect = document.getElementById("emailScraperIndustry");
const emailScraperKeywordsInput = document.getElementById("emailScraperKeywords");
const sourceLinkedInCheckbox = document.getElementById("sourceLinkedIn");
const sourceGoogleSearchCheckbox = document.getElementById("sourceGoogleSearch");
const sourceGoogleMapsCheckbox = document.getElementById("sourceGoogleMaps");
const sourceWebsitesCheckbox = document.getElementById("sourceWebsites");

// Progress elements
const statusText = document.getElementById("statusText");
const profilesFoundEl = document.getElementById("profilesFound");
const profilesScrapedEl = document.getElementById("profilesScraped");
const progressPhase = document.getElementById("progressPhase");
const emailStatBox = document.getElementById("emailStatBox");
const emailsFoundEl = document.getElementById("emailsFound");

// Complete elements
const completeText = document.getElementById("completeText");
const completeStats = document.getElementById("completeStats");
const statTotal = document.getElementById("statTotal");
const statEmails = document.getElementById("statEmails");
const statPhones = document.getElementById("statPhones");
const failedUrlsSection = document.getElementById("failedUrlsSection");
const failedUrlsList = document.getElementById("failedUrlsList");

const errorText = document.getElementById("errorText");
const resultsTableBody = document.getElementById("resultsTableBody");
const resultsSection = document.getElementById("resultsSection");
const exportCsvBtn = document.getElementById("exportCsvBtn");

// Role filter elements
const roleCategories = document.getElementById("roleCategories");
const selectedRolesSummary = document.getElementById("selectedRolesSummary");
const selectedRolesText = document.getElementById("selectedRolesText");

// Track active scraper
let activeScraper = "linkedin";
let currentStats = { total: 0, withEmail: 0, withPhone: 0 };
let currentResults = []; // Store results for CSV export
let selectedResults = new Set(); // Track selected contacts for export
let accumulatedResults = []; // Accumulate results from multiple sources during scraping

// ============================================
// ROLE FILTER LOGIC
// ============================================

// Toggle role mode (all vs custom)
document.querySelectorAll('input[name="roleMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      roleCategories.style.display = 'block';
      selectedRolesSummary.style.display = 'block';
      updateSelectedRolesSummary();
    } else {
      roleCategories.style.display = 'none';
      selectedRolesSummary.style.display = 'none';
    }
  });
});

// LinkedIn search mode toggle (company vs keyword)
if (linkedinSearchModeRadios && linkedinSearchModeRadios.length > 0) {
  linkedinSearchModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const mode = radio.value;
      const companyNameGroup = document.getElementById('companyNameGroup');
      const companyDomainGroup = document.getElementById('companyDomainGroup');
      const linkedinKeywordGroup = document.getElementById('linkedinKeywordGroup');
      
      if (mode === 'keyword') {
        if (companyNameGroup) companyNameGroup.style.display = 'none';
        if (companyDomainGroup) companyDomainGroup.style.display = 'none';
        if (linkedinKeywordGroup) linkedinKeywordGroup.style.display = 'block';
        if (companyNameInput) companyNameInput.removeAttribute('required');
        if (companyDomainInput) companyDomainInput.removeAttribute('required');
        if (linkedinKeywordInput) linkedinKeywordInput.setAttribute('required', 'required');
      } else {
        if (companyNameGroup) companyNameGroup.style.display = 'block';
        if (companyDomainGroup) companyDomainGroup.style.display = 'block';
        if (linkedinKeywordGroup) linkedinKeywordGroup.style.display = 'none';
        if (companyNameInput) companyNameInput.setAttribute('required', 'required');
        if (companyDomainInput) companyDomainInput.removeAttribute('required'); // Domain is optional
        if (linkedinKeywordInput) linkedinKeywordInput.removeAttribute('required');
      }
    });
  });
}

// Toggle role group expand/collapse
document.querySelectorAll('.role-group-header').forEach(header => {
  header.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    
    const category = header.dataset.category;
    const items = document.getElementById(category + '-items');
    const chevron = header.querySelector('.role-group-chevron');
    
    if (items.style.display === 'none') {
      items.style.display = 'block';
      chevron.style.transform = 'rotate(180deg)';
      header.classList.add('expanded');
    } else {
      items.style.display = 'none';
      chevron.style.transform = 'rotate(0deg)';
      header.classList.remove('expanded');
    }
  });
});

// Handle checkbox changes
document.querySelectorAll('.role-group-items input[type="checkbox"]').forEach(checkbox => {
  checkbox.addEventListener('change', () => {
    updateCategoryCount(checkbox.dataset.category);
    updateSelectedRolesSummary();
  });
});

// Select All buttons
document.querySelectorAll('.btn-select-all').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const category = btn.dataset.category;
    document.querySelectorAll('input[data-category="' + category + '"]').forEach(cb => cb.checked = true);
    updateCategoryCount(category);
    updateSelectedRolesSummary();
  });
});

// Clear buttons
document.querySelectorAll('.btn-clear-all').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const category = btn.dataset.category;
    document.querySelectorAll('input[data-category="' + category + '"]').forEach(cb => cb.checked = false);
    updateCategoryCount(category);
    updateSelectedRolesSummary();
  });
});

function updateCategoryCount(category) {
  const checkboxes = document.querySelectorAll('input[data-category="' + category + '"]:checked');
  const countEl = document.getElementById(category + '-count');
  if (countEl) {
    const count = checkboxes.length;
    countEl.textContent = count === 0 ? '0 selected' : count + ' selected';
    countEl.className = 'role-group-count' + (count > 0 ? ' has-selection' : '');
  }
}

function updateSelectedRolesSummary() {
  const jobTitles = getSelectedJobTitles();
  
  if (jobTitles.length === 0) {
    selectedRolesText.textContent = 'None - please select at least one role or enter a job title';
    selectedRolesText.className = 'no-selection';
  } else if (jobTitles.length <= 5) {
    selectedRolesText.textContent = jobTitles.join(', ');
    selectedRolesText.className = '';
  } else {
    selectedRolesText.textContent = jobTitles.slice(0, 5).join(', ') + ' +' + (jobTitles.length - 5) + ' more';
    selectedRolesText.className = '';
  }
}

function getSelectedJobTitles() {
  const roleMode = document.querySelector('input[name="roleMode"]:checked');
  const jobTitles = [];
  
  // Get selected roles from checkboxes (only if custom mode is selected)
  if (roleMode && roleMode.value === 'custom') {
    const allChecked = document.querySelectorAll('.role-group-items input[type="checkbox"]:checked');
    jobTitles.push(...Array.from(allChecked).map(cb => cb.value));
  }
  
  // Get manually entered job titles
  const manualJobTitleInput = document.getElementById('manualJobTitle');
  if (manualJobTitleInput && manualJobTitleInput.value.trim()) {
    const manualTitles = manualJobTitleInput.value
      .split(',')
      .map(title => title.trim())
      .filter(title => title.length > 0);
    jobTitles.push(...manualTitles);
  }
  
  // Remove duplicates
  return [...new Set(jobTitles)];
}

// ============================================
// TAB SWITCHING
// ============================================

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    linkedinForm.style.display = "none";
    googlemapsForm.style.display = "none";
    websiteForm.style.display = "none";
    if (emailscraperForm) emailscraperForm.style.display = "none";

    activeScraper = btn.dataset.scraper;
    if (activeScraper === "linkedin") {
      linkedinForm.style.display = "block";
    } else if (activeScraper === "googlemaps") {
      googlemapsForm.style.display = "block";
    } else if (activeScraper === "website") {
      websiteForm.style.display = "block";
    } else if (activeScraper === "emailscraper" && emailscraperForm) {
      emailscraperForm.style.display = "block";
    }
  });
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

function showCard(card) {
  inputCard.style.display = "none";
  progressCard.style.display = "none";
  completeCard.style.display = "none";
  errorCard.style.display = "none";
  card.style.display = "block";
}

function updatePhase(phase, source = null) {
  if (!progressPhase) return;
  
  const phaseNames = {
    'init': { num: '1', text: 'Initializing...' },
    'search': { num: '1', text: 'Searching...' },
    'extract': { num: '2', text: 'Extracting emails...' },
    'visit': { num: '2', text: 'Visiting pages...' },
    'maps_search': { num: '1', text: 'Searching Google Maps...' },
    'maps_scroll': { num: '1', text: 'Collecting listings...' },
    'maps_extract': { num: '1', text: 'Extracting business data...' },
    'enrich': { num: '2', text: 'Enriching with website data...' },
    'scraping': { num: '1', text: 'Scraping websites...' },
    'merge': { num: '3', text: 'Merging results...' },
    'saving': { num: '3', text: 'Saving to database...' },
    'save': { num: '3', text: 'Saving to database...' },
    'complete': { num: 'ok', text: 'Complete!' },
    'error': { num: '!', text: 'Error occurred' },
    'skip': { num: '?', text: 'Skipped' }
  };
  
  const phaseInfo = phaseNames[phase] || { num: '?', text: phase };
  const badge = phaseInfo.num === 'ok' ? '✓' : 'Phase ' + phaseInfo.num;
  
  let phaseText = phaseInfo.text;
  if (source) {
    const sourceNames = {
      'linkedin': 'LinkedIn',
      'googleSearch': 'Google Search',
      'googleMaps': 'Google Maps',
      'websites': 'Websites'
    };
    phaseText = sourceNames[source] + ': ' + phaseText;
  }
  
  progressPhase.innerHTML = '<span class="phase-badge">' + badge + '</span><span class="phase-text">' + phaseText + '</span>';
}

function countUrls(input) {
  if (!input) return 0;
  return input.split(/[,;\n\r]+/).map(url => url.trim()).filter(url => url.length > 0).length;
}

// ============================================
// START SCRAPING
// ============================================

startBtn.addEventListener("click", async () => {
  let config = {};

  if (activeScraper === "linkedin") {
    const searchMode = document.querySelector('input[name="linkedinSearchMode"]:checked')?.value || 'company';
    const maxProfiles = parseInt(maxProfilesInput.value) || 20;
    const jobTitles = getSelectedJobTitles();

    if (searchMode === 'keyword') {
      const keywords = linkedinKeywordInput ? linkedinKeywordInput.value.trim() : '';
      if (!keywords) {
        alert("Please enter search keywords");
        return;
      }

      const location = linkedinLocationInput ? linkedinLocationInput.value.trim() : '';

      config = {
        type: "linkedin",
        searchMode: 'keyword',
        keywords,
        location,
        maxProfiles,
        jobTitles: [], // Keywords search doesn't use job title filter
      };
    } else {
      // Company mode
      const companyName = companyNameInput.value.trim();
      const companyDomain = companyDomainInput ? companyDomainInput.value.trim() : '';

      if (!companyName) {
        alert("Please fill in company name");
        return;
      }

      const roleMode = document.querySelector('input[name="roleMode"]:checked');
      if (roleMode && roleMode.value === 'custom' && jobTitles.length === 0) {
        alert("Please select at least one role from the checkboxes, enter a manual job title, or choose 'All Employees'");
        return;
      }

      const location = linkedinLocationInput ? linkedinLocationInput.value.trim() : '';

      config = {
        type: "linkedin",
        searchMode: 'company',
        companyName,
        companyDomain,
        location,
        maxProfiles,
        jobTitles,
      };
    }
  } else if (activeScraper === "googlemaps") {
    const searchQuery = searchQueryInput.value.trim();
    const maxResults = parseInt(maxResultsInput.value) || 50;
    // Use manual industry if provided, otherwise use dropdown
    const industry = (mapsIndustryManualInput && mapsIndustryManualInput.value.trim()) 
      ? mapsIndustryManualInput.value.trim() 
      : (mapsIndustrySelect ? mapsIndustrySelect.value : null);
    const enableEnrichment = enableEnrichmentCheckbox ? enableEnrichmentCheckbox.checked : true;

    if (!searchQuery) {
      alert("Please enter a search query");
      return;
    }

    config = {
      type: "googlemaps",
      searchQuery,
      maxResults,
      industry: industry || null,
      enableEnrichment,
    };
    
    if (emailStatBox) {
      emailStatBox.style.display = enableEnrichment ? "block" : "none";
    }
  } else if (activeScraper === "website") {
    const websiteUrls = websiteUrlInput.value.trim();
    // Use manual industry if provided, otherwise use dropdown
    const industry = (websiteIndustryManualInput && websiteIndustryManualInput.value.trim()) 
      ? websiteIndustryManualInput.value.trim() 
      : (websiteIndustrySelect ? websiteIndustrySelect.value : null);
    const keywords = websiteKeywordsInput ? websiteKeywordsInput.value.trim() : null;

    if (!websiteUrls) {
      alert("Please enter at least one website URL");
      return;
    }

    config = {
      type: "website",
      websiteUrl: websiteUrls,
      industry: industry || null,
      keywords: keywords || null,
      isBulk: countUrls(websiteUrls) > 1,
    };
    
    if (emailStatBox) {
      emailStatBox.style.display = "block";
    }
  } else if (activeScraper === "emailscraper") {
    const query = emailScraperQueryInput ? emailScraperQueryInput.value.trim() : '';
    const maxResultsPerSource = emailScraperMaxResultsInput ? parseInt(emailScraperMaxResultsInput.value) || 20 : 20;
    const industry = emailScraperIndustrySelect ? emailScraperIndustrySelect.value : null;
    const keywords = emailScraperKeywordsInput ? emailScraperKeywordsInput.value.trim() : null;

    if (!query) {
      alert("Please enter a search query or company name");
      return;
    }

    // Check if at least one source is selected
    const sources = {
      linkedin: sourceLinkedInCheckbox ? sourceLinkedInCheckbox.checked : false,
      googleSearch: sourceGoogleSearchCheckbox ? sourceGoogleSearchCheckbox.checked : false,
      googleMaps: sourceGoogleMapsCheckbox ? sourceGoogleMapsCheckbox.checked : false,
      websites: sourceWebsitesCheckbox ? sourceWebsitesCheckbox.checked : false
    };

    const hasSource = Object.values(sources).some(v => v === true);
    if (!hasSource) {
      alert("Please select at least one data source");
      return;
    }

    config = {
      type: "emailscraper",
      query,
      sources,
      maxResultsPerSource,
      industry: industry || null,
      keywords: keywords || null,
    };
    
    if (emailStatBox) {
      emailStatBox.style.display = "block";
    }
  }

  currentStats = { total: 0, withEmail: 0, withPhone: 0 };
  if (emailsFoundEl) emailsFoundEl.textContent = "0";
  
  // Clear accumulated results when starting a new scrape
  accumulatedResults = [];
  currentResults = [];
  selectedResults.clear();
  
  // Enable stop button when scraping starts
  if (stopScrapeBtn) {
    stopScrapeBtn.disabled = false;
    stopScrapeBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align: middle; margin-right: 8px;">
        <rect x="6" y="6" width="12" height="12" rx="1"/>
      </svg>
      Stop Scraping
    `;
  }
  
  showCard(progressCard);
  updatePhase('init');

  try {
    // Verify electronAPI is available
    if (!window.electronAPI) {
      throw new Error('Electron API is not available. Please restart the application.');
    }
    
    let result;
    if (config.type === "emailscraper") {
      // Check if startEmailScrape method exists
      if (!window.electronAPI.startEmailScrape) {
        console.error('startEmailScrape method not found. Available methods:', Object.keys(window.electronAPI));
        throw new Error('Email scraper API not available. Please restart the application to load the latest version.');
      }
      result = await window.electronAPI.startEmailScrape(config);
    } else {
      result = await window.electronAPI.startScrape(config);
    }

    if (result.success) {
      console.log('Scrape result:', result);
      
      if (result.stats) {
        currentStats = result.stats;
      } else if (result.results) {
        currentStats.total = result.results.length;
        currentStats.withEmail = result.results.filter(r => r && r.email).length;
        currentStats.withPhone = result.results.filter(r => r && (r.phone_number || r.mobile_number)).length;
      }
      
      const resultsCount = result.results ? result.results.length : 0;
      
      console.log(`Final result count: ${resultsCount} contacts`);
      console.log(`Result stats:`, result.stats);
      
      if (resultsCount === 0) {
        completeText.textContent = "No contacts found. Try a different search query, enable more sources, or check if the company has publicly available email addresses.";
      } else {
        // Use stats.total if available (more accurate), otherwise use resultsCount
        const displayCount = (result.stats && result.stats.total) ? result.stats.total : resultsCount;
        completeText.textContent = displayCount + " contacts added to database.";
        console.log(`Displaying count: ${displayCount} (from stats.total: ${result.stats?.total}, from results.length: ${resultsCount})`);
      }
      
      if (completeStats) {
        completeStats.style.display = "flex";
        statTotal.textContent = currentStats.total || resultsCount || 0;
        statEmails.textContent = currentStats.withEmail || 0;
        statPhones.textContent = currentStats.withPhone || 0;
      }
      
      if (result.errors && result.errors.length > 0) {
        console.warn('Scraping errors:', result.errors);
        if (failedUrlsSection) {
          failedUrlsSection.style.display = "block";
          failedUrlsList.innerHTML = result.errors.map(function(e) {
            return '<li>' + (e.source || 'Unknown') + ': ' + (e.error || e.reason || 'Error') + '</li>';
          }).join('');
        }
      } else if (result.failedUrls && result.failedUrls.length > 0 && failedUrlsSection) {
        failedUrlsSection.style.display = "block";
        failedUrlsList.innerHTML = result.failedUrls.map(function(f) {
          return '<li>' + f.url + ' - ' + f.reason + '</li>';
        }).join('');
      } else if (failedUrlsSection) {
        failedUrlsSection.style.display = "none";
      }

      console.log('Displaying results:', result.results ? result.results.length : 0, 'contacts');
      console.log('Result object:', { 
        success: result.success, 
        resultsLength: result.results ? result.results.length : 0,
        stats: result.stats 
      });
      
      // Ensure we have all results (final merged results)
      const allResults = result.results || [];
      console.log('All results to display:', allResults.length);
      if (allResults.length > 0) {
        console.log('First result sample:', allResults[0]);
        console.log('Result sources:', allResults.map(r => r?.source || 'unknown').slice(0, 10));
      }
      
      // Store final merged results for CSV export (replace accumulated results)
      currentResults = allResults;
      accumulatedResults = allResults; // Update accumulated to match final merged results
      
      displayResults(allResults);
      showCard(completeCard);
      
      // Show export button if there are results
      if (exportCsvBtn) {
        exportCsvBtn.style.display = allResults.length > 0 ? 'flex' : 'none';
        exportCsvBtn.disabled = false;
      }
      
      // Disable stop button on completion
      if (stopScrapeBtn) {
        stopScrapeBtn.disabled = true;
      }
    } else {
      // Check if it was cancelled
      if (result.cancelled) {
        completeText.textContent = "Scraping was stopped. " + ((result.results && result.results.length > 0) ? 
          result.results.length + " contacts were saved before stopping." : "No contacts were saved.");
        
        if (result.results && result.results.length > 0) {
          currentResults = result.results;
          displayResults(result.results);
          
          // Show export button
          if (exportCsvBtn) {
            exportCsvBtn.style.display = 'inline-flex';
          }
        }
        
        if (completeStats) {
          completeStats.style.display = "flex";
          statTotal.textContent = result.results ? result.results.length : 0;
          statEmails.textContent = result.results ? result.results.filter(r => r && r.email).length : 0;
          statPhones.textContent = result.results ? result.results.filter(r => r && (r.phone_number || r.mobile_number)).length : 0;
        }
        
        showCard(completeCard);
      } else {
        errorText.textContent = result.error || "Something went wrong";
        showCard(errorCard);
      }
      
      // Disable stop button
      if (stopScrapeBtn) {
        stopScrapeBtn.disabled = true;
      }
    }
  } catch (error) {
    errorText.textContent = error.message;
    showCard(errorCard);
    
    // Disable stop button on error
    if (stopScrapeBtn) {
      stopScrapeBtn.disabled = true;
    }
  }
});

// ============================================
// PROGRESS UPDATES
// ============================================

// Stop button handler
if (stopScrapeBtn) {
  stopScrapeBtn.addEventListener("click", async () => {
    if (confirm("Are you sure you want to stop scraping? Current progress will be saved.")) {
      stopScrapeBtn.disabled = true;
      stopScrapeBtn.textContent = "Stopping...";
      
      try {
        if (window.electronAPI && window.electronAPI.stopScrape) {
          await window.electronAPI.stopScrape();
        }
      } catch (error) {
        console.error('Error stopping scrape:', error);
      }
    }
  });
}

window.electronAPI.onProgress((progress) => {
  statusText.textContent = progress.status;
  profilesFoundEl.textContent = progress.profilesFound || 0;
  profilesScrapedEl.textContent = progress.profilesScraped || 0;
  
  // Handle cancellation
  if (progress.cancelled) {
    if (stopScrapeBtn) {
      stopScrapeBtn.disabled = true;
      stopScrapeBtn.textContent = "Stopping...";
    }
  }
  
  if (progress.phase) {
    updatePhase(progress.phase, progress.source);
  }
  
  if (progress.stats && emailsFoundEl) {
    emailsFoundEl.textContent = progress.stats.withEmail || 0;
    currentStats = progress.stats;
  }

  // Show overall progress for multi-source scraping
  if (progress.overallProgress) {
    const { totalSources, completedSources } = progress.overallProgress;
    if (totalSources > 1) {
      statusText.textContent = `Source ${completedSources}/${totalSources}: ${progress.status}`;
    }
  }
  
  // Handle intermediate results from individual sources
  if (progress.intermediateResults && Array.isArray(progress.intermediateResults)) {
    console.log(`Received ${progress.intermediateResults.length} intermediate results from ${progress.source}`);
    
    // Add new results to accumulated results (avoid duplicates by email)
    const existingEmails = new Set(accumulatedResults.map(r => r?.email?.toLowerCase()).filter(Boolean));
    const newResults = progress.intermediateResults.filter(r => {
      if (!r || !r.email) return true; // Include contacts without email
      return !existingEmails.has(r.email.toLowerCase());
    });
    
    accumulatedResults.push(...newResults);
    currentResults = [...accumulatedResults]; // Update current results for export
    
    // Update stats
    if (progress.stats) {
      currentStats = {
        total: accumulatedResults.length,
        withEmail: accumulatedResults.filter(r => r && r.email).length,
        withPhone: accumulatedResults.filter(r => r && (r.phone_number || r.mobile_number || r.whatsapp_number)).length
      };
      
      if (emailsFoundEl) {
        emailsFoundEl.textContent = currentStats.withEmail || 0;
      }
    }
    
    // Display accumulated results immediately
    if (accumulatedResults.length > 0) {
      displayResults(accumulatedResults);
      resultsSection.style.display = "block";
      
      // Show export button if there are results
      if (exportCsvBtn) {
        exportCsvBtn.style.display = 'inline-flex';
      }
    }
  }

  if (progress.completed) {
    setTimeout(function() {
      if (progress.stats) {
        currentStats = progress.stats;
      }
      
      const contactsCount = progress.stats ? (progress.stats.total || 0) : (progress.profilesScraped || 0);
      completeText.textContent = contactsCount + " contacts added to database.";
      
      if (completeStats) {
        completeStats.style.display = "flex";
        statTotal.textContent = currentStats.total || contactsCount || 0;
        statEmails.textContent = currentStats.withEmail || 0;
        statPhones.textContent = currentStats.withPhone || 0;
      }
      
      if (progress.failedUrls && progress.failedUrls.length > 0 && failedUrlsSection) {
        failedUrlsSection.style.display = "block";
        failedUrlsList.innerHTML = progress.failedUrls.map(function(f) {
          return '<li>' + f.url + ' - ' + f.reason + '</li>';
        }).join('');
      }
      
      // If no contacts found, show a helpful message
      if (contactsCount === 0) {
        completeText.textContent = "No contacts found. Try a different search query or enable more sources.";
        currentResults = [];
      }
      
      // Hide export button if no results
      if (exportCsvBtn) {
        exportCsvBtn.style.display = contactsCount > 0 ? 'inline-flex' : 'none';
      }
      
      showCard(completeCard);
    }, 1000);
  }

  if (progress.error) {
    setTimeout(function() {
      errorText.textContent = progress.status;
      showCard(errorCard);
    }, 1000);
  }
});

// ============================================
// EXPORT TO CSV
// ============================================

function convertToCSV(data) {
  if (!data || data.length === 0) {
    alert('No data to export');
    return '';
  }
  
  // Define CSV headers based on available fields
  const headers = [
    'First Name',
    'Last Name',
    'Email',
    'Company',
    'Job Title',
    'Phone Number',
    'Mobile Number',
    'WhatsApp Number',
    'Location',
    'Industry',
    'Keywords',
    'Source',
    'LinkedIn URL',
    'Company Website',
    'Company Summary',
    'Email Domain',
    'Verification Status'
  ];
  
  // Create CSV rows
  const rows = data.map(contact => {
    // Extract name from email if available
    let displayName = '';
    if (contact.email) {
      const emailName = extractNameFromEmail(contact.email);
      if (emailName && emailName.fullName) {
        displayName = emailName.fullName;
      }
    }
    
    const firstName = contact.first_name || (displayName ? displayName.split(' ')[0] : '');
    const lastName = contact.last_name || (displayName ? displayName.split(' ').slice(1).join(' ') : '');
    
    return [
      escapeCSV(firstName),
      escapeCSV(lastName),
      escapeCSV(contact.email || ''),
      escapeCSV(contact.company || ''),
      escapeCSV(contact.job_title || ''),
      escapeCSV(contact.phone_number || ''),
      escapeCSV(contact.mobile_number || ''),
      escapeCSV(contact.whatsapp_number || ''),
      escapeCSV(contact.location || ''),
      escapeCSV(contact.industry || ''),
      escapeCSV(contact.keywords || ''),
      escapeCSV(contact.source || ''),
      escapeCSV(contact.linkedin_url || ''),
      escapeCSV(contact.company_website || ''),
      escapeCSV(contact.company_summary || ''),
      escapeCSV(contact.email_domain || ''),
      escapeCSV(contact.verification_status || '')
    ];
  });
  
  // Combine headers and rows
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.join(','))
  ].join('\n');
  
  return csvContent;
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  // If value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function downloadCSV(csvContent, filename) {
  // Create blob and download link
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  // Clean up
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

if (exportCsvBtn) {
  exportCsvBtn.addEventListener("click", function() {
    if (currentResults.length === 0) {
      alert('No results to export. Please run a scrape first.');
      return;
    }
    
    try {
      // Get selected contacts, or all if none selected
      let contactsToExport = [];
      
      if (selectedResults.size > 0) {
        // Export only selected contacts
        contactsToExport = currentResults.filter(function(contact) {
          const contactId = contact.email || `${currentResults.indexOf(contact)}-${contact.company || contact.first_name || currentResults.indexOf(contact)}`;
          return selectedResults.has(contactId);
        });
        
        if (contactsToExport.length === 0) {
          alert('No contacts selected. Please select contacts to export, or the selection may have been cleared.');
          return;
        }
        
        console.log(`Exporting ${contactsToExport.length} selected contacts out of ${currentResults.length} total`);
      } else {
        // Export all contacts if none selected
        contactsToExport = currentResults;
        console.log(`Exporting all ${contactsToExport.length} contacts (none selected)`);
      }
      
      const csvContent = convertToCSV(contactsToExport);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `scraped-contacts-${timestamp}.csv`;
      
      downloadCSV(csvContent, filename);
      
      // Show success message
      const originalText = exportCsvBtn.innerHTML;
      const countText = selectedResults.size > 0 ? ` (${contactsToExport.length} selected)` : '';
      exportCsvBtn.innerHTML = `✓ Exported${countText}!`;
      exportCsvBtn.disabled = true;
      
      setTimeout(() => {
        exportCsvBtn.innerHTML = originalText;
        exportCsvBtn.disabled = false;
      }, 2000);
    } catch (error) {
      console.error('Export error:', error);
      alert('Error exporting to CSV: ' + error.message);
    }
  });
}

// ============================================
// NEW SCRAPE / RETRY
// ============================================

newScrapeBtn.addEventListener("click", function() {
  showCard(inputCard);
  companyNameInput.value = "";
  companyDomainInput.value = "";
  if (linkedinLocationInput) linkedinLocationInput.value = "";
  searchQueryInput.value = "";
  websiteUrlInput.value = "";
  
  // Clear stored results
  currentResults = [];
  accumulatedResults = [];
  selectedResults.clear();
  
  if (completeStats) completeStats.style.display = "none";
  if (failedUrlsSection) failedUrlsSection.style.display = "none";
  if (emailStatBox) emailStatBox.style.display = "none";
  if (exportCsvBtn) exportCsvBtn.style.display = "none";
  
  // Reset select all checkbox
  const selectAllCheckbox = document.getElementById("selectAllResults");
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
  }
});

retryBtn.addEventListener("click", function() {
  showCard(inputCard);
});

// ============================================
// DISPLAY RESULTS
// ============================================

function displayResults(contacts) {
  resultsTableBody.innerHTML = "";
  selectedResults.clear(); // Clear previous selections
  
  // Reset select all checkbox
  const selectAllCheckbox = document.getElementById("selectAllResults");
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = false;
  }
  
  console.log('displayResults called with', contacts ? contacts.length : 0, 'contacts');

  if (!contacts || contacts.length === 0) {
    resultsSection.style.display = "none";
    return;
  }

  resultsSection.style.display = "block";
  
  console.log('Rendering', contacts.length, 'contacts to table');

  contacts.forEach(function(contact, index) {
    if (!contact) {
      console.warn('Skipping null/undefined contact at index', index);
      return;
    }
    const row = document.createElement("tr");
    row.style.borderBottom = "1px solid #f0f0f0";
    
    // Create unique ID for this contact (use email if available, otherwise use index + company/name)
    const contactId = contact.email || `${index}-${contact.company || contact.first_name || index}`;
    row.setAttribute('data-contact-id', contactId);

    const source = contact.source || "linkedin";

    // Extract name from email if available
    let displayName = "";
    if (contact.email) {
      const emailName = extractNameFromEmail(contact.email);
      if (emailName && emailName.fullName) {
        displayName = emailName.fullName;
      }
    }
    
    // Fallback to stored name or company
    if (!displayName) {
      displayName = `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || contact.company || contact.first_name || "N/A";
    }
    
    // Checkbox cell
    const checkboxCell = '<td style="padding: 12px; text-align: center;">' +
      '<input type="checkbox" class="contact-checkbox" data-contact-id="' + contactId + '" style="cursor: pointer;">' +
      '</td>';
    
    if (source === "google_maps") {
      row.innerHTML = checkboxCell +
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + displayName + '</strong>' +
          (contact.company_website ? '<br><a href="' + contact.company_website + '" target="_blank" style="color: #999; font-size: 0.75rem;">🔗 Website</a>' : '') +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: ' + (contact.email ? '#0a66c2' : '#999') + ';">' +
          (contact.email || "No email found") +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: #4caf50; font-weight: 600;">' +
          (contact.whatsapp_number || contact.phone_number || contact.mobile_number || "-") +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.75rem; color: #666; max-width: 200px;">' +
          (contact.company_summary ? contact.company_summary.substring(0, 100) + (contact.company_summary.length > 100 ? '...' : '') : contact.location || "-") +
        '</td>';
    } else if (source === "website") {
      var phones = [];
      if (contact.phone_number) phones.push('📞 ' + contact.phone_number);
      if (contact.mobile_number) phones.push('📱 ' + contact.mobile_number);
      var phoneDisplay = phones.length > 0 ? phones.join("<br>") : "-";

      row.innerHTML = checkboxCell +
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + displayName + '</strong>' +
          (contact.company_website ? '<br><a href="' + contact.company_website + '" target="_blank" style="color: #999; font-size: 0.75rem;">🔗 Website</a>' : '') +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: ' + (contact.email ? '#0a66c2' : '#999') + ';">' +
          (contact.email || "No email found") +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: #666;">' +
          phoneDisplay +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.75rem; color: #666; max-width: 200px;">' +
          (contact.company_summary ? contact.company_summary.substring(0, 100) + (contact.company_summary.length > 100 ? '...' : '') : "-") +
        '</td>';
    } else {
      // For LinkedIn, use stored name or extract from email
      let linkedInName = `${contact.first_name || ""} ${contact.last_name || ""}`.trim();
      if (!linkedInName && contact.email) {
        const emailName = extractNameFromEmail(contact.email);
        if (emailName && emailName.fullName) {
          linkedInName = emailName.fullName;
        }
      }
      if (!linkedInName) linkedInName = "N/A";
      
      row.innerHTML = checkboxCell +
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + linkedInName + '</strong>' +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: #0a66c2;">' +
          contact.email +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: #666;">' +
          (contact.job_title || "-") +
        '</td>' +
        '<td style="padding: 12px; font-size: 0.875rem; color: #666;">' +
          (contact.location || "-") +
        '</td>';
    }
    
    // Add event listener to checkbox
    const checkbox = row.querySelector('.contact-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', function(e) {
        const id = e.target.getAttribute('data-contact-id');
        if (e.target.checked) {
          selectedResults.add(id);
        } else {
          selectedResults.delete(id);
        }
        updateSelectAllCheckbox();
      });
    }
    
    resultsTableBody.appendChild(row);
  });
  
  // Add select all functionality
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', function(e) {
      const checkboxes = document.querySelectorAll('.contact-checkbox');
      checkboxes.forEach(function(cb) {
        cb.checked = e.target.checked;
        const id = cb.getAttribute('data-contact-id');
        if (e.target.checked) {
          selectedResults.add(id);
        } else {
          selectedResults.delete(id);
        }
      });
    });
  }
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById("selectAllResults");
  const checkboxes = document.querySelectorAll('.contact-checkbox');
  if (selectAllCheckbox && checkboxes.length > 0) {
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    selectAllCheckbox.checked = allChecked;
  }
}