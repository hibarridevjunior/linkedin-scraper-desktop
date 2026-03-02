const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Fast mode: set SCRAPE_FAST=1 when starting the app for ~2–3x faster scraping (higher CAPTCHA risk)
  getScrapeFastMode: () => process.env.SCRAPE_FAST === '1' || process.env.SCRAPE_FAST === 'true',
  // Scraping — job queue, resume; IPC progress is counts/phase/source only
  startScrape: (config) => ipcRenderer.invoke('start-scrape', config),
  startEmailScrape: (config) => ipcRenderer.invoke('start-email-scrape', config),
  stopScrape: (mode) => ipcRenderer.invoke('stop-scrape', mode),
  onProgress: (callback) => ipcRenderer.on('scrape-progress', (event, data) => callback(data)),
  openScraper: () => ipcRenderer.send('open-scraper'),
  getRunStatus: () => ipcRenderer.invoke('get-run-status'),
  resumeRun: () => ipcRenderer.invoke('resume-run'),
  discardSavedRun: () => ipcRenderer.invoke('discard-saved-run'),
  
  // Contacts CRUD
  loadContacts: () => ipcRenderer.invoke('load-contacts'),
  clearAllContacts: () => ipcRenderer.invoke('clear-all-contacts'),
  deleteContacts: (ids) => ipcRenderer.invoke('delete-contacts', ids),
  importContacts: (contacts) => ipcRenderer.invoke('import-contacts', contacts),
  getSearchHistory: () => ipcRenderer.invoke('get-search-history'),
  loadContactsByRunId: (runId) => ipcRenderer.invoke('load-contacts-by-run-id', runId),
  
  // Email verification
  verifyEmails: (emailData, apiKey) => ipcRenderer.invoke('verify-emails', emailData, apiKey),
  verifyEmailsSmtp: (emailData) => ipcRenderer.invoke('verify-emails-smtp', emailData),
  verifyEmailsMx: (emailData) => ipcRenderer.invoke('verify-emails-mx', emailData),
  verifyScraperResults: (contacts) => ipcRenderer.invoke('verify-scraper-results', contacts),
  updateContactVerification: (contactId, isVerified, status) => 
    ipcRenderer.invoke('update-contact-verification', contactId, isVerified, status),
  onVerificationProgress: (callback) => 
    ipcRenderer.on('verification-progress', (event, data) => callback(data)),
  onQuotaExceeded: (callback) => 
    ipcRenderer.on('quota-exceeded', (event, data) => callback(data)),
  
  // Industry management
  updateContactIndustry: (contactId, industry) => 
    ipcRenderer.invoke('update-contact-industry', contactId, industry),
  bulkUpdateIndustry: (contactIds, industry) => 
    ipcRenderer.invoke('bulk-update-industry', contactIds, industry),
  
  // Data refresh listener
  onRefreshData: (callback) => ipcRenderer.on('refresh-data', () => callback()),
  onContactsSaveError: (callback) => ipcRenderer.on('contacts-save-error', (event, data) => callback(data)),

  // ============================================
  // WEEK 3: EMAIL SENDING SYSTEM
  // ============================================

  // SMTP Configuration
  configureSmtp: (config) => ipcRenderer.invoke('configure-smtp', config),
  testSmtp: () => ipcRenderer.invoke('test-smtp'),
  disconnectSmtp: () => ipcRenderer.invoke('disconnect-smtp'),
  getSmtpStatus: () => ipcRenderer.invoke('get-smtp-status'),

  // Email Sending
  sendEmail: (emailConfig) => ipcRenderer.invoke('send-email', emailConfig),
  sendBulkEmails: (config) => ipcRenderer.invoke('send-bulk-emails', config),
  onEmailSendProgress: (callback) => 
    ipcRenderer.on('email-send-progress', (event, data) => callback(data)),

  // Campaign Management
  saveCampaign: (campaign) => ipcRenderer.invoke('save-campaign', campaign),
  loadCampaigns: () => ipcRenderer.invoke('load-campaigns'),
  deleteCampaign: (campaignId) => ipcRenderer.invoke('delete-campaign', campaignId),

  // Email Analytics
  logEmailSend: (logData) => ipcRenderer.invoke('log-email-send', logData),
  getEmailAnalytics: (campaignId) => ipcRenderer.invoke('get-email-analytics', campaignId),

  // Email Survivability
  generateRandomEmail: (domain, prefix) => ipcRenderer.invoke('generate-random-email', domain, prefix)
});