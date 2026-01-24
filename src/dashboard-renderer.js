// DOM elements
const tableBody = document.getElementById("tableBody");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const sourceFilter = document.getElementById("sourceFilter");
const industryFilter = document.getElementById("industryFilter");
const locationFilter = document.getElementById("locationFilter");
const companyFilter = document.getElementById("companyFilter");
const verificationFilter = document.getElementById("verificationFilter");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const openScraperBtn = document.getElementById("openScraperBtn");
const openScraperBtn2 = document.getElementById("openScraperBtn2");
const contactCount = document.getElementById("contactCount");
const viewTitle = document.getElementById("viewTitle");
const selectAllCheckbox = document.getElementById("selectAll");
const bulkActionsBar = document.getElementById("bulkActionsBar");
const selectedCountEl = document.getElementById("selectedCount");
const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
const verifySelectedBtn = document.getElementById("verifySelectedBtn");

// Stats
const totalContacts = document.getElementById("totalContacts");
const totalCompanies = document.getElementById("totalCompanies");
const linkedinCount = document.getElementById("linkedinCount");
const mapsCount = document.getElementById("mapsCount");
const websiteCount = document.getElementById("websiteCount");
const verifiedCountEl = document.getElementById("verifiedCount");

// Nav counts
const navPeopleCount = document.getElementById("navPeopleCount");
const navCompaniesCount = document.getElementById("navCompaniesCount");
const navLinkedInCount = document.getElementById("navLinkedInCount");
const navMapsCount = document.getElementById("navMapsCount");
const navWebsitesCount = document.getElementById("navWebsitesCount");
const navCampaignsCount = document.getElementById("navCampaignsCount");

// State
let allContacts = [];
let filteredContacts = [];
let currentSort = { column: null, direction: "asc" };
let currentView = "people";
let selectedContacts = new Set();
// Built-in API key - no setup required for marketing team
const DEFAULT_API_KEY = '3868cd81b3ea43e2874cb9500b10188b';
let abstractApiKey = localStorage.getItem('abstractApiKey') || DEFAULT_API_KEY;
let isVerifying = false;

// Email Campaign State
let campaigns = [];
let currentCampaignRecipients = [];
let isSendingEmails = false;
let smtpConnected = false;

// Advanced Filters
const MANAGEMENT_LEVELS = {
  'C-Suite': ['CEO', 'CFO', 'CTO', 'CMO', 'COO', 'Chief', 'Founder', 'President', 'Owner'],
  'VP': ['VP', 'Vice President', 'SVP', 'EVP'],
  'Director': ['Director', 'Head of', 'Head Of'],
  'Manager': ['Manager', 'Team Lead', 'Supervisor', 'Lead'],
  'Senior': ['Senior', 'Sr.', 'Principal', 'Staff'],
  'Entry Level': ['Associate', 'Junior', 'Jr.', 'Coordinator', 'Assistant', 'Intern']
};

const INDUSTRIES = [
  'Technology & Software',
  'Food & Beverages', 
  'Agriculture & Farming',
  'Healthcare & Medical',
  'Finance & Banking',
  'Manufacturing',
  'Retail & E-commerce',
  'Real Estate',
  'Education',
  'Professional Services',
  'Transportation & Logistics',
  'Energy & Utilities',
  'Construction',
  'Media & Entertainment',
  'Hospitality & Tourism',
  'Automotive',
  'Telecommunications',
  'Mining & Resources',
  'Legal Services',
  'Non-Profit'
];

let activeManagementFilters = new Set();
let activeIndustryFilters = new Set();

// Initialize
async function init() {
  await loadContacts();
  await checkSmtpStatus();
  setupEventListeners();
  initAdvancedFilters();
  setupEmailComposer();
  setupSmtpSettings();
  setupEmailGenerator();
  
  // Listen for refresh from main process
  if (window.electronAPI.onRefreshData) {
    window.electronAPI.onRefreshData(() => loadContacts());
  }
  
  // Listen for verification progress
  if (window.electronAPI.onVerificationProgress) {
    window.electronAPI.onVerificationProgress((data) => {
      updateVerificationProgress(data);
    });
  }

  // Listen for email send progress
  if (window.electronAPI.onEmailSendProgress) {
    window.electronAPI.onEmailSendProgress((data) => {
      updateEmailSendProgress(data);
    });
  }
}

// Check SMTP connection status
async function checkSmtpStatus() {
  try {
    const status = await window.electronAPI.getSmtpStatus();
    smtpConnected = status.connected;
    updateSmtpStatusUI();
  } catch (error) {
    console.error('Error checking SMTP status:', error);
  }
}

// Update SMTP status in UI
function updateSmtpStatusUI() {
  const dot = document.getElementById('smtpStatusDot');
  const banner = document.getElementById('smtpStatusBanner');
  
  if (dot) {
    dot.className = 'smtp-status-dot ' + (smtpConnected ? 'connected' : 'disconnected');
  }
  
  if (banner) {
    const indicator = banner.querySelector('.status-indicator');
    const text = banner.querySelector('span:last-child');
    if (indicator) {
      indicator.className = 'status-indicator ' + (smtpConnected ? 'connected' : 'disconnected');
    }
    if (text) {
      text.textContent = smtpConnected ? 'Connected' : 'Not Connected';
    }
  }
}

// Update verification progress UI
function updateVerificationProgress(data) {
  const progressEl = document.getElementById('verificationProgress');
  if (progressEl) {
    progressEl.innerHTML = `Verifying ${data.current}/${data.total}: ${data.email}`;
  }
}

// Update email send progress UI
function updateEmailSendProgress(data) {
  const progressEl = document.getElementById('sendProgress');
  const fillEl = document.getElementById('sendProgressFill');
  const textEl = document.getElementById('sendProgressText');
  
  if (progressEl && fillEl && textEl) {
    progressEl.style.display = 'block';
    const percent = (data.current / data.total) * 100;
    fillEl.style.width = `${percent}%`;
    
    if (data.batchPause) {
      textEl.textContent = `Batch pause... (${data.successCount} sent, ${data.failCount} failed)`;
    } else {
      textEl.textContent = `Sending ${data.current}/${data.total}: ${data.email} (${data.successCount} sent, ${data.failCount} failed)`;
    }
  }
}

// Load contacts from Supabase
async function loadContacts() {
  try {
    const result = await window.electronAPI.loadContacts();

    if (result.success) {
      allContacts = result.contacts;
      applyViewFilter();
      updateStats();
      populateFilters();
      renderTable();
    } else {
      showError(result.error || "Failed to load contacts");
    }
  } catch (error) {
    console.error("Error loading contacts:", error);
    showError("Failed to load contacts");
  }
}

// Apply view filter based on navigation
function applyViewFilter() {
  switch (currentView) {
    case "people":
      filteredContacts = [...allContacts];
      break;
    case "companies":
      const companiesMap = new Map();
      allContacts.forEach((contact) => {
        if (contact.company && !companiesMap.has(contact.company)) {
          companiesMap.set(contact.company, contact);
        }
      });
      filteredContacts = Array.from(companiesMap.values());
      break;
    case "linkedin":
      filteredContacts = allContacts.filter((c) => c.source === "linkedin");
      break;
    case "googlemaps":
      filteredContacts = allContacts.filter((c) => c.source === "google_maps");
      break;
    case "websites":
      filteredContacts = allContacts.filter((c) => c.source === "website");
      break;
    case "campaigns":
      // Campaigns view doesn't filter contacts
      filteredContacts = [];
      break;
    default:
      filteredContacts = [...allContacts];
  }
}

