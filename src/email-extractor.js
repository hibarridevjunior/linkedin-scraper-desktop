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

// Role addresses that are usually real contact points (prioritized when choosing best email)
const PREFERRED_ROLE_LOCAL_PARTS = ['contact', 'info', 'sales', 'enquiry', 'enquiries', 'hello', 'office', 'support', 'admin'];

// Local-parts that mean "no personal name" (don't derive name from email)
const GENERIC_LOCAL_PARTS = new Set(['contact', 'contactus', 'info', 'support', 'admin', 'hello', 'sales', 'enquiry', 'enquiries', 'office']);

// Substrings in local part that indicate role/department address — do not split into fake first/last (e.g. ncibassistict → Nciba Ssistict)
const ROLE_LOCAL_PART_SUBSTRINGS = [
  'assist', 'business', 'estate', 'complaint', 'financial', 'planning', 'premium', 'banking', 'private', 'clients', 'services', 'trading',
  'appeals', 'ethics', 'holding', 'entities', 'sector', 'institutions', 'inland', 'diversified', 'industrials', 'consumer', 'health',
  'feedback', 'group', 'wealth', 'smallbusiness', 'onlinetrading', 'talkto', 'tip-offs', 'nfosa', 'faisombud', 'fsca', 'ncr'
];

// Common single first names — don't split these into "First" + "Last" (e.g. melissa → Mel Issa)
const COMMON_SINGLE_FIRST_NAMES = new Set([
  'melissa', 'jennifer', 'michelle', 'stephanie', 'nicole', 'rachel', 'amanda', 'sarah', 'jessica', 'rebecca',
  'matthew', 'andrew', 'daniel', 'christopher', 'nicholas', 'jonathan', 'benjamin', 'samuel', 'patrick', 'stephen'
]);

// Words that are not valid first/last names (snippet text, locations, UI phrases)
const NOT_PERSON_NAME = new Set([
  'for', 'the', 'this', 'these', 'and', 'with', 'our', 'your', 'get', 'see', 'learn', 'read', 'more', 'how', 'what', 'when', 'why',
  'sponsorship', 'february', 'january', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'mining', 'investment', 'contact', 'about', 'email', 'click', 'visit',
  'south', 'africa', 'north', 'europe', 'asia', 'america', 'uk', 'united', 'kingdom', 'states', 'australia', 'india', 'canada', 'germany', 'france', 'japan', 'china', 'brazil', 'nigeria', 'kenya', 'egypt', 'region', 'country', 'location', 'worldwide', 'global'
]);

// Generic domain parts to skip when deriving company name (subdomains like www, personal → use next part)
const GENERIC_DOMAIN_PARTS = new Set([
  'www', 'about', 'contact', 'info', 'mail', 'email', 'support', 'admin', 'welcome', 'office', 'en', 'fr', 'de', 'es', 'it', 'za', 'uk', 'au', 'personal'
]);

// Generic page titles / headings that must not be saved as company or person name
const GENERIC_PAGE_TITLES = new Set([
  'about us', 'about', 'home', 'contact', 'contact us', 'con tactus', 'welcome', 'default', 'index', 'our company', 'read more', 'privacy policy', 'terms of use', 'terms and conditions', 'sitemap', 'login', 'sign in', 'register',
  'event details', 'share structure', 'management news', 'news releases', 'call us', 'email sign', 'one conference', 'notice complaints', 'general', 'constructional', 'eservices', 'the assay', 'university ave', 'delegate logistics', 'sponsorship stuart', 'editor roze', 'showroom close', 'revenue eservices', 'south africa',
  'suppliers', 'to the', 'to the suppliers', 'contact us', 'get in touch', 'personal', 'personal banking',
  '404', 'not found', 'page not found', 'error', 'oops'
]);

// Phrases that must not be saved as job title (snippet/heading text)
const GENERIC_JOB_TITLE_PHRASES = new Set([
  'to the', 'read more', 'for the', 'get in touch', 'contact us', 'about us', 'learn more', 'click here', 'find out more', 'view more', 'see more', 'the', 'and', 'our', 'your'
]);

