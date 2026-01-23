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

// LinkedIn form
const linkedinForm = document.getElementById("linkedinForm");
const companyNameInput = document.getElementById("companyName");
const companyDomainInput = document.getElementById("companyDomain");
const maxProfilesInput = document.getElementById("maxProfiles");

// Google Maps form
const googlemapsForm = document.getElementById("googlemapsForm");
const searchQueryInput = document.getElementById("searchQuery");
const maxResultsInput = document.getElementById("maxResults");
const mapsIndustrySelect = document.getElementById("mapsIndustry");
const enableEnrichmentCheckbox = document.getElementById("enableEnrichment");

// Website form
const websiteForm = document.getElementById("websiteForm");
const websiteUrlInput = document.getElementById("websiteUrl");
const websiteIndustrySelect = document.getElementById("websiteIndustry");
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

// Role filter elements
const roleCategories = document.getElementById("roleCategories");
const selectedRolesSummary = document.getElementById("selectedRolesSummary");
const selectedRolesText = document.getElementById("selectedRolesText");

// Track active scraper
let activeScraper = "linkedin";
let currentStats = { total: 0, withEmail: 0, withPhone: 0 };

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
  const allChecked = document.querySelectorAll('.role-group-items input[type="checkbox"]:checked');
  const values = Array.from(allChecked).map(cb => cb.value);
  
  if (values.length === 0) {
    selectedRolesText.textContent = 'None - please select at least one role';
    selectedRolesText.className = 'no-selection';
  } else if (values.length <= 5) {
    selectedRolesText.textContent = values.join(', ');
    selectedRolesText.className = '';
  } else {
    selectedRolesText.textContent = values.slice(0, 5).join(', ') + ' +' + (values.length - 5) + ' more';
    selectedRolesText.className = '';
  }
}

function getSelectedJobTitles() {
  const roleMode = document.querySelector('input[name="roleMode"]:checked');
  if (!roleMode || roleMode.value === 'all') {
    return [];
  }
  const allChecked = document.querySelectorAll('.role-group-items input[type="checkbox"]:checked');
  return Array.from(allChecked).map(cb => cb.value);
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
    const companyName = companyNameInput.value.trim();
    const companyDomain = companyDomainInput.value.trim();
    const maxProfiles = parseInt(maxProfilesInput.value) || 20;
    const jobTitles = getSelectedJobTitles();

    if (!companyName || !companyDomain) {
      alert("Please fill in company name and domain");
      return;
    }

    const roleMode = document.querySelector('input[name="roleMode"]:checked');
    if (roleMode && roleMode.value === 'custom' && jobTitles.length === 0) {
      alert("Please select at least one role, or choose 'All Employees'");
      return;
    }

    config = {
      type: "linkedin",
      companyName,
      companyDomain,
      maxProfiles,
      jobTitles,
    };
  } else if (activeScraper === "googlemaps") {
    const searchQuery = searchQueryInput.value.trim();
    const maxResults = parseInt(maxResultsInput.value) || 50;
    const industry = mapsIndustrySelect ? mapsIndustrySelect.value : null;
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
    const industry = websiteIndustrySelect ? websiteIndustrySelect.value : null;
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
      
      if (resultsCount === 0) {
        completeText.textContent = "No contacts found. Try a different search query, enable more sources, or check if the company has publicly available email addresses.";
      } else {
        completeText.textContent = resultsCount + " contacts added to database.";
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

      displayResults(result.results || []);
      showCard(completeCard);
    } else {
      errorText.textContent = result.error || "Something went wrong";
      showCard(errorCard);
    }
  } catch (error) {
    errorText.textContent = error.message;
    showCard(errorCard);
  }
});

// ============================================
// PROGRESS UPDATES
// ============================================

window.electronAPI.onProgress((progress) => {
  statusText.textContent = progress.status;
  profilesFoundEl.textContent = progress.profilesFound || 0;
  profilesScrapedEl.textContent = progress.profilesScraped || 0;
  
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
// NEW SCRAPE / RETRY
// ============================================

newScrapeBtn.addEventListener("click", function() {
  showCard(inputCard);
  companyNameInput.value = "";
  companyDomainInput.value = "";
  searchQueryInput.value = "";
  websiteUrlInput.value = "";
  
  if (completeStats) completeStats.style.display = "none";
  if (failedUrlsSection) failedUrlsSection.style.display = "none";
  if (emailStatBox) emailStatBox.style.display = "none";
});

retryBtn.addEventListener("click", function() {
  showCard(inputCard);
});

// ============================================
// DISPLAY RESULTS
// ============================================

function displayResults(contacts) {
  resultsTableBody.innerHTML = "";

  if (contacts.length === 0) {
    resultsSection.style.display = "none";
    return;
  }

  resultsSection.style.display = "block";

  contacts.forEach(function(contact) {
    const row = document.createElement("tr");
    row.style.borderBottom = "1px solid #f0f0f0";

    const source = contact.source || "linkedin";

    if (source === "google_maps") {
      row.innerHTML = 
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + (contact.company || contact.first_name || "N/A") + '</strong>' +
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

      row.innerHTML = 
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + (contact.company || contact.first_name) + '</strong>' +
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
      row.innerHTML = 
        '<td style="padding: 12px; font-size: 0.875rem;">' +
          '<strong>' + contact.first_name + ' ' + contact.last_name + '</strong>' +
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
    resultsTableBody.appendChild(row);
  });
}