// Update statistics
function updateStats() {
  const total = allContacts.length;
  const companies = new Set(allContacts.map((c) => c.company).filter(Boolean)).size;
  const linkedin = allContacts.filter((c) => c.source === "linkedin").length;
  const maps = allContacts.filter((c) => c.source === "google_maps").length;
  const website = allContacts.filter((c) => c.source === "website").length;
  const verified = allContacts.filter((c) => c.email_verified === true).length;

  if (totalContacts) totalContacts.textContent = total;
  if (totalCompanies) totalCompanies.textContent = companies;
  if (linkedinCount) linkedinCount.textContent = linkedin;
  if (mapsCount) mapsCount.textContent = maps;
  if (websiteCount) websiteCount.textContent = website;
  if (verifiedCountEl) verifiedCountEl.textContent = verified;

  if (navPeopleCount) navPeopleCount.textContent = total;
  if (navCompaniesCount) navCompaniesCount.textContent = companies;
  if (navLinkedInCount) navLinkedInCount.textContent = linkedin;
  if (navMapsCount) navMapsCount.textContent = maps;
  if (navWebsitesCount) navWebsitesCount.textContent = website;
  if (navCampaignsCount) navCampaignsCount.textContent = campaigns.length;

  if (contactCount) {
    contactCount.textContent = `${filteredContacts.length} contact${filteredContacts.length !== 1 ? "s" : ""}`;
  }
}

// Populate filter dropdowns
function populateFilters() {
  // Industries - combine from INDUSTRIES constant and actual data
  const dataIndustries = [...new Set(allContacts.map((c) => c.industry).filter(Boolean))];
  const allIndustries = [...new Set([...INDUSTRIES, ...dataIndustries])].sort();
  
  if (industryFilter) {
    industryFilter.innerHTML = '<option value="">All Industries</option>';
    allIndustries.forEach((ind) => {
      const option = document.createElement("option");
      option.value = ind;
      option.textContent = ind;
      industryFilter.appendChild(option);
    });
  }

  // Locations
  const locations = [...new Set(allContacts.map((c) => c.location).filter(Boolean))].sort();
  if (locationFilter) {
    locationFilter.innerHTML = '<option value="">All Locations</option>';
    locations.forEach((loc) => {
      const option = document.createElement("option");
      option.value = loc;
      option.textContent = loc;
      locationFilter.appendChild(option);
    });
  }

  // Companies
  const companies = [...new Set(allContacts.map((c) => c.company).filter(Boolean))].sort();
  if (companyFilter) {
    companyFilter.innerHTML = '<option value="">All Companies</option>';
    companies.forEach((comp) => {
      const option = document.createElement("option");
      option.value = comp;
      option.textContent = comp;
      companyFilter.appendChild(option);
    });
  }

  // Populate preview contact dropdown for email composer
  populatePreviewContacts();
}

// Populate preview contacts dropdown
function populatePreviewContacts() {
  const previewSelect = document.getElementById('previewContact');
  if (!previewSelect) return;

  previewSelect.innerHTML = '<option value="">Sample Contact</option>';
  
  const contactsWithEmail = allContacts.filter(c => c.email).slice(0, 20);
  contactsWithEmail.forEach(contact => {
    const option = document.createElement('option');
    option.value = contact.id;
    const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.company || 'Unknown';
    option.textContent = `${name} (${contact.email})`;
    previewSelect.appendChild(option);
  });
}

// Render table
function renderTable() {
  if (!tableBody) return;
  
  tableBody.innerHTML = "";
  selectedContacts.clear();
  if (selectAllCheckbox) selectAllCheckbox.checked = false;
  updateBulkActionsBar();

  if (filteredContacts.length === 0) {
    if (allContacts.length === 0) {
      const tableContainer = document.querySelector(".table-container");
      if (tableContainer) tableContainer.style.display = "none";
      if (emptyState) emptyState.style.display = "block";
    } else {
      tableBody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 40px; color: #999;">No contacts match your filters</td></tr>`;
    }
    return;
  }

  const tableContainer = document.querySelector(".table-container");
  if (tableContainer) tableContainer.style.display = "block";
  if (emptyState) emptyState.style.display = "none";

  filteredContacts.forEach((contact) => {
    const row = document.createElement("tr");
    row.dataset.contactId = contact.id;

    // Name display
    const name = contact.source === "linkedin"
      ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
      : contact.company || contact.first_name || "N/A";

    const email = contact.email || "-";
    const company = contact.company || "-";
    const industry = contact.industry || "-";

    // Phone/Job Title based on source
    let phoneJobTitle = "-";
    if (contact.source === "linkedin") {
      phoneJobTitle = contact.job_title || "-";
    } else if (contact.source === "google_maps") {
      const phones = [];
      if (contact.whatsapp_number) phones.push(`📱 ${contact.whatsapp_number}`);
      if (contact.phone_number) phones.push(`📞 ${contact.phone_number}`);
      phoneJobTitle = phones.length > 0 ? phones.join("<br>") : "-";
    } else if (contact.source === "website") {
      const phones = [];
      if (contact.mobile_number) phones.push(`📱 ${contact.mobile_number}`);
      if (contact.phone_number) phones.push(`📞 ${contact.phone_number}`);
      phoneJobTitle = phones.length > 0 ? phones.join("<br>") : "-";
    } else {
      phoneJobTitle = contact.job_title || contact.phone_number || "-";
    }

    const location = contact.location || "-";

    // Source badge
    let sourceBadge = "";
    if (contact.source === "linkedin") {
      sourceBadge = '<span class="source-badge source-linkedin">LinkedIn</span>';
    } else if (contact.source === "google_maps") {
      sourceBadge = '<span class="source-badge source-maps">Google Maps</span>';
    } else if (contact.source === "website") {
      sourceBadge = '<span class="source-badge source-website">Website</span>';
    } else if (contact.source === "manual") {
      sourceBadge = '<span class="source-badge source-manual">Manual</span>';
    }

    // Verification badge with visual indicators
    let verifiedBadge = '';
    if (contact.email_verified === true) {
      verifiedBadge = `
        <span class="verified-badge verified" title="Email verified as deliverable">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          Verified
        </span>`;
    } else if (contact.verification_status === 'verifying') {
      verifiedBadge = '<span class="verified-badge verifying"><span class="spinner-small"></span>Verifying...</span>';
    } else if (contact.verification_status === 'risky') {
      verifiedBadge = `
        <span class="verified-badge risky" title="Email may be risky">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
          </svg>
          Risky
        </span>`;
    } else if (contact.verification_status === 'invalid') {
      verifiedBadge = `
        <span class="verified-badge invalid" title="Email is invalid">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
          Invalid
        </span>`;
    } else if (contact.verification_status === 'quota_exceeded') {
      verifiedBadge = `
        <span class="verified-badge quota-exceeded" title="API quota exceeded - could not verify">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          Quota Exceeded
        </span>`;
    } else if (contact.email && contact.email !== '-') {
      verifiedBadge = '<span class="verified-badge unverified">Unverified</span>';
    } else {
      verifiedBadge = '<span class="verified-badge no-email">No Email</span>';
    }

    // Format date added
    let dateAdded = "-";
    if (contact.created_at) {
      try {
        const date = new Date(contact.created_at);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) {
          dateAdded = "Just now";
        } else if (diffMins < 60) {
          dateAdded = `${diffMins}m ago`;
        } else if (diffHours < 24) {
          dateAdded = `${diffHours}h ago`;
        } else if (diffDays < 7) {
          dateAdded = `${diffDays}d ago`;
        } else {
          // Format as date: Jan 15, 2024
          dateAdded = date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined 
          });
        }
      } catch (e) {
        dateAdded = "-";
      }
    }

    row.innerHTML = `
      <td><input type="checkbox" class="row-checkbox" data-id="${contact.id}"></td>
      <td><span class="contact-name">${name}</span></td>
      <td><span class="contact-email">${email}</span></td>
      <td>${company}</td>
      <td><span class="industry-cell">${industry}</span></td>
      <td>${phoneJobTitle}</td>
      <td>${location}</td>
      <td>${sourceBadge}</td>
      <td>${verifiedBadge}</td>
      <td><span class="date-added" title="${contact.created_at ? new Date(contact.created_at).toLocaleString() : ''}">${dateAdded}</span></td>
      <td>
        <button class="btn-delete" data-id="${contact.id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </td>
    `;

    tableBody.appendChild(row);
  });

  // Add event listeners
  document.querySelectorAll(".row-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", handleCheckboxChange);
  });

  document.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", handleDeleteSingle);
  });
}