// Generic page titles for company extraction (title/og:site_name)
const GENERIC_FOR_COMPANY = new Set([
  'home', 'contact', 'contact us', 'about', 'about us', '404', 'error', 'page not found', 'not found',
  'welcome', 'default', 'index', 'login', 'sign in', 'register'
]);

function isGenericTitle(text) {
  if (!text || typeof text !== 'string') return true;
  return GENERIC_FOR_COMPANY.has(text.toLowerCase().trim());
}

function splitTitle(title) {
  if (!title || typeof title !== 'string') return [];
  return title.split(/[\|\-–•:]/).map(p => p.trim()).filter(Boolean);
}

function matchDomain(parts, url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
    return parts.find(p => p.toLowerCase().replace(/\s/g, '').includes(hostname)) || null;
  } catch (e) {
    return null;
  }
}

function capitalizeWords(text) {
  if (!text || typeof text !== 'string') return '';
  return text.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function cleanCompanyDisplayName(name) {
  if (!name || typeof name !== 'string') return '';
  const fluff = ['leading', 'best', 'trusted', 'official site', 'welcome', 'official'];
  let cleaned = name.toLowerCase();
  fluff.forEach(word => {
    cleaned = cleaned.replace(new RegExp(word.replace(/\s/g, '\\s*'), 'gi'), '');
  });
  return capitalizeWords(cleaned.trim().replace(/\s+/g, ' '));
}

function domainFallback(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0] || '';
  } catch (e) {
    return '';
  }
}

/**
 * Extract company name from page metadata: prefer og:site_name, then title (part matching domain or shortest), then domain from URL.
 * @param {Object} opts - { title, url, ogSiteName }
 * @returns {string} - Cleaned company name
 */
function extractCompanyName(opts) {
  const { title, url, ogSiteName } = opts || {};
  if (ogSiteName && !isGenericTitle(ogSiteName)) {
    return cleanCompanyDisplayName(ogSiteName);
  }
  if (title && !isGenericTitle(title)) {
    const parts = splitTitle(title);
    if (parts.length) {
      const domainMatch = matchDomain(parts, url);
      if (domainMatch) return cleanCompanyDisplayName(domainMatch);
      const shortest = [...parts].sort((a, b) => a.length - b.length)[0];
      if (shortest) return cleanCompanyDisplayName(shortest);
    }
  }
  const fallback = domainFallback(url);
  return fallback ? capitalizeWords(fallback) : '';
}

/**
 * Get og:site_name from HTML string (for use with extractCompanyName when you have html but not ogSiteName).
 * @param {string} html - Page HTML
 * @returns {string|null}
 */
function getOgSiteNameFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:site_name["']/i);
  return m ? m[1].trim() : null;
}

/**
 * Decode URL-encoded characters in a string (%20 → space, etc.). Safe: does not throw.
 * @param {string} str - Raw value
 * @returns {string} - Decoded string
 */
function decodeUrlEncoded(str) {
  if (!str || typeof str !== 'string') return str;
  try {
    return decodeURIComponent(String(str).replace(/\+/g, ' '));
  } catch (e) {
    return String(str).replace(/%20/g, ' ').replace(/%2C/g, ',').replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%26/g, '&').replace(/%2B/g, '+');
  }
}

/**
 * Trim and convert to proper case (first letter of each word capitalized).
 * @param {string} str - Raw value
 * @returns {string} - Trimmed, proper-cased string
 */
