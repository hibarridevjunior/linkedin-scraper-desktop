const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');

let mainWindow;
let scraperWindow;

// Supabase config (centralized)
const SUPABASE_URL = 'https://cvecdppmqcxgofetrfir.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2ZWNkcHBtcWN4Z29mZXRyZmlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1ODQ3NDYsImV4cCI6MjA4MzE2MDc0Nn0.GjF5fvkdeDo8kjso3RxQTVEroMO6-hideVgPAYWDyvc';

function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('src/dashboard.html');
  mainWindow.webContents.openDevTools();
}

function createScraperWindow() {
  if (scraperWindow) {
    scraperWindow.focus();
    return;
  }

  scraperWindow = new BrowserWindow({
    width: 800,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  scraperWindow.loadFile('src/index.html');

  scraperWindow.on('closed', () => {
    scraperWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('open-scraper', () => {
  createScraperWindow();
});

// ============================================
// SCRAPING - Enhanced with enrichment & bulk support
// ============================================

ipcMain.handle('start-scrape', async (event, config) => {
  try {
    let results;
    let stats = null;
    let failedUrls = null;
    
    // Progress callback helper - captures stats and failed URLs
    const progressCallback = (progress) => {
      if (scraperWindow) {
        scraperWindow.webContents.send('scrape-progress', progress);
      }
      if (progress.stats) {
        stats = progress.stats;
      }
      if (progress.failedUrls) {
        failedUrls = progress.failedUrls;
      }
    };
    
    if (config.type === 'linkedin') {
      const { runLinkedInScraper } = require('./src/scraper');
      results = await runLinkedInScraper(
        config.companyName,
        config.companyDomain,
        config.maxProfiles,
        config.jobTitles,
        config.industry || null,
        config.keywords || null,
        progressCallback
      );
    } else if (config.type === 'googlemaps') {
  const { runGoogleMapsScraper } = require('./src/googlemaps-scraper');
  
  // Build options object for enhanced scraper
  const options = {
    enableEnrichment: config.enableEnrichment !== false
  };
  
  results = await runGoogleMapsScraper(
    config.searchQuery,
    config.maxResults,
    config.industry || null,
    config.keywords || null,
    (progress) => {
      if (scraperWindow) {
        scraperWindow.webContents.send('scrape-progress', progress);
      }
    },
    options  // ✅ Pass the options!
  );
} else if (config.type === 'website') {
      const { runWebsiteScraper, runBulkWebsiteScraper } = require('./src/website-scraper');
      
      // Check if bulk or single website scrape
      if (config.isBulk || (typeof config.websiteUrl === 'string' && 
          (config.websiteUrl.includes(',') || config.websiteUrl.includes('\n')))) {
        // Use bulk scraper for multiple URLs
        results = await runBulkWebsiteScraper(
          config.websiteUrl,
          config.industry || null,
          config.keywords || null,
          progressCallback
        );
      } else {
        // Use single website scraper
        results = await runWebsiteScraper(
          config.websiteUrl,
          config.industry || null,
          config.keywords || null,
          progressCallback
        );
      }
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('refresh-data');
    }
    
    // Calculate stats if not provided by scraper
    if (!stats && results) {
      stats = {
        total: results.length,
        withEmail: results.filter(r => r.email).length,
        withPhone: results.filter(r => r.phone_number || r.mobile_number || r.whatsapp_number).length
      };
    }
    
    return { 
      success: true, 
      results,
      stats,
      failedUrls
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// UNIFIED EMAIL SCRAPER
// ============================================

ipcMain.handle('start-email-scrape', async (event, config) => {
  try {
    const { runUnifiedEmailScraper } = require('./src/email-scraper-service');
    
    let stats = null;
    let errors = null;
    let results = null;
    
    // Progress callback helper
    const progressCallback = (progress) => {
      if (scraperWindow) {
        scraperWindow.webContents.send('scrape-progress', progress);
      }
      if (progress.stats) {
        stats = progress.stats;
      }
      if (progress.errors) {
        errors = progress.errors;
      }
      // Capture results from progress if available
      if (progress.results) {
        results = progress.results;
      }
    };
    
    const result = await runUnifiedEmailScraper(
      {
        query: config.query,
        sources: {
          linkedin: config.sources?.linkedin || false,
          googleSearch: config.sources?.googleSearch || false,
          googleMaps: config.sources?.googleMaps || false,
          websites: config.sources?.websites || false
        },
        maxResultsPerSource: config.maxResultsPerSource || 20,
        industry: config.industry || null,
        keywords: config.keywords || null
      },
      progressCallback
    );
    
    if (mainWindow) {
      mainWindow.webContents.send('refresh-data');
    }
    
    // Ensure we return results even if empty array
    const finalResults = result.results || results || [];
    const finalStats = result.stats || stats || { total: 0, withEmail: 0, withPhone: 0 };
    
    console.log('Email scraper completed:', {
      success: result.success,
      resultsCount: finalResults.length,
      stats: finalStats
    });
    
    return {
      success: result.success !== false,
      results: finalResults,
      stats: finalStats,
      errors: result.errors || errors
    };
  } catch (error) {
    console.error('Email scraper error:', error);
    return { success: false, error: error.message };
  }
});

// Load contacts
ipcMain.handle('load-contacts', async () => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { success: true, contacts: data || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete contacts
ipcMain.handle('delete-contacts', async (event, ids) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .delete()
      .in('id', ids);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Verify single email using Abstract Email Reputation API
// CORRECTED: Parsing the actual API response structure
async function verifyEmailWithAPI(email, apiKey) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://emailreputation.abstractapi.com/v1/?api_key=${apiKey}&email=${encodeURIComponent(email)}`;
    
    console.log(`Verifying email: ${email}`);
    
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          console.log(`API Response for ${email}:`, data.substring(0, 300));
          const response = JSON.parse(data);
          
          // Check for API errors
          if (response.error) {
            console.error('API Error:', response.error);
            
            // Handle quota errors specifically
            if (response.error.code === 'quota_reached' || response.error.message?.includes('quota')) {
              resolve({ 
                isValid: null, // null means couldn't verify (not false/invalid)
                status: 'quota_exceeded',
                details: {
                  error: 'API quota exceeded. Please upgrade your Abstract API plan or use a different API key.',
                  code: response.error.code
                }
              });
              return;
            }
            
            resolve({ 
              isValid: false, 
              status: 'error',
              details: response.error.message || 'API error'
            });
            return;
          }
          
          // ============================================
          // CORRECT Email Reputation API Response Parsing
          // ============================================
          
          // Get deliverability info
          const deliverability = response.email_deliverability || {};
          const deliveryStatus = deliverability.status || 'unknown'; // "deliverable", "risky", "undeliverable", "unknown"
          const isFormatValid = deliverability.is_format_valid === true;
          const isSmtpValid = deliverability.is_smtp_valid === true;
          const isMxValid = deliverability.is_mx_valid === true;
          
          // Get quality info
          const quality = response.email_quality || {};
          const qualityScore = quality.score || 0; // 0-1 scale
          const isFreeEmail = quality.is_free_email === true;
          const isDisposable = quality.is_disposable === true;
          const isCatchAll = quality.is_catchall === true;
          const isRoleEmail = quality.is_role === true;
          
          // Get risk info
          const risk = response.email_risk || {};
          const addressRisk = risk.address_risk_status || 'unknown'; // "low", "medium", "high"
          const domainRisk = risk.domain_risk_status || 'unknown';
          
          // Determine final validity and status
          let isValid = false;
          let status = 'unverified';
          
          // Primary check: deliverability status
          if (deliveryStatus === 'deliverable') {
            isValid = true;
            status = 'verified';
          } else if (deliveryStatus === 'undeliverable') {
            isValid = false;
            status = 'invalid';
          } else if (deliveryStatus === 'risky') {
            // Risky from API - check if we can still consider it valid
            if (isFormatValid && isMxValid && addressRisk === 'low' && !isDisposable) {
              isValid = true; // Format and MX valid, low risk - treat as verified
              status = 'verified';
            } else {
              isValid = false;
              status = 'risky';
            }
          } else if (deliveryStatus === 'unknown') {
            // For unknown, be more lenient - if format and MX are valid, consider it verified
            if (isFormatValid && isMxValid && !isDisposable) {
              if (addressRisk === 'low') {
                isValid = true;
                status = 'verified'; // Format valid, MX valid, low risk - good enough
              } else if (addressRisk === 'medium') {
                isValid = true;
                status = 'verified'; // Still accept medium risk as verified
              } else {
                isValid = false;
                status = 'risky'; // High risk only
              }
            } else if (isFormatValid && isMxValid) {
              isValid = false;
              status = 'risky'; // Valid format/MX but disposable or other issues
            } else {
              isValid = false;
              status = 'invalid'; // Invalid format or MX
            }
          }
          
          // Override: Disposable emails are always risky/invalid
          if (isDisposable) {
            isValid = false;
            status = 'risky';
          }
          
          // Override: Only downgrade if address risk is high AND we have other concerns
          if (addressRisk === 'high' && (isDisposable || !isMxValid)) {
            status = 'risky';
            isValid = false;
          }
          
          console.log(`Result for ${email}: ${status} (delivery: ${deliveryStatus}, smtp: ${isSmtpValid}, addressRisk: ${addressRisk})`);
          
          resolve({
            isValid,
            status,
            details: {
              delivery_status: deliveryStatus,
              is_smtp_valid: isSmtpValid,
              is_mx_valid: isMxValid,
              quality_score: qualityScore,
              is_free_email: isFreeEmail,
              is_disposable: isDisposable,
              is_catchall: isCatchAll,
              is_role_email: isRoleEmail,
              address_risk: addressRisk,
              domain_risk: domainRisk
            }
          });
        } catch (e) {
          console.error('Parse error:', e.message, 'Raw data:', data.substring(0, 200));
          resolve({ isValid: false, status: 'error', details: 'Parse error: ' + e.message });
        }
      });
    }).on('error', (err) => {
      console.error('HTTP error:', err.message);
      resolve({ isValid: false, status: 'error', details: err.message });
    });
  });
}

// Bulk verify emails
ipcMain.handle('verify-emails', async (event, emailData, apiKey) => {
  try {
    const supabase = getSupabase();
    const results = [];
    
    console.log(`Starting bulk verification of ${emailData.length} emails`);
    
    for (let i = 0; i < emailData.length; i++) {
      const item = emailData[i];
      
      // Send progress update to renderer
      if (mainWindow) {
        mainWindow.webContents.send('verification-progress', {
          current: i + 1,
          total: emailData.length,
          email: item.email
        });
      }
      
      if (!item.email) {
        results.push({ id: item.id, verified: false, status: 'no_email' });
        continue;
      }

      try {
        const verifyResult = await verifyEmailWithAPI(item.email, apiKey);
        
        // Update in Supabase
        // Only update if not quota exceeded (don't overwrite existing status)
        if (verifyResult.status !== 'quota_exceeded') {
          const { error } = await supabase
            .from('contacts')
            .update({ 
              email_verified: verifyResult.isValid,
              verification_status: verifyResult.status,
              verification_details: verifyResult.details
            })
            .eq('id', item.id);
        } else {
          // For quota exceeded, just log it
          console.log(`Quota exceeded for ${item.email} - skipping database update`);
        }

        if (error) {
          console.error('Supabase update error:', error);
        }

        // Handle quota exceeded specially
        if (verifyResult.status === 'quota_exceeded') {
          results.push({ 
            id: item.id, 
            verified: null, 
            status: 'quota_exceeded',
            details: verifyResult.details
          });
        } else {
          results.push({ 
            id: item.id, 
            verified: verifyResult.isValid, 
            status: verifyResult.status,
            details: verifyResult.details
          });
        }

        // Rate limiting - wait 1.1 seconds between API calls (free tier limit)
        await new Promise(resolve => setTimeout(resolve, 1100));

      } catch (err) {
        console.error('Verification error for', item.email, err);
        results.push({ id: item.id, verified: false, status: 'error' });
      }
    }

    const verifiedCount = results.filter(r => r.verified).length;
    const riskyCount = results.filter(r => r.status === 'risky').length;
    const invalidCount = results.filter(r => r.status === 'invalid').length;
    
    console.log(`Verification complete: ${verifiedCount} verified, ${riskyCount} risky, ${invalidCount} invalid`);

    return { success: true, results };
  } catch (error) {
    console.error('Bulk verification error:', error);
    return { success: false, error: error.message };
  }
});

// Update single contact verification status
ipcMain.handle('update-contact-verification', async (event, contactId, isVerified, status) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ 
        email_verified: isVerified,
        verification_status: status || (isVerified ? 'verified' : 'unverified')
      })
      .eq('id', contactId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Update contact industry
ipcMain.handle('update-contact-industry', async (event, contactId, industry) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ industry })
      .eq('id', contactId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Bulk update industry for multiple contacts
ipcMain.handle('bulk-update-industry', async (event, contactIds, industry) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('contacts')
      .update({ industry })
      .in('id', contactIds);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Import contacts (CSV or manual)
ipcMain.handle('import-contacts', async (event, contacts) => {
  try {
    const supabase = getSupabase();
    
    if (!contacts || contacts.length === 0) {
      return { success: false, error: 'No contacts to import' };
    }

    // Separate contacts with and without email
    const withEmail = contacts.filter(c => c.email);
    const withoutEmail = contacts.filter(c => !c.email);

    let imported = 0;

    // Upsert contacts with email (will update if exists)
    if (withEmail.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .upsert(withEmail, { 
          onConflict: 'email',
          ignoreDuplicates: false 
        });

      if (error) {
        console.error('Upsert error:', error);
        throw error;
      }
      imported += withEmail.length;
    }

    // Insert contacts without email
    if (withoutEmail.length > 0) {
      const { data, error } = await supabase
        .from('contacts')
        .insert(withoutEmail);

      if (error) {
        console.error('Insert error:', error);
        // Don't throw, some might be duplicates
      } else {
        imported += withoutEmail.length;
      }
    }

    return { success: true, count: imported };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// WEEK 3: EMAIL SENDING SYSTEM
// ============================================

// Store active SMTP transporter
let smtpTransporter = null;
let smtpConfig = null;

// Generate random email address for survivability
function generateRandomEmail(domain) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${randomPart}@${domain}`;
}

// Generate random email with prefix
ipcMain.handle('generate-random-email', async (event, domain, prefix = '') => {
  try {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 12; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const email = prefix ? `${prefix}.${randomPart}@${domain}` : `${randomPart}@${domain}`;
    return { success: true, email };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Configure SMTP settings
ipcMain.handle('configure-smtp', async (event, config) => {
  try {
    console.log('Configuring SMTP with:', { host: config.host, port: config.port, user: config.user });
    
    smtpConfig = {
      host: config.host,
      port: parseInt(config.port),
      secure: config.secure || config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass
      },
      // Connection pooling for bulk sending
      pool: true,
      maxConnections: config.maxConnections || 5,
      maxMessages: config.maxMessages || 100,
      // Timeouts
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000
    };

    // Create transporter
    smtpTransporter = nodemailer.createTransport(smtpConfig);

    // Verify connection
    await smtpTransporter.verify();
    
    console.log('SMTP connection verified successfully');
    return { success: true, message: 'SMTP configured and verified' };
  } catch (error) {
    console.error('SMTP configuration error:', error);
    smtpTransporter = null;
    smtpConfig = null;
    return { success: false, error: error.message };
  }
});

// Test SMTP connection
ipcMain.handle('test-smtp', async (event) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured' };
    }

    await smtpTransporter.verify();
    return { success: true, message: 'SMTP connection is working' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Replace template variables in text
function replaceTemplateVariables(template, contact) {
  if (!template) return '';
  
  let result = template;
  
  // Standard variables
  const variables = {
    '{{first_name}}': contact.first_name || '',
    '{{last_name}}': contact.last_name || '',
    '{{full_name}}': [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '',
    '{{email}}': contact.email || '',
    '{{company}}': contact.company || '',
    '{{job_title}}': contact.job_title || '',
    '{{location}}': contact.location || '',
    '{{industry}}': contact.industry || '',
    '{{phone}}': contact.phone_number || '',
    // Fallbacks with default values
    '{{first_name|there}}': contact.first_name || 'there',
    '{{company|your company}}': contact.company || 'your company',
    '{{job_title|professional}}': contact.job_title || 'professional'
  };

  // Replace all variables
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(escapeRegExp(key), 'gi'), value);
  }

  // Handle custom fallback syntax: {{variable|fallback}}
  result = result.replace(/\{\{(\w+)\|([^}]+)\}\}/g, (match, variable, fallback) => {
    const varKey = variable.toLowerCase();
    const value = contact[varKey] || contact[variable];
    return value || fallback;
  });

  return result;
}

// Escape special regex characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Send single email
ipcMain.handle('send-email', async (event, emailConfig) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured. Please configure SMTP settings first.' };
    }

    const { to, subject, html, text, from, replyTo } = emailConfig;

    const mailOptions = {
      from: from || smtpConfig.auth.user,
      to: to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for plain text
      replyTo: replyTo || from || smtpConfig.auth.user
    };

    const info = await smtpTransporter.sendMail(mailOptions);
    
    console.log('Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Send email error:', error);
    return { success: false, error: error.message };
  }
});

// Send bulk emails with rate limiting and progress updates
ipcMain.handle('send-bulk-emails', async (event, config) => {
  try {
    if (!smtpTransporter) {
      return { success: false, error: 'SMTP not configured. Please configure SMTP settings first.' };
    }

    const { 
      contacts, 
      subject, 
      htmlTemplate, 
      textTemplate,
      from,
      replyTo,
      delayBetweenEmails = 2000, // 2 seconds default
      batchSize = 50,
      delayBetweenBatches = 60000 // 1 minute between batches
    } = config;

    const results = [];
    let successCount = 0;
    let failCount = 0;

    console.log(`Starting bulk email send to ${contacts.length} contacts`);

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      // Send progress update
      if (mainWindow) {
        mainWindow.webContents.send('email-send-progress', {
          current: i + 1,
          total: contacts.length,
          email: contact.email,
          successCount,
          failCount
        });
      }

      if (!contact.email) {
        results.push({ 
          contactId: contact.id, 
          email: null, 
          success: false, 
          error: 'No email address' 
        });
        failCount++;
        continue;
      }

      try {
        // Replace template variables
        const personalizedSubject = replaceTemplateVariables(subject, contact);
        const personalizedHtml = replaceTemplateVariables(htmlTemplate, contact);
        const personalizedText = textTemplate ? 
          replaceTemplateVariables(textTemplate, contact) : 
          personalizedHtml.replace(/<[^>]*>/g, '');

        const mailOptions = {
          from: from || smtpConfig.auth.user,
          to: contact.email,
          subject: personalizedSubject,
          html: personalizedHtml,
          text: personalizedText,
          replyTo: replyTo || from || smtpConfig.auth.user
        };

        const info = await smtpTransporter.sendMail(mailOptions);
        
        results.push({
          contactId: contact.id,
          email: contact.email,
          success: true,
          messageId: info.messageId
        });
        successCount++;

        console.log(`Sent ${i + 1}/${contacts.length}: ${contact.email}`);

      } catch (err) {
        console.error(`Failed to send to ${contact.email}:`, err.message);
        results.push({
          contactId: contact.id,
          email: contact.email,
          success: false,
          error: err.message
        });
        failCount++;
      }

      // Rate limiting
      if (i < contacts.length - 1) {
        // Check if we need batch delay
        if ((i + 1) % batchSize === 0) {
          console.log(`Batch ${Math.floor((i + 1) / batchSize)} complete. Waiting ${delayBetweenBatches / 1000}s...`);
          if (mainWindow) {
            mainWindow.webContents.send('email-send-progress', {
              current: i + 1,
              total: contacts.length,
              email: 'Batch pause...',
              successCount,
              failCount,
              batchPause: true
            });
          }
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        } else {
          // Normal delay between emails
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
      }
    }

    console.log(`Bulk send complete: ${successCount} sent, ${failCount} failed`);

    return { 
      success: true, 
      results,
      summary: {
        total: contacts.length,
        sent: successCount,
        failed: failCount
      }
    };
  } catch (error) {
    console.error('Bulk email error:', error);
    return { success: false, error: error.message };
  }
});

// Save email campaign to Supabase
ipcMain.handle('save-campaign', async (event, campaign) => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_campaigns')
      .insert([{
        name: campaign.name,
        subject: campaign.subject,
        html_content: campaign.htmlContent,
        text_content: campaign.textContent,
        from_email: campaign.fromEmail,
        reply_to: campaign.replyTo,
        status: campaign.status || 'draft',
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    return { success: true, campaign: data[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load email campaigns
ipcMain.handle('load-campaigns', async () => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return { success: true, campaigns: data || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete campaign
ipcMain.handle('delete-campaign', async (event, campaignId) => {
  try {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('email_campaigns')
      .delete()
      .eq('id', campaignId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Log email send for analytics
ipcMain.handle('log-email-send', async (event, logData) => {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('email_logs')
      .insert([{
        campaign_id: logData.campaignId,
        contact_id: logData.contactId,
        email: logData.email,
        status: logData.status,
        message_id: logData.messageId,
        error_message: logData.error,
        sent_at: new Date().toISOString()
      }]);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get email analytics
ipcMain.handle('get-email-analytics', async (event, campaignId) => {
  try {
    const supabase = getSupabase();
    
    let query = supabase.from('email_logs').select('*');
    
    if (campaignId) {
      query = query.eq('campaign_id', campaignId);
    }
    
    const { data, error } = await query.order('sent_at', { ascending: false });

    if (error) throw error;

    // Calculate stats
    const logs = data || [];
    const stats = {
      total: logs.length,
      sent: logs.filter(l => l.status === 'sent').length,
      failed: logs.filter(l => l.status === 'failed').length,
      logs: logs
    };

    return { success: true, analytics: stats };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Disconnect SMTP
ipcMain.handle('disconnect-smtp', async () => {
  try {
    if (smtpTransporter) {
      smtpTransporter.close();
      smtpTransporter = null;
      smtpConfig = null;
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get SMTP status
ipcMain.handle('get-smtp-status', async () => {
  return {
    connected: smtpTransporter !== null,
    config: smtpConfig ? {
      host: smtpConfig.host,
      port: smtpConfig.port,
      user: smtpConfig.auth.user
    } : null
  };
});