// Handle checkbox change
function handleCheckboxChange(e) {
  const id = e.target.dataset.id;
  if (e.target.checked) {
    selectedContacts.add(id);
  } else {
    selectedContacts.delete(id);
  }
  updateBulkActionsBar();
}

// Update bulk actions bar
function updateBulkActionsBar() {
  const count = selectedContacts.size;
  const emailSelectedBtn = document.getElementById('emailSelectedBtn');
  const emailSelectedBtn2 = document.getElementById('emailSelectedBtn2');
  
  if (count > 0) {
    if (bulkActionsBar) bulkActionsBar.style.display = "flex";
    if (selectedCountEl) selectedCountEl.textContent = `${count} selected`;
    if (verifySelectedBtn) verifySelectedBtn.style.display = "flex";
    if (emailSelectedBtn) emailSelectedBtn.style.display = "flex";
  } else {
    if (bulkActionsBar) bulkActionsBar.style.display = "none";
    if (verifySelectedBtn) verifySelectedBtn.style.display = "none";
    if (emailSelectedBtn) emailSelectedBtn.style.display = "none";
  }
}

// Handle single delete
async function handleDeleteSingle(e) {
  const id = e.target.closest(".btn-delete").dataset.id;
  if (!confirm("Are you sure you want to delete this contact?")) return;
  await deleteContacts([id]);
}

// Handle bulk delete
async function handleDeleteSelected() {
  const count = selectedContacts.size;
  if (!confirm(`Are you sure you want to delete ${count} contact${count !== 1 ? "s" : ""}?`)) return;
  await deleteContacts(Array.from(selectedContacts));
}

// Delete contacts
async function deleteContacts(ids) {
  try {
    const result = await window.electronAPI.deleteContacts(ids);
    if (result.success) {
      allContacts = allContacts.filter((c) => !ids.includes(c.id));
      selectedContacts.clear();
      applyViewFilter();
      applyFilters();
      updateStats();
      renderTable();
    } else {
      alert("Failed to delete contacts: " + result.error);
    }
  } catch (error) {
    alert("Error deleting contacts: " + error.message);
  }
}

// Verify selected emails - BULK VERIFICATION
async function verifySelectedEmails() {
  if (isVerifying) {
    alert('Verification already in progress!');
    return;
  }
  
  // Use built-in API key - no prompt needed
  if (!abstractApiKey) {
    abstractApiKey = DEFAULT_API_KEY;
  }

  const selectedIds = Array.from(selectedContacts);
  const contactsToVerify = allContacts.filter(c => 
    selectedIds.includes(c.id) && 
    c.email && 
    c.email !== '-' &&
    !c.email_verified // Don't re-verify already verified emails
  );

  if (contactsToVerify.length === 0) {
    alert('No unverified contacts with emails selected!\n\nTip: Select contacts that show "Unverified" status.');
    return;
  }

  // Simple confirmation
  if (!confirm(`Verify ${contactsToVerify.length} email(s)?\n\nThis will check if the emails are real and deliverable.`)) {
    return;
  }

  isVerifying = true;
  
  // Update UI to show verifying state
  const verifyBtn = verifySelectedBtn;
  const verifyBtn2Elem = document.getElementById('verifySelectedBtn2');
  
  const updateVerifyButtons = (html, disabled) => {
    if (verifyBtn) {
      verifyBtn.innerHTML = html;
      verifyBtn.disabled = disabled;
    }
    if (verifyBtn2Elem) {
      verifyBtn2Elem.innerHTML = html;
      verifyBtn2Elem.disabled = disabled;
    }
  };
  
  updateVerifyButtons(`<span class="spinner-small"></span> Verifying...`, true);

  // Mark contacts as verifying in UI
  contactsToVerify.forEach(c => {
    c.verification_status = 'verifying';
  });
  renderTable();

  try {
    // Prepare email data for API
    const emailData = contactsToVerify.map(c => ({
      id: c.id,
      email: c.email
    }));

    // Call bulk verify
    const result = await window.electronAPI.verifyEmails(emailData, abstractApiKey);

    if (result.success) {
      // Update local state with results
      let verifiedCount = 0;
      let invalidCount = 0;
      
      result.results.forEach(res => {
        const contact = allContacts.find(c => c.id === res.id);
        if (contact) {
          contact.email_verified = res.verified;
          contact.verification_status = res.status;
          
          if (res.verified) verifiedCount++;
          else if (res.status === 'invalid') invalidCount++;
        }
      });

      // Count quota exceeded
      const quotaExceededCount = result.results.filter(r => r.status === 'quota_exceeded').length;
      
      // Show friendly results
      let message = `✅ Verification Complete!\n\n`;
      message += `📧 Checked: ${result.results.length} emails\n`;
      message += `✓ Valid: ${verifiedCount}\n`;
      message += `✗ Invalid/Risky: ${result.results.length - verifiedCount - quotaExceededCount}`;
      
      if (quotaExceededCount > 0) {
        message += `\n⚠️ Quota Exceeded: ${quotaExceededCount} emails could not be verified`;
        message += `\n\n💡 Tip: Upgrade your Abstract API plan or use a different API key to verify more emails.`;
      }
      
      alert(message);
    } else {
      alert('Verification failed: ' + result.error);
    }
  } catch (error) {
    console.error('Bulk verification error:', error);
    alert('Error during verification: ' + error.message);
  } finally {
    isVerifying = false;
    updateVerifyButtons(`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      Verify Emails
    `, false);
    selectedContacts.clear();
    updateStats();
    renderTable();
    updateBulkActionsBar();
  }
}

// Show API key modal
function showApiKeyModal() {
  const modal = document.getElementById('apiKeyModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('apiKeyInput').value = abstractApiKey;
  }
}

function saveApiKeyAndVerify() {
  abstractApiKey = document.getElementById('apiKeyInput').value.trim();
  if (!abstractApiKey) {
    alert('Please enter an API key');
    return;
  }
  localStorage.setItem('abstractApiKey', abstractApiKey);
  document.getElementById('apiKeyModal').style.display = 'none';
  verifySelectedEmails();
}

