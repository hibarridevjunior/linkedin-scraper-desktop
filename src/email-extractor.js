/**
 * Email Extractor Utility
 * 
 * Centralized email extraction, validation, and filtering logic
 * Used by all scrapers to ensure consistent email handling
 */

// Personal email domains to exclude
const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'ymail.com',
  'msn.com', 'mail.com', 'zoho.com', 'proton.me', 'gmx.com'
];

// Blacklist patterns for invalid emails
const EMAIL_BLACKLIST = [
  'example.com', 'domain.com', 'email.com', 'test.com',
  'sentry.io', 'w3.org', 'schema.org', 'wixpress.com',
  'google.com', 'gstatic.com', 'googleapis.com',
  'cloudflare.com', 'wp.com', 'wordpress.com',
  '.png', '.jpg', '.gif', '.svg', '.css', '.js',
  'noreply', 'no-reply', 'unsubscribe', 'mailer-daemon',
  'donotreply', 'noreply-', 'no-reply-'
];

/**
 * Extract all email addresses from text content
 * @param {string} text - Plain text content
 * @param {string} html - HTML content (optional)
 * @returns {Array<string>} - Array of unique email addresses
 */
function extractEmails(text = '', html = '') {
  if (!text && !html) return [];
  
  const combinedText = text + ' ' + html;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = combinedText.match(emailRegex) || [];
  
  // Filter out invalid emails
  const validEmails = matches.filter(email => {
    const lower = email.toLowerCase();
    
    // Check blacklist
    if (EMAIL_BLACKLIST.some(bl => lower.includes(bl))) return false;
    
    // Length validation
    if (email.length > 60 || email.length < 6) return false;
    
    // Domain validation
    const domain = email.split('@')[1];
    if (!domain || !domain.includes('.')) return false;
    
    // TLD validation
    const ext = domain.split('.').pop();
    if (ext.length < 2 || ext.length > 10) return false;
    
    // Must have valid characters
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) return false;
    
    return true;
  });
  
  // Remove duplicates and normalize
  const unique = [...new Set(validEmails.map(e => e.toLowerCase()))];
  
  // Sort: business emails first, then personal
  unique.sort((a, b) => {
    const aDomain = a.split('@')[1];
    const bDomain = b.split('@')[1];
    const aPersonal = PERSONAL_EMAIL_DOMAINS.some(d => aDomain === d);
    const bPersonal = PERSONAL_EMAIL_DOMAINS.some(d => bDomain === d);
    
    if (aPersonal && !bPersonal) return 1;
    if (!aPersonal && bPersonal) return -1;
    return 0;
  });
  
  return unique;
}

/**
 * Check if an email is from a personal email provider
 * @param {string} email - Email address to check
 * @returns {boolean} - True if personal email
 */
function isPersonalEmail(email) {
  if (!email) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return PERSONAL_EMAIL_DOMAINS.includes(domain);
}

/**
 * Filter emails to only include business/domain-based emails
 * @param {Array<string>} emails - Array of email addresses
 * @returns {Array<string>} - Filtered array (only business emails)
 */
function filterBusinessEmails(emails) {
  return emails.filter(email => !isPersonalEmail(email));
}

/**
 * Extract name and job title from email context
 * Attempts to find name and title near email addresses in text
 * @param {string} email - Email address
 * @param {string} text - Surrounding text content
 * @returns {Object} - { firstName, lastName, jobTitle }
 */
function extractNameAndTitleFromContext(email, text) {
  const result = {
    firstName: null,
    lastName: null,
    jobTitle: null
  };
  
  if (!email || !text) return result;
  
  // Extract local part of email (before @)
  const localPart = email.split('@')[0].toLowerCase();
  
  // Try to find name patterns near the email
  const emailIndex = text.toLowerCase().indexOf(email.toLowerCase());
  if (emailIndex === -1) return result;
  
  // Look for name patterns in surrounding text (100 chars before/after)
  const context = text.substring(Math.max(0, emailIndex - 100), emailIndex + 100);
  
  // Try to extract first.last or first_last pattern
  const namePatterns = [
    /([A-Z][a-z]+)\s+([A-Z][a-z]+)/g,  // "John Doe"
    /([A-Z][a-z]+)\s+([A-Z]\.\s*[A-Z][a-z]+)/g,  // "John D. Smith"
  ];
  
  for (const pattern of namePatterns) {
    const matches = context.match(pattern);
    if (matches && matches.length > 0) {
      const nameParts = matches[0].split(/\s+/);
      if (nameParts.length >= 2) {
        result.firstName = nameParts[0];
        result.lastName = nameParts.slice(1).join(' ');
        break;
      }
    }
  }
  
  // Try to extract job title patterns
  const titlePatterns = [
    /(?:title|position|role|job)[\s:]+([A-Z][a-z\s]+)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:Manager|Director|Engineer|Developer|Analyst|Specialist|Coordinator|Executive|Officer|Lead|Head|VP|CEO|CFO|CTO|CMO)/i
  ];
  
  for (const pattern of titlePatterns) {
    const match = context.match(pattern);
    if (match && match[1]) {
      result.jobTitle = match[1].trim();
      break;
    }
  }
  
  return result;
}