function toProperCase(str) {
  if (!str || typeof str !== 'string') return '';
  const t = str.trim();
  if (!t) return '';
  return t.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Clean raw value: decode URL-encoded, trim, proper case.
 * @param {string} str - Raw value from scrape/import
 * @returns {string|null} - Cleaned string or null if empty after clean
 */
function cleanRawValue(str) {
  if (!str || typeof str !== 'string') return null;
  const decoded = decodeUrlEncoded(str);
  const trimmed = decoded.trim();
  if (!trimmed) return null;
  return toProperCase(trimmed) || null;
}

/** Returns true if str looks like a location, snippet phrase, or "read more" style text — not a person or company name. */
function isLikelyNotNameOrCompany(str) {
  if (!str || typeof str !== 'string') return true;
  const t = str.trim().toLowerCase();
  if (t.length < 2) return true;
  if (/^read\s*more$/i.test(t) || t === 'read more' || t.startsWith('read more')) return true;
  if (/\b(south|north|east|west)\s+(africa|america|europe|asia)\b/i.test(t)) return true;
  if (/\b(united\s+kingdom|united\s+states|new\s+zealand)\b/i.test(t)) return true;
  if (/^(search|results|view|link|page|home|website|web)\b/i.test(t)) return true;
  if (GENERIC_PAGE_TITLES.has(t)) return true;
  return false;
}

/**
 * Whether a string looks like a plausible company/organization name (not a page title or snippet).
 * Accepts names with Inc/LLC/Ltd or short domain-style names; rejects "About Us", "Home", etc.
 */
function looksLikeCompanyName(str) {
  if (!str || typeof str !== 'string') return false;
  const t = str.trim();
  if (t.length < 2 || t.length > 80) return false;
  const lower = t.toLowerCase();
  if (GENERIC_PAGE_TITLES.has(lower)) return false;
  if (/^(about\s+us|contact\s+us|home|welcome|read\s+more|privacy|terms|sitemap|login|sign\s+in)$/i.test(lower)) return false;
  // Reject very long single-word strings that look like concatenated words or domain (e.g. johannesburgconstructioncompanies)
  if (!/\s/.test(t) && t.length > 28) return false;
  const sentenceLike = /\b(for|this|these|the|and|with|our|your|get|see|learn|read|how|what|when|why)\b/i;
  if (sentenceLike.test(lower) && t.length > 20) return false;
  if (/^for\s+/i.test(lower) || /^this\s+/i.test(lower)) return false;
  if ((t.match(/\s/g) || []).length > 5) return false;
  if (/\b(inc\.?|llc|ltd\.?|limited|plc|gmbh|pty|corp\.?|co\.?)\b/i.test(t)) return true;
  return true;
}

/**
 * Clean company name: remove generic leading/trailing words (www, about, contact, etc.).
 * @param {string} name - Raw company name
 * @returns {string|null} - Cleaned name or null if nothing left
 */
function cleanCompanyName(name) {
  if (!name || typeof name !== 'string') return null;
  let t = name.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const genericSuffixes = [' - contact us', ' | contact us', ' contact', ' - contact', ' | contact', ' - about', ' | about', ' - home', ' | home'];
  for (const suffix of genericSuffixes) {
    if (lower.endsWith(suffix)) t = t.substring(0, t.length - suffix.length).trim();
  }
  const genericWords = ['www', 'about', 'contact', 'info', 'home', 'welcome'];
  const words = t.split(/\s+/).filter(w => w.length > 0);
  const filtered = words.filter(w => !genericWords.includes(w.toLowerCase()));
  t = filtered.join(' ').trim();
  return t || null;
}

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

// Common TLDs / second-level parts to skip when taking the "main" part of a domain (e.g. company.co.za → company)
const COMMON_TLDS = new Set(['com', 'org', 'net', 'co', 'io', 'za', 'uk', 'au', 'in', 'br', 'de', 'fr', 'it', 'es', 'nl', 'edu', 'gov', 'info', 'biz']);

/**
 * Derive company name from a domain string.
 * Rule: take the second part of the hostname (first is often subdomain). E.g. personal.nedbank.co.za → Nedbank, www.nedbank.co.za → Nedbank.
 * @param {string} domainStr - Domain or hostname (e.g. personal.nedbank.co.za or www.company.com)
 * @returns {string|null} - Company name (proper case) or null
 */
function companyNameFromDomainString(domainStr) {
  if (!domainStr || typeof domainStr !== 'string') return null;
  const raw = domainStr.trim().toLowerCase();
  if (!raw || !raw.includes('.')) return null;
  const parts = raw.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  // Strip TLD from the end (co, za, com, org, etc.)
  let j = parts.length - 1;
  while (j >= 0 && (parts[j].length <= 3 || COMMON_TLDS.has(parts[j]))) j--;
  if (j < 0) return null;
  const meaningful = parts.slice(0, j + 1);
  // Always take the second part when present (first is subdomain: www, personal, mail, etc.)
  const companyPart = meaningful.length >= 2 ? meaningful[1] : meaningful[0];
  if (!companyPart || companyPart.length < 2 || GENERIC_DOMAIN_PARTS.has(companyPart)) return null;
  return companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
}

/**
 * Extract company name from email domain.
 * Same rule as URL: take the second part (e.g. user@mail.nedbank.co.za → Nedbank).
 * @param {string} email - Email address
 * @returns {string|null} - Company name (proper case) or null
 */
function extractCompanyFromDomain(email) {
  if (!email) return null;
  try {
    const domain = email.split('@')[1];
    if (!domain) return null;
    const name = companyNameFromDomainString(domain);
    return name ? (cleanCompanyName(name) || name) : null;
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
 * Extract emails from mailto: links in HTML (these are explicit contact addresses, usually more reliable)
 * @param {string} html - HTML content
 * @returns {Array<string>} - Array of unique email addresses from mailto: hrefs
 */
function extractMailtoEmails(html) {
  if (!html || typeof html !== 'string') return [];
  const mailtoRegex = /mailto:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  const matches = [];
  let m;
  while ((m = mailtoRegex.exec(html)) !== null) {
    const email = m[1].toLowerCase().trim();
    if (email && !EMAIL_BLACKLIST.some(bl => email.includes(bl)) && email.length >= 6 && email.length <= 60) {
      matches.push(email);
    }
  }
  return [...new Set(matches)];
}

/**
 * Get the best email from an array (prioritizes mailto, then contact/info/sales, then business emails)
 * Fewer "would bounce" when we prefer addresses the company actually exposes as contact.
 * @param {Array<string>} emails - Array of email addresses
 * @param {{ mailtoEmails?: Array<string> }} options - Optional. mailtoEmails: from extractMailtoEmails(html)
 * @returns {string|null} - Best email or null
 */
function getBestEmail(emails, options = {}) {
  if (!emails || emails.length === 0) return null;
  const mailtoSet = new Set((options.mailtoEmails || []).map(e => e.toLowerCase()));
  const businessEmails = filterBusinessEmails(emails);
  const candidates = businessEmails.length > 0 ? businessEmails : emails;

  const score = (email) => {
    const lower = email.toLowerCase();
    const local = lower.split('@')[0] || '';
    let s = 0;
    if (mailtoSet.has(lower)) s += 100;
    if (PREFERRED_ROLE_LOCAL_PARTS.some(role => local === role || local.startsWith(role + '.'))) s += 50;
    if (local.length > 2 && local.length < 30 && !/^[0-9]+$/.test(local)) s += 10;
    if (local.length > 40 || /^[a-f0-9]{20,}$/.test(local)) s -= 30;
    return s;
  };

  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || null;
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
  if (!email || typeof email !== 'string') return null;
  email = decodeUrlEncoded(email).trim();
  if (!email || !isValidEmailFormat(email)) return null;

  if (isPersonalEmail(email)) return null;

  // 1) Clean all raw values: decode %20 etc., trim, proper case
  const rawFirst = additionalData.firstName != null ? cleanRawValue(String(additionalData.firstName)) : null;
  const rawLast = additionalData.lastName != null ? cleanRawValue(String(additionalData.lastName)) : null;
  const rawCompany = additionalData.company != null ? cleanRawValue(String(additionalData.company)) : null;
  const scrapedName = [rawFirst, rawLast].filter(Boolean).join(' ').trim() || null;
  const scrapedNameIsGeneric = scrapedName ? isLikelyNotNameOrCompany(scrapedName) : true;

  // 2) Name: Website/Google Search/Google Maps = page title or h1 only (pageDisplayName). LinkedIn = person name from profile. Never mix.
  let firstName = null;
  let lastName = null;
  const pageDisplayName = additionalData.pageDisplayName != null ? String(additionalData.pageDisplayName).trim() : '';
  const pageDisplayNameIsGeneric = !pageDisplayName || pageDisplayName.length < 2 ||
    GENERIC_PAGE_TITLES.has(pageDisplayName.toLowerCase()) ||
    isLikelyNotNameOrCompany(pageDisplayName) ||
    /^\d{3}$/.test(pageDisplayName); // e.g. 404, 500
  if (pageDisplayName && !pageDisplayNameIsGeneric) {
    // Source is website-like: do NOT use any person name from email or body. Name = title/h1 (or company) only.
    firstName = pageDisplayName.length > 100 ? pageDisplayName.substring(0, 100) : pageDisplayName;
    lastName = '';
  } else {
    // LinkedIn or other: allow name from email or scraped from context
    const localPart = email.split('@')[0].toLowerCase();
    const emailHasGenericLocal = GENERIC_LOCAL_PARTS.has(localPart);
    const nameFromEmail = emailHasGenericLocal ? null : extractNameFromEmail(email);
    firstName = (nameFromEmail && nameFromEmail.firstName) || null;
    lastName = (nameFromEmail && nameFromEmail.lastName) || null;
    if (!firstName && !lastName && scrapedName && !scrapedNameIsGeneric) {
      firstName = rawFirst || scrapedName;
      lastName = rawLast || null;
    }
    if (!firstName && !lastName) {
      firstName = null;
      lastName = null;
    }
  }

  // 3) Company: prefer URL (company_website) → then scraped text → then email domain
  const companyFromEmailDomain = extractCompanyFromDomain(email);
  let company = null;
  if (additionalData.company_website) {
    try {
      const urlHost = new URL(additionalData.company_website).hostname || '';
      if (urlHost) company = companyNameFromDomainString(urlHost);
    } catch (e) {}
  }
  if (!company && rawCompany) {
    if (/\.(co\.za|com|org|net|io|co\.uk)(\b|$)/i.test(rawCompany)) {
      company = companyNameFromDomainString(rawCompany) || companyFromEmailDomain;
    } else if (looksLikeCompanyName(rawCompany) && !isLikelyNotNameOrCompany(rawCompany)) {
      company = cleanCompanyName(rawCompany) || rawCompany;
    } else {
      company = companyFromEmailDomain;
    }
  }
  if (!company) company = companyFromEmailDomain;
  if (company) company = toProperCase(company.trim());

  // 4) Name fallback: use company for Name only when source is LinkedIn (person). Website/Google Search/Maps: Name = title or h1 only; never use company as Name.
  const source = (additionalData.source || '').toLowerCase();
  const isWebsiteLike = source === 'website' || source === 'google_search' || source === 'google_maps';
  if (!isWebsiteLike && !firstName && !lastName && company && !isLikelyNotNameOrCompany(company)) {
    firstName = company;
    lastName = null;
  }

  const contextData = extractNameAndTitleFromContext(email, text);
  let jobTitleRaw = additionalData.jobTitle || contextData.jobTitle;
  let jobTitle = jobTitleRaw != null ? cleanRawValue(String(jobTitleRaw)) : null;
  if (jobTitle) {
    const jLower = jobTitle.trim().toLowerCase();
    if (GENERIC_JOB_TITLE_PHRASES.has(jLower) || isLikelyNotNameOrCompany(jobTitle)) jobTitle = null;
  }

  // Build contact object with truncation for database limits
  const contact = {
    email: email.toLowerCase().trim(),
    first_name: truncateField(firstName, 100),
    last_name: truncateField(lastName, 100),
    job_title: truncateField(jobTitle, 100),
    company: truncateField(company, 100),
    email_domain: truncateField(email.split('@')[1], 100),
    source: additionalData.source || 'email_scraper',
    email_verified: false,
    verification_status: 'unverified',
    industry: truncateField(additionalData.industry != null ? cleanRawValue(String(additionalData.industry)) : null, 100),
    keywords: truncateField(additionalData.keywords != null ? cleanRawValue(String(additionalData.keywords)) : null, 100),
    location: truncateField(additionalData.location != null ? cleanRawValue(String(additionalData.location)) : null, 100),
    phone_number: additionalData.phone_number || null,
    mobile_number: additionalData.mobile_number || null,
    company_website: additionalData.company_website || null,
    company_summary: additionalData.company_summary ? truncateField(additionalData.company_summary, 500) : null,
    linkedin_url: additionalData.linkedin_url || null,
    search_query: truncateField(additionalData.search_query != null ? cleanRawValue(String(additionalData.search_query)) : null, 200) || null
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

  if (localPart.length < 3 || /^[0-9]+$/.test(localPart)) return null;
  if (PREFERRED_ROLE_LOCAL_PARTS.includes(localPart) || NOT_PERSON_NAME.has(localPart)) return null;
  if (ROLE_LOCAL_PART_SUBSTRINGS.some(sub => localPart.includes(sub))) return null;

  // Max length per name part so we don't create "Bui" + "Ldingplanapplication" from role/compound local parts
  const MAX_PART_LEN = 10;

  // Pattern 1: first.last (most common)
  if (localPart.includes('.')) {
    const parts = localPart.split('.');
    if (parts.length >= 2 && parts[0].length >= 2 && parts[0].length <= MAX_PART_LEN && parts[1].length >= 2 && parts[1].length <= MAX_PART_LEN) {
      if (NOT_PERSON_NAME.has(parts[0]) || NOT_PERSON_NAME.has(parts[1])) return null;
      const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      return { firstName, lastName, fullName: `${firstName} ${lastName}` };
    }
  }

  // Pattern 2: first_last
  if (localPart.includes('_')) {
    const parts = localPart.split('_');
    if (parts.length >= 2 && parts[0].length >= 2 && parts[0].length <= MAX_PART_LEN && parts[1].length >= 2 && parts[1].length <= MAX_PART_LEN) {
      if (NOT_PERSON_NAME.has(parts[0]) || NOT_PERSON_NAME.has(parts[1])) return null;
      const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      return { firstName, lastName, fullName: `${firstName} ${lastName}` };
    }
  }

  // Pattern 3: firstlast (no separator) — only when result looks like a real name (short total, short parts)
  // Don't split common single first names (e.g. melissa → Mel Issa)
  // Don't split long role-style local parts with no separator (e.g. ncibassistict, estatesinland)
  if (COMMON_SINGLE_FIRST_NAMES.has(localPart)) return null;
  if (localPart.length > 10 && !localPart.includes('.') && !localPart.includes('_') && !localPart.includes('-')) return null;
  if (localPart.length >= 6 && localPart.length <= 14 && !localPart.includes('.') && !localPart.includes('_') && !localPart.includes('-')) {
    const commonFirstNameLengths = [3, 4, 5];
    for (const len of commonFirstNameLengths) {
      const firstLen = len;
      const lastLen = localPart.length - len;
      if (lastLen >= 2 && firstLen <= 8 && lastLen <= 8) {
        const firstName = localPart.substring(0, firstLen).charAt(0).toUpperCase() + localPart.substring(0, firstLen).slice(1).toLowerCase();
        const lastName = localPart.substring(firstLen).charAt(0).toUpperCase() + localPart.substring(firstLen).slice(1).toLowerCase();
        if (NOT_PERSON_NAME.has(firstName.toLowerCase()) || NOT_PERSON_NAME.has(lastName.toLowerCase())) continue;
        return { firstName, lastName, fullName: `${firstName} ${lastName}` };
      }
    }
  }

  // Pattern 4: first-last (hyphen)
  if (localPart.includes('-')) {
    const parts = localPart.split('-');
    if (parts.length >= 2 && parts[0].length >= 2 && parts[0].length <= MAX_PART_LEN && parts[1].length >= 2 && parts[1].length <= MAX_PART_LEN) {
      if (NOT_PERSON_NAME.has(parts[0]) || NOT_PERSON_NAME.has(parts[1])) return null;
      const firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const lastName = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      return { firstName, lastName, fullName: `${firstName} ${lastName}` };
    }
  }

  return null;
}

module.exports = {
  extractEmails,
  extractMailtoEmails,
  isPersonalEmail,
  filterBusinessEmails,
  extractNameFromEmail,
  extractNameAndTitleFromContext,
  extractCompanyFromDomain,
  companyNameFromDomainString,
  extractCompanyName,
  getOgSiteNameFromHtml,
  isLikelyNotNameOrCompany,
  looksLikeCompanyName,
  cleanCompanyName,
  decodeUrlEncoded,
  toProperCase,
  cleanRawValue,
  isValidEmailFormat,
  getBestEmail,
  createContactFromEmail,
  truncateField,
  PERSONAL_EMAIL_DOMAINS
};