// Apply filters
function applyFilters() {
  const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
  const sourceValue = sourceFilter ? sourceFilter.value : '';
  const industryValue = industryFilter ? industryFilter.value : '';
  const locationValue = locationFilter ? locationFilter.value : '';
  const companyValue = companyFilter ? companyFilter.value : '';
  const verificationValue = verificationFilter ? verificationFilter.value : '';

  applyViewFilter();

  filteredContacts = filteredContacts.filter((contact) => {
    // Search filter
    if (searchTerm) {
      const searchableText = [
        contact.first_name, contact.last_name, contact.email,
        contact.company, contact.job_title, contact.location, 
        contact.industry, contact.keywords
      ].filter(Boolean).join(" ").toLowerCase();
      if (!searchableText.includes(searchTerm)) return false;
    }

    // Dropdown filters
    if (sourceValue && contact.source !== sourceValue) return false;
    if (industryValue && contact.industry !== industryValue) return false;
    if (locationValue && contact.location !== locationValue) return false;
    if (companyValue && contact.company !== companyValue) return false;
    
    // Verification filter
    if (verificationValue === 'verified' && !contact.email_verified) return false;
    if (verificationValue === 'unverified' && (contact.email_verified || !contact.email)) return false;

    // Management level filter
    if (activeManagementFilters.size > 0 && contact.job_title) {
      let matchesLevel = false;
      for (const level of activeManagementFilters) {
        const keywords = MANAGEMENT_LEVELS[level];
        if (keywords.some(kw => contact.job_title.toLowerCase().includes(kw.toLowerCase()))) {
          matchesLevel = true;
          break;
        }
      }
      if (!matchesLevel) return false;
    }

    // Industry checkbox filter
    if (activeIndustryFilters.size > 0) {
      if (!contact.industry || !activeIndustryFilters.has(contact.industry)) return false;
    }

    return true;
  });

  if (contactCount) {
    contactCount.textContent = `${filteredContacts.length} contact${filteredContacts.length !== 1 ? "s" : ""}`;
  }
  renderTable();
}

// Clear filters
function clearFilters() {
  if (searchInput) searchInput.value = "";
  if (sourceFilter) sourceFilter.value = "";
  if (industryFilter) industryFilter.value = "";
  if (locationFilter) locationFilter.value = "";
  if (companyFilter) companyFilter.value = "";
  if (verificationFilter) verificationFilter.value = "";
  
  // Clear advanced filters
  activeManagementFilters.clear();
  activeIndustryFilters.clear();
  document.querySelectorAll('#managementLevelFilters input, #industryCheckboxFilters input').forEach(cb => {
    cb.checked = false;
  });
  updateFilterBadge();
  
  applyFilters();
}

// Sort table
function sortTable(column) {
  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === "asc" ? "desc" : "asc";
  } else {
    currentSort.column = column;
    currentSort.direction = "asc";
  }

  filteredContacts.sort((a, b) => {
    let aVal = a[column] || "";
    let bVal = b[column] || "";
    
    // Special handling for email_verified (boolean)
    if (column === 'email_verified') {
      aVal = a.email_verified ? 1 : 0;
      bVal = b.email_verified ? 1 : 0;
    } else if (column === 'created_at') {
      // Special handling for dates
      aVal = a.created_at ? new Date(a.created_at).getTime() : 0;
      bVal = b.created_at ? new Date(b.created_at).getTime() : 0;
    } else if (typeof aVal === "string") {
      aVal = aVal.toLowerCase();
      bVal = bVal.toLowerCase();
    }
    
    if (aVal < bVal) return currentSort.direction === "asc" ? -1 : 1;
    if (aVal > bVal) return currentSort.direction === "asc" ? 1 : -1;
    return 0;
  });

  // Update sort indicator
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sorted", "sorted-asc", "sorted-desc");
  });
  const sortedTh = document.querySelector(`th[data-sort="${column}"]`);
  if (sortedTh) {
    sortedTh.classList.add("sorted", `sorted-${currentSort.direction}`);
  }
  
  renderTable();
}

// Export to CSV
function exportToCSV() {
  if (filteredContacts.length === 0) {
    alert("No contacts to export");
    return;
  }

  const headers = [
    "Name", "Email", "Company", "Industry", "Keywords", "Job Title", 
    "Phone", "WhatsApp", "Mobile", "Location", "Source", "Verified", "Website"
  ];
  
  const rows = filteredContacts.map((contact) => {
    const name = contact.source === "linkedin"
      ? `${contact.first_name || ""} ${contact.last_name || ""}`.trim()
      : contact.company || contact.first_name || "";

    return [
      name,
      contact.email || "",
      contact.company || "",
      contact.industry || "",
      contact.keywords || "",
      contact.job_title || "",
      contact.phone_number || "",
      contact.whatsapp_number || "",
      contact.mobile_number || "",
      contact.location || "",
      contact.source || "",
      contact.email_verified ? "Yes" : "No",
      contact.company_website || ""
    ];
  });

  const csvContent = [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `contacts_export_${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Show error
function showError(message) {
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 40px; color: #f44336;"><strong>Error:</strong> ${message}</td></tr>`;
  }
}

// Initialize advanced filters
function initAdvancedFilters() {
  const managementContainer = document.getElementById('managementLevelFilters');
  const industryContainer = document.getElementById('industryCheckboxFilters');
  
  if (!managementContainer || !industryContainer) return;
  
  // Management level checkboxes
  Object.entries(MANAGEMENT_LEVELS).forEach(([level]) => {
    const div = document.createElement('div');
    div.className = 'filter-checkbox';
    const id = `mgmt-${level.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')}`;
    div.innerHTML = `
      <input type="checkbox" id="${id}" data-level="${level}">
      <label for="${id}">${level}</label>
    `;
    managementContainer.appendChild(div);
    div.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeManagementFilters.add(level);
      else activeManagementFilters.delete(level);
      updateFilterBadge();
      applyFilters();
    });
  });
  
  // Industry checkboxes
  INDUSTRIES.forEach(industry => {
    const div = document.createElement('div');
    div.className = 'filter-checkbox';
    const id = `ind-${industry.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')}`;
    div.innerHTML = `
      <input type="checkbox" id="${id}" data-industry="${industry}">
      <label for="${id}">${industry}</label>
    `;
    industryContainer.appendChild(div);
    div.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) activeIndustryFilters.add(industry);
      else activeIndustryFilters.delete(industry);
      updateFilterBadge();
      applyFilters();
    });
  });
  
  // Collapsible sections
  document.querySelectorAll('.filter-section-title').forEach(title => {
    title.addEventListener('click', () => title.parentElement.classList.toggle('collapsed'));
  });
  
  // Toggle filters panel
  const toggleBtn = document.getElementById('toggleFiltersBtn');
  const closeBtn = document.getElementById('closeFiltersBtn');
  const filtersPanel = document.getElementById('filtersPanel');
  
  if (toggleBtn && filtersPanel) {
    toggleBtn.addEventListener('click', () => filtersPanel.classList.toggle('open'));
  }
  if (closeBtn && filtersPanel) {
    closeBtn.addEventListener('click', () => filtersPanel.classList.remove('open'));
  }
}

function updateFilterBadge() {
  const count = activeManagementFilters.size + activeIndustryFilters.size;
  const badge = document.getElementById('filterBadge');
  if (badge) {
    if (count > 0) {
      badge.style.display = 'inline-block';
      badge.textContent = count;
    } else {
      badge.style.display = 'none';
    }
  }
}

// ============================================
// WEEK 3: EMAIL CAMPAIGN FUNCTIONALITY
// ============================================