/**
 * Extract company name from email domain
 * @param {string} email - Email address
 * @returns {string|null} - Company name (extracted from domain) or null
 */
function extractCompanyFromDomain(email) {
  if (!email) return null;
  
  try {
    const domain = email.split('@')[1];
    if (!domain) return null;
    
    // Remove www. and common TLDs, get main domain name
    const domainParts = domain.split('.');
    if (domainParts.length >= 2) {
      const companyPart = domainParts[domainParts.length - 2];
      // Capitalize first letter
      return companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} - True if valid format
 */
function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

/**
 * Get the best email from an array (prioritizes business emails)
 * @param {Array<string>} emails - Array of email addresses
 * @returns {string|null} - Best email or null
 */
function getBestEmail(emails) {
  if (!emails || emails.length === 0) return null;
  
  // Filter to business emails first
  const businessEmails = filterBusinessEmails(emails);
  if (businessEmails.length > 0) {
    return businessEmails[0];
  }
  
  // Fallback to first email if no business emails
  return emails[0];
}

/**
 * Helper function to truncate strings to database column limits
 * @param {string} value - Value to truncate
 * @param {number} maxLength - Maximum length (default 100)
 * @returns {string|null} - Truncated value or original if not a string
 */
function truncateField(value, maxLength = 100) {
  if (!value || typeof value !== 'string') return value;
  return value.length > maxLength ? value.substring(0, maxLength) : value;
}

/**
 * Create contact object from email and context
 * @param {string} email - Email address
 * @param {string} text - Context text
 * @param {Object} additionalData - Additional data (company, source, etc.)
 * @returns {Object} - Contact object ready for database
 */
function createContactFromEmail(email, text = '', additionalData = {}) {
  if (!email || !isValidEmailFormat(email)) return null;
  
  // Skip personal emails
  if (isPersonalEmail(email)) return null;
  
  // Extract name and title from context
  const contextData = extractNameAndTitleFromContext(email, text);
  
  // Build contact object with truncation for database limits
  const contact = {
    email: email.toLowerCase(),
    first_name: truncateField(additionalData.firstName || contextData.firstName, 100),
    last_name: truncateField(additionalData.lastName || contextData.lastName, 100),
    job_title: truncateField(additionalData.jobTitle || contextData.jobTitle, 100),
    company: truncateField(additionalData.company || extractCompanyFromDomain(email), 100),
    email_domain: truncateField(email.split('@')[1], 100),
    source: additionalData.source || 'email_scraper',
    email_verified: false,
    verification_status: 'unverified',
    industry: truncateField(additionalData.industry, 100),
    keywords: truncateField(additionalData.keywords, 100),
    location: truncateField(additionalData.location, 100),
    phone_number: additionalData.phone_number || null,
    mobile_number: additionalData.mobile_number || null,
    company_website: additionalData.company_website || null,
    company_summary: additionalData.company_summary ? truncateField(additionalData.company_summary, 500) : null,
    linkedin_url: additionalData.linkedin_url || null,
    search_query: truncateField(additionalData.search_query, 200) || null // Store original search query if provided
  };
  
  return contact;
}

/**
 * Extract person's name from email address
 * Handles common patterns: john.doe@company.com, john_doe@company.com, etc.
 * @param {string} email - Email address
 * @returns {Object} - { firstName, lastName, fullName } or null if no name pattern found
 */
function extractNameFromEmail(email) {
  if (!email || typeof email !== 'string') return null;
  
  const localPart = email.split('@')[0].toLowerCase();
  
  // Skip if it's clearly not a name pattern (too short, numbers only, etc.)
  if (localPart.length < 3 || /^[0-9]+$/.test(localPart)) return null;
  
  // Pattern 1: first.last (most common)
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
  
  // Pattern 3: firstlast (no separator, try to split at capital letter if present)
  // This is harder, so we'll be more conservative
  if (localPart.length >= 6 && !localPart.includes('.') && !localPart.includes('_') && !localPart.includes('-')) {
    // Try to find a split point (common: first 3-5 chars for first name)
    const commonFirstNameLengths = [3, 4, 5];
    for (const len of commonFirstNameLengths) {
      if (localPart.length > len && localPart.length - len >= 2) {
        const firstName = localPart.substring(0, len).charAt(0).toUpperCase() + localPart.substring(0, len).slice(1);
        const lastName = localPart.substring(len).charAt(0).toUpperCase() + localPart.substring(len).slice(1);
        return { firstName, lastName, fullName: `${firstName} ${lastName}` };
      }
    }
  }
  
  // Pattern 4: first-last (hyphen)
  if (localPart.includes('-')) {
    const parts = localPart.split('-');
    if (parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2) {
      const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      return { firstName, lastName, fullName: `${firstName} ${lastName}` };
    }
  }
  
  return null;
}

module.exports = {
  extractEmails,
  isPersonalEmail,
  filterBusinessEmails,
  extractNameFromEmail,
  extractNameAndTitleFromContext,
  extractCompanyFromDomain,
  isValidEmailFormat,
  getBestEmail,
  createContactFromEmail,
  truncateField,
  PERSONAL_EMAIL_DOMAINS
};