// Setup SMTP Settings Modal
function setupSmtpSettings() {
  const smtpSettingsBtn = document.getElementById('smtpSettingsBtn');
  const smtpModal = document.getElementById('smtpModal');
  const closeSmtpModal = document.getElementById('closeSmtpModal');
  const smtpForm = document.getElementById('smtpForm');
  const testSmtpBtn = document.getElementById('testSmtpBtn');
  const disconnectSmtpBtn = document.getElementById('disconnectSmtpBtn');

  if (!smtpSettingsBtn || !smtpModal) return;

  // Open modal
  smtpSettingsBtn.addEventListener('click', () => {
    smtpModal.style.display = 'flex';
  });

  // Close modal
  if (closeSmtpModal) {
    closeSmtpModal.addEventListener('click', () => {
      smtpModal.style.display = 'none';
    });
  }

  // SMTP Presets
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const hostInput = document.getElementById('smtpHost');
      const portInput = document.getElementById('smtpPort');
      const secureInput = document.getElementById('smtpSecure');

      const presets = {
        gmail: { host: 'smtp.gmail.com', port: '587', secure: 'false' },
        outlook: { host: 'smtp.office365.com', port: '587', secure: 'false' },
        mailgun: { host: 'smtp.mailgun.org', port: '587', secure: 'false' },
        sendgrid: { host: 'smtp.sendgrid.net', port: '587', secure: 'false' }
      };

      if (presets[preset]) {
        hostInput.value = presets[preset].host;
        portInput.value = presets[preset].port;
        secureInput.value = presets[preset].secure;
      }
    });
  });

  // Test connection
  if (testSmtpBtn) {
    testSmtpBtn.addEventListener('click', async () => {
      testSmtpBtn.disabled = true;
      testSmtpBtn.textContent = 'Testing...';

      try {
        const result = await window.electronAPI.testSmtp();
        if (result.success) {
          alert('✅ SMTP connection is working!');
        } else {
          alert('❌ Connection failed: ' + result.error);
        }
      } catch (error) {
        alert('Error testing connection: ' + error.message);
      } finally {
        testSmtpBtn.disabled = false;
        testSmtpBtn.textContent = 'Test Connection';
      }
    });
  }

  // Disconnect
  if (disconnectSmtpBtn) {
    disconnectSmtpBtn.addEventListener('click', async () => {
      try {
        await window.electronAPI.disconnectSmtp();
        smtpConnected = false;
        updateSmtpStatusUI();
        alert('SMTP disconnected');
      } catch (error) {
        alert('Error disconnecting: ' + error.message);
      }
    });
  }

  // Submit form
  if (smtpForm) {
    smtpForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const config = {
        host: document.getElementById('smtpHost').value,
        port: document.getElementById('smtpPort').value,
        secure: document.getElementById('smtpSecure').value === 'true',
        user: document.getElementById('smtpUser').value,
        pass: document.getElementById('smtpPass').value
      };

      const submitBtn = smtpForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connecting...';

      try {
        const result = await window.electronAPI.configureSmtp(config);
        if (result.success) {
          smtpConnected = true;
          updateSmtpStatusUI();
          alert('✅ SMTP connected successfully!');
          smtpModal.style.display = 'none';
        } else {
          alert('❌ Connection failed: ' + result.error);
        }
      } catch (error) {
        alert('Error connecting: ' + error.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Connect';
      }
    });
  }
}

// Setup Email Composer
function setupEmailComposer() {
  const composerModal = document.getElementById('emailComposerModal');
  const closeComposerModal = document.getElementById('closeComposerModal');
  const emailEditor = document.getElementById('emailEditor');
  const emailSubject = document.getElementById('emailSubject');
  const insertVariable = document.getElementById('insertVariable');
  const previewContact = document.getElementById('previewContact');
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  const sendTestBtn = document.getElementById('sendTestBtn');
  const sendCampaignBtn = document.getElementById('sendCampaignBtn');

  if (!composerModal) return;

  // Close modal
  if (closeComposerModal) {
    closeComposerModal.addEventListener('click', () => {
      if (isSendingEmails) {
        if (!confirm('Email sending is in progress. Are you sure you want to close?')) {
          return;
        }
      }
      composerModal.style.display = 'none';
    });
  }

  // Editor toolbar buttons
  document.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (!action) return;

      if (action === 'bold') {
        document.execCommand('bold', false, null);
      } else if (action === 'italic') {
        document.execCommand('italic', false, null);
      } else if (action === 'underline') {
        document.execCommand('underline', false, null);
      } else if (action === 'link') {
        const url = prompt('Enter URL:');
        if (url) {
          document.execCommand('createLink', false, url);
        }
      } else if (action === 'image') {
        const url = prompt('Enter image URL:');
        if (url) {
          document.execCommand('insertImage', false, url);
        }
      }
      emailEditor.focus();
    });
  });

  // Insert variable
  if (insertVariable) {
    insertVariable.addEventListener('change', () => {
      const variable = insertVariable.value;
      if (variable) {
        document.execCommand('insertText', false, variable);
        insertVariable.value = '';
        emailEditor.focus();
      }
    });
  }

  // Live preview update
  const updatePreview = () => {
    const previewSubject = document.getElementById('previewSubject');
    const previewBody = document.getElementById('previewBody');
    
    if (!previewSubject || !previewBody) return;

    // Get sample contact for preview
    let sampleContact = {
      first_name: 'John',
      last_name: 'Doe',
      full_name: 'John Doe',
      email: 'john@example.com',
      company: 'Acme Corp',
      job_title: 'CEO',
      location: 'Johannesburg',
      industry: 'Technology'
    };

    // Use selected preview contact if available
    if (previewContact && previewContact.value) {
      const contact = allContacts.find(c => c.id === previewContact.value);
      if (contact) {
        sampleContact = {
          first_name: contact.first_name || '',
          last_name: contact.last_name || '',
          full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
          email: contact.email || '',
          company: contact.company || '',
          job_title: contact.job_title || '',
          location: contact.location || '',
          industry: contact.industry || ''
        };
      }
    }

    // Replace variables in subject
    let subject = emailSubject ? emailSubject.value : '';
    subject = replaceVariables(subject, sampleContact);
    previewSubject.textContent = subject || '(No subject)';

    // Replace variables in body
    let body = emailEditor ? emailEditor.innerHTML : '';
    body = replaceVariables(body, sampleContact);
    previewBody.innerHTML = body || '<p>(No content)</p>';
  };

  if (emailSubject) {
    emailSubject.addEventListener('input', updatePreview);
  }
  if (emailEditor) {
    emailEditor.addEventListener('input', updatePreview);
  }
  if (previewContact) {
    previewContact.addEventListener('change', updatePreview);
  }

  // Initial preview update
  setTimeout(updatePreview, 100);

  // Save draft
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', async () => {
      const campaignName = document.getElementById('campaignName')?.value || 'Untitled Campaign';
      const subject = emailSubject?.value || '';
      const htmlContent = emailEditor?.innerHTML || '';
      const replyTo = document.getElementById('replyToEmail')?.value || '';

      if (!subject || !htmlContent) {
        alert('Please enter a subject and email content');
        return;
      }

      saveDraftBtn.disabled = true;
      saveDraftBtn.textContent = 'Saving...';

      try {
        const result = await window.electronAPI.saveCampaign({
          name: campaignName,
          subject: subject,
          htmlContent: htmlContent,
          textContent: htmlContent.replace(/<[^>]*>/g, ''),
          replyTo: replyTo,
          status: 'draft'
        });

        if (result.success) {
          alert('✅ Campaign saved as draft!');
        } else {
          alert('Failed to save: ' + result.error);
        }
      } catch (error) {
        alert('Error saving campaign: ' + error.message);
      } finally {
        saveDraftBtn.disabled = false;
        saveDraftBtn.textContent = 'Save as Draft';
      }
    });
  }

  // Send test email
  if (sendTestBtn) {
    sendTestBtn.addEventListener('click', () => {
      const testModal = document.getElementById('testEmailModal');
      if (testModal) {
        testModal.style.display = 'flex';
      }
    });
  }

  // Test email modal handlers
  const cancelTestEmailBtn = document.getElementById('cancelTestEmailBtn');
  const confirmTestEmailBtn = document.getElementById('confirmTestEmailBtn');

  if (cancelTestEmailBtn) {
    cancelTestEmailBtn.addEventListener('click', () => {
      document.getElementById('testEmailModal').style.display = 'none';
    });
  }

  if (confirmTestEmailBtn) {
    confirmTestEmailBtn.addEventListener('click', async () => {
      const testEmail = document.getElementById('testEmailAddress')?.value;
      if (!testEmail) {
        alert('Please enter a test email address');
        return;
      }

      if (!smtpConnected) {
        alert('Please configure SMTP settings first');
        return;
      }

      confirmTestEmailBtn.disabled = true;
      confirmTestEmailBtn.textContent = 'Sending...';

      try {
        const subject = emailSubject?.value || 'Test Email';
        const html = emailEditor?.innerHTML || '';

        // Use sample data for test
        const sampleContact = {
          first_name: 'Test',
          last_name: 'User',
          company: 'Test Company',
          job_title: 'Tester'
        };

        const result = await window.electronAPI.sendEmail({
          to: testEmail,
          subject: replaceVariables(subject, sampleContact),
          html: replaceVariables(html, sampleContact)
        });

        if (result.success) {
          alert('✅ Test email sent successfully!');
          document.getElementById('testEmailModal').style.display = 'none';
        } else {
          alert('❌ Failed to send: ' + result.error);
        }
      } catch (error) {
        alert('Error sending test email: ' + error.message);
      } finally {
        confirmTestEmailBtn.disabled = false;
        confirmTestEmailBtn.textContent = 'Send Test';
      }
    });
  }

  // Send campaign
  if (sendCampaignBtn) {
    sendCampaignBtn.addEventListener('click', async () => {
      if (!smtpConnected) {
        alert('Please configure SMTP settings first');
        return;
      }

      if (currentCampaignRecipients.length === 0) {
        alert('No recipients selected. Please select contacts to email.');
        return;
      }

      const subject = emailSubject?.value;
      const html = emailEditor?.innerHTML;

      if (!subject || !html) {
        alert('Please enter a subject and email content');
        return;
      }

      const confirmMsg = `Send email to ${currentCampaignRecipients.length} recipient(s)?\n\nSubject: ${subject}`;
      if (!confirm(confirmMsg)) return;

      isSendingEmails = true;
      sendCampaignBtn.disabled = true;
      sendCampaignBtn.innerHTML = '<span class="spinner-small"></span> Sending...';

      const delay = parseInt(document.getElementById('emailDelay')?.value || '2000');
      const batchSize = parseInt(document.getElementById('batchSize')?.value || '50');

      try {
        const result = await window.electronAPI.sendBulkEmails({
          contacts: currentCampaignRecipients,
          subject: subject,
          htmlTemplate: html,
          delayBetweenEmails: delay,
          batchSize: batchSize,
          delayBetweenBatches: 60000
        });

        if (result.success) {
          const { sent, failed, total } = result.summary;
          alert(`✅ Campaign Complete!\n\nSent: ${sent}\nFailed: ${failed}\nTotal: ${total}`);
          
          // Reset progress
          const progressEl = document.getElementById('sendProgress');
          if (progressEl) progressEl.style.display = 'none';
          
          composerModal.style.display = 'none';
        } else {
          alert('❌ Campaign failed: ' + result.error);
        }
      } catch (error) {
        alert('Error sending campaign: ' + error.message);
      } finally {
        isSendingEmails = false;
        sendCampaignBtn.disabled = false;
        sendCampaignBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
          Send Campaign
        `;
      }
    });
  }
}

// Replace template variables
function replaceVariables(template, contact) {
  if (!template) return '';
  
  let result = template;
  
  // Standard replacements
  const replacements = {
    '{{first_name}}': contact.first_name || '',
    '{{last_name}}': contact.last_name || '',
    '{{full_name}}': contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
    '{{email}}': contact.email || '',
    '{{company}}': contact.company || '',
    '{{job_title}}': contact.job_title || '',
    '{{location}}': contact.location || '',
    '{{industry}}': contact.industry || ''
  };

  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'gi'), value);
  }

  // Handle fallback syntax: {{variable|fallback}}
  result = result.replace(/\{\{(\w+)\|([^}]+)\}\}/g, (match, variable, fallback) => {
    const value = contact[variable.toLowerCase()] || contact[variable];
    return value || fallback;
  });

  return result;
}

// Open email composer with selected contacts
function openEmailComposer() {
  if (!smtpConnected) {
    const proceed = confirm('SMTP is not configured. Configure SMTP settings first?');
    if (proceed) {
      document.getElementById('smtpModal').style.display = 'flex';
    }
    return;
  }

  const selectedIds = Array.from(selectedContacts);
  currentCampaignRecipients = allContacts.filter(c => 
    selectedIds.includes(c.id) && c.email && c.email !== '-'
  );

  if (currentCampaignRecipients.length === 0) {
    alert('No contacts with valid emails selected');
    return;
  }

  // Update recipients list
  const recipientsList = document.getElementById('recipientsList');
  const recipientCount = document.getElementById('recipientCount');

  if (recipientCount) {
    recipientCount.textContent = currentCampaignRecipients.length;
  }

  if (recipientsList) {
    if (currentCampaignRecipients.length === 0) {
      recipientsList.innerHTML = '<p class="no-recipients">No recipients selected</p>';
    } else {
      recipientsList.innerHTML = currentCampaignRecipients.slice(0, 10).map(contact => {
        const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || contact.company || 'Unknown';
        const initials = name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        return `
          <div class="recipient-item">
            <div class="recipient-avatar">${initials}</div>
            <div class="recipient-info">
              <div class="recipient-name">${name}</div>
              <div class="recipient-email">${contact.email}</div>
            </div>
          </div>
        `;
      }).join('');

      if (currentCampaignRecipients.length > 10) {
        recipientsList.innerHTML += `<p style="text-align: center; color: #666; font-size: 12px; margin-top: 8px;">+ ${currentCampaignRecipients.length - 10} more</p>`;
      }
    }
  }

  // Reset progress bar
  const progressEl = document.getElementById('sendProgress');
  if (progressEl) progressEl.style.display = 'none';

  // Show composer
  const composerModal = document.getElementById('emailComposerModal');
  if (composerModal) {
    composerModal.style.display = 'flex';
  }
}

// Setup Email Generator
function setupEmailGenerator() {
  const generatorModal = document.getElementById('emailGeneratorModal');
  const closeGeneratorModal = document.getElementById('closeGeneratorModal');
  const closeGeneratorBtn = document.getElementById('closeGeneratorBtn');
  const generateEmailsBtn = document.getElementById('generateEmailsBtn');
  const copyGeneratedBtn = document.getElementById('copyGeneratedBtn');

  if (!generatorModal) return;

  // Close handlers
  if (closeGeneratorModal) {
    closeGeneratorModal.addEventListener('click', () => {
      generatorModal.style.display = 'none';
    });
  }
  if (closeGeneratorBtn) {
    closeGeneratorBtn.addEventListener('click', () => {
      generatorModal.style.display = 'none';
    });
  }

  // Generate emails
  if (generateEmailsBtn) {
    generateEmailsBtn.addEventListener('click', async () => {
      const domain = document.getElementById('generatorDomain')?.value;
      const prefix = document.getElementById('generatorPrefix')?.value || '';
      const count = parseInt(document.getElementById('generatorCount')?.value || '10');

      if (!domain) {
        alert('Please enter a domain');
        return;
      }

      generateEmailsBtn.disabled = true;
      generateEmailsBtn.textContent = 'Generating...';

      try {
        const emails = [];
        for (let i = 0; i < count; i++) {
          const result = await window.electronAPI.generateRandomEmail(domain, prefix);
          if (result.success) {
            emails.push(result.email);
          }
        }

        const generatedEmails = document.getElementById('generatedEmails');
        const generatedEmailsList = document.getElementById('generatedEmailsList');
        
        if (generatedEmails && generatedEmailsList) {
          generatedEmails.style.display = 'block';
          generatedEmailsList.value = emails.join('\n');
        }
      } catch (error) {
        alert('Error generating emails: ' + error.message);
      } finally {
        generateEmailsBtn.disabled = false;
        generateEmailsBtn.textContent = 'Generate';
      }
    });
  }

  // Copy to clipboard
  if (copyGeneratedBtn) {
    copyGeneratedBtn.addEventListener('click', () => {
      const textarea = document.getElementById('generatedEmailsList');
      if (textarea) {
        textarea.select();
        document.execCommand('copy');
        copyGeneratedBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyGeneratedBtn.textContent = 'Copy to Clipboard';
        }, 2000);
      }
    });
  }
}

// Switch to campaigns view
function showCampaignsView() {
  const tableContainer = document.getElementById('tableContainer');
  const filtersBar = document.getElementById('filtersBar');
  const campaignsView = document.getElementById('campaignsView');
  const emptyState = document.getElementById('emptyState');

  if (tableContainer) tableContainer.style.display = 'none';
  if (filtersBar) filtersBar.style.display = 'none';
  if (emptyState) emptyState.style.display = 'none';
  if (campaignsView) campaignsView.style.display = 'block';

  loadCampaigns();
}

// Show contacts view
function showContactsView() {
  const tableContainer = document.getElementById('tableContainer');
  const filtersBar = document.getElementById('filtersBar');
  const campaignsView = document.getElementById('campaignsView');

  if (campaignsView) campaignsView.style.display = 'none';
  if (filtersBar) filtersBar.style.display = 'flex';
  if (tableContainer) tableContainer.style.display = 'block';
  
  renderTable();
}

// Load campaigns
async function loadCampaigns() {
  // For now, we'll show a placeholder since campaigns table may not exist yet
  const campaignsGrid = document.getElementById('campaignsGrid');
  const campaignsEmpty = document.getElementById('campaignsEmpty');

  try {
    const result = await window.electronAPI.loadCampaigns();
    
    if (result.success && result.campaigns && result.campaigns.length > 0) {
      campaigns = result.campaigns;
      if (campaignsGrid) {
        campaignsGrid.style.display = 'grid';
        campaignsGrid.innerHTML = campaigns.map(campaign => `
          <div class="campaign-card" data-id="${campaign.id}">
            <div class="campaign-card-header">
              <h4>${campaign.name || 'Untitled'}</h4>
              <span class="campaign-status ${campaign.status || 'draft'}">${campaign.status || 'Draft'}</span>
            </div>
            <div class="campaign-card-body">
              <p class="campaign-subject">${campaign.subject || 'No subject'}</p>
              <div class="campaign-stats">
                <span class="campaign-stat">Created: ${new Date(campaign.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <div class="campaign-card-footer">
              <button class="btn-campaign-edit" data-id="${campaign.id}">Edit</button>
              <button class="btn-campaign-send" data-id="${campaign.id}">Send</button>
              <button class="btn-campaign-delete" data-id="${campaign.id}">🗑️</button>
            </div>
          </div>
        `).join('');

        // Add event listeners
        document.querySelectorAll('.btn-campaign-delete').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const id = e.target.dataset.id;
            if (confirm('Delete this campaign?')) {
              await window.electronAPI.deleteCampaign(id);
              loadCampaigns();
            }
          });
        });
      }
      if (campaignsEmpty) campaignsEmpty.style.display = 'none';
    } else {
      if (campaignsGrid) campaignsGrid.style.display = 'none';
      if (campaignsEmpty) campaignsEmpty.style.display = 'block';
    }
  } catch (error) {
    console.log('Campaigns table may not exist yet:', error.message);
    if (campaignsGrid) campaignsGrid.style.display = 'none';
    if (campaignsEmpty) campaignsEmpty.style.display = 'block';
  }

  // Update nav count
  if (navCampaignsCount) {
    navCampaignsCount.textContent = campaigns.length;
  }
}

// Setup event listeners
function setupEventListeners() {
  if (searchInput) searchInput.addEventListener("input", applyFilters);
  if (sourceFilter) sourceFilter.addEventListener("change", applyFilters);
  if (industryFilter) industryFilter.addEventListener("change", applyFilters);
  if (locationFilter) locationFilter.addEventListener("change", applyFilters);
  if (companyFilter) companyFilter.addEventListener("change", applyFilters);
  if (verificationFilter) verificationFilter.addEventListener("change", applyFilters);
  if (clearFiltersBtn) clearFiltersBtn.addEventListener("click", clearFilters);
  if (refreshBtn) refreshBtn.addEventListener("click", loadContacts);
  if (exportBtn) exportBtn.addEventListener("click", exportToCSV);

  // Select all checkbox
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener("change", (e) => {
      const checkboxes = document.querySelectorAll(".row-checkbox");
      checkboxes.forEach((cb) => {
        cb.checked = e.target.checked;
        const id = cb.dataset.id;
        if (e.target.checked) selectedContacts.add(id);
        else selectedContacts.delete(id);
      });
      updateBulkActionsBar();
    });
  }

  // Bulk actions
  if (deleteSelectedBtn) deleteSelectedBtn.addEventListener("click", handleDeleteSelected);
  if (verifySelectedBtn) verifySelectedBtn.addEventListener("click", verifySelectedEmails);
  
  // Verify button in bulk actions bar
  const verifyBtn2 = document.getElementById('verifySelectedBtn2');
  if (verifyBtn2) {
    verifyBtn2.addEventListener("click", verifySelectedEmails);
  }

  // Email selected buttons
  const emailSelectedBtn = document.getElementById('emailSelectedBtn');
  const emailSelectedBtn2 = document.getElementById('emailSelectedBtn2');
  if (emailSelectedBtn) emailSelectedBtn.addEventListener('click', openEmailComposer);
  if (emailSelectedBtn2) emailSelectedBtn2.addEventListener('click', openEmailComposer);

  // Navigation
  document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      
      const titles = {
        people: "People",
        companies: "Companies",
        linkedin: "LinkedIn Contacts",
        googlemaps: "Google Maps Contacts",
        websites: "Website Contacts",
        campaigns: "Email Campaigns"
      };
      
      if (viewTitle) viewTitle.textContent = titles[currentView] || "All Contacts";
      
      if (currentView === 'campaigns') {
        showCampaignsView();
      } else {
        showContactsView();
        applyFilters();
      }
    });
  });

  // Open scraper buttons
  if (openScraperBtn) openScraperBtn.addEventListener("click", () => window.electronAPI.openScraper());
  if (openScraperBtn2) openScraperBtn2.addEventListener("click", () => window.electronAPI.openScraper());

  // Sortable columns
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const column = th.dataset.sort;
      sortTable(column);
    });
  });

  // API Key modal
  const saveApiBtn = document.getElementById('saveApiBtn');
  const cancelApiBtn = document.getElementById('cancelApiBtn');
  
  if (saveApiBtn) {
    saveApiBtn.addEventListener('click', saveApiKeyAndVerify);
  }
  if (cancelApiBtn) {
    cancelApiBtn.addEventListener('click', () => {
      document.getElementById('apiKeyModal').style.display = 'none';
    });
  }

  // New campaign buttons
  const newCampaignBtn = document.getElementById('newCampaignBtn');
  const newCampaignBtn2 = document.getElementById('newCampaignBtn2');
  
  const openNewCampaign = () => {
    currentCampaignRecipients = [];
    const recipientsList = document.getElementById('recipientsList');
    const recipientCount = document.getElementById('recipientCount');
    if (recipientsList) recipientsList.innerHTML = '<p class="no-recipients">No recipients selected. Select contacts from People view first.</p>';
    if (recipientCount) recipientCount.textContent = '0';
    
    const composerModal = document.getElementById('emailComposerModal');
    if (composerModal) composerModal.style.display = 'flex';
  };

  if (newCampaignBtn) newCampaignBtn.addEventListener('click', openNewCampaign);
  if (newCampaignBtn2) newCampaignBtn2.addEventListener('click', openNewCampaign);
}

// Initialize on load
init();

// ============================================
// IMPORT CONTACTS FUNCTIONALITY
// ============================================

let csvData = [];

// Setup import modal
function setupImportModal() {
  const importBtn = document.getElementById('importContactsBtn');
  const importModal = document.getElementById('importModal');
  const closeImportModal = document.getElementById('closeImportModal');
  const cancelImportBtn = document.getElementById('cancelImportBtn');
  const cancelManualBtn = document.getElementById('cancelManualBtn');
  const importCsvBtn = document.getElementById('importCsvBtn');
  const csvFileInput = document.getElementById('csvFileInput');
  const dropZone = document.getElementById('dropZone');
  const manualContactForm = document.getElementById('manualContactForm');
  
  if (!importBtn || !importModal) return;

  // Open modal
  importBtn.addEventListener('click', () => {
    importModal.style.display = 'flex';
    csvData = [];
    const csvPreview = document.getElementById('csvPreview');
    if (csvPreview) csvPreview.style.display = 'none';
    if (importCsvBtn) importCsvBtn.disabled = true;
  });

  // Close modal
  const closeModal = () => {
    importModal.style.display = 'none';
    csvData = [];
    if (csvFileInput) csvFileInput.value = '';
    const csvPreview = document.getElementById('csvPreview');
    if (csvPreview) csvPreview.style.display = 'none';
    if (manualContactForm) manualContactForm.reset();
  };

  if (closeImportModal) closeImportModal.addEventListener('click', closeModal);
  if (cancelImportBtn) cancelImportBtn.addEventListener('click', closeModal);
  if (cancelManualBtn) cancelManualBtn.addEventListener('click', closeModal);

  // Tab switching
  document.querySelectorAll('.import-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.import-tab-content').forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
      });
      
      tab.classList.add('active');
      const tabId = tab.dataset.tab + 'Tab';
      const tabContent = document.getElementById(tabId);
      if (tabContent) {
        tabContent.classList.add('active');
        tabContent.style.display = 'block';
      }
    });
  });

  // File input
  if (csvFileInput) {
    csvFileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        handleCsvFile(e.target.files[0]);
      }
    });
  }

  // Drag and drop
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) {
        handleCsvFile(e.dataTransfer.files[0]);
      }
    });
  }

  // Import CSV button
  if (importCsvBtn) {
    importCsvBtn.addEventListener('click', async () => {
      if (csvData.length === 0) return;
      
      importCsvBtn.disabled = true;
      importCsvBtn.textContent = 'Importing...';
      
      try {
        const result = await window.electronAPI.importContacts(csvData);
        
        if (result.success) {
          alert(`Successfully imported ${result.count} contacts!`);
          closeModal();
          await loadContacts();
        } else {
          alert('Import failed: ' + result.error);
        }
      } catch (error) {
        alert('Import error: ' + error.message);
      } finally {
        importCsvBtn.disabled = false;
        importCsvBtn.textContent = 'Import Contacts';
      }
    });
  }

  // Manual contact form
  if (manualContactForm) {
    manualContactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const contact = {
        first_name: document.getElementById('manualFirstName')?.value.trim() || '',
        last_name: document.getElementById('manualLastName')?.value.trim() || '',
        email: document.getElementById('manualEmail')?.value.trim() || '',
        company: document.getElementById('manualCompany')?.value.trim() || null,
        job_title: document.getElementById('manualJobTitle')?.value.trim() || null,
        phone_number: document.getElementById('manualPhone')?.value.trim() || null,
        location: document.getElementById('manualLocation')?.value.trim() || null,
        industry: document.getElementById('manualIndustry')?.value || null,
        source: 'manual',
        email_verified: false,
        verification_status: 'unverified'
      };

      if (!contact.email) {
        alert('Email is required!');
        return;
      }

      try {
        const result = await window.electronAPI.importContacts([contact]);
        
        if (result.success) {
          alert('Contact added successfully!');
          closeModal();
          await loadContacts();
        } else {
          alert('Failed to add contact: ' + result.error);
        }
      } catch (error) {
        alert('Error adding contact: ' + error.message);
      }
    });
  }
}

// Parse CSV file
function handleCsvFile(file) {
  const reader = new FileReader();
  
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      alert('CSV file must have a header row and at least one data row');
      return;
    }

    // Parse header
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
    
    // Check for required email column
    if (!headers.includes('email')) {
      alert('CSV must have an "email" column');
      return;
    }

    // Parse data rows
    csvData = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length === 0) continue;
      
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index]?.trim() || '';
      });

      // Only include rows with email
      if (row.email) {
        csvData.push({
          first_name: row.first_name || row.firstname || row.name?.split(' ')[0] || '',
          last_name: row.last_name || row.lastname || row.name?.split(' ').slice(1).join(' ') || '',
          email: row.email,
          company: row.company || row.organization || null,
          job_title: row.job_title || row.jobtitle || row.title || row.position || null,
          phone_number: row.phone_number || row.phone || row.tel || null,
          location: row.location || row.city || row.address || null,
          industry: row.industry || null,
          source: 'manual',
          email_verified: false,
          verification_status: 'unverified'
        });
      }
    }

    // Show preview
    showCsvPreview(headers, csvData);
  };

  reader.readAsText(file);
}

// Parse a single CSV line (handling quotes)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  
  return result.map(s => s.replace(/^"|"$/g, '').trim());
}

// Show CSV preview
function showCsvPreview(headers, data) {
  const preview = document.getElementById('csvPreview');
  const previewCount = document.getElementById('previewCount');
  const previewHead = document.getElementById('previewHead');
  const previewBody = document.getElementById('previewBody');
  const importBtn = document.getElementById('importCsvBtn');

  if (!preview || !previewCount || !previewHead || !previewBody) return;

  previewCount.textContent = data.length;
  
  // Header
  previewHead.innerHTML = `<tr>${['Email', 'Name', 'Company', 'Job Title'].map(h => `<th>${h}</th>`).join('')}</tr>`;
  
  // Body (first 5 rows)
  const previewRows = data.slice(0, 5);
  previewBody.innerHTML = previewRows.map(row => `
    <tr>
      <td>${row.email || '-'}</td>
      <td>${[row.first_name, row.last_name].filter(Boolean).join(' ') || '-'}</td>
      <td>${row.company || '-'}</td>
      <td>${row.job_title || '-'}</td>
    </tr>
  `).join('');

  if (data.length > 5) {
    previewBody.innerHTML += `<tr><td colspan="4" style="text-align: center; color: #999;">... and ${data.length - 5} more</td></tr>`;
  }

  preview.style.display = 'block';
  if (importBtn) importBtn.disabled = data.length === 0;
}

// Initialize import modal after DOM is ready
setTimeout(setupImportModal, 100);