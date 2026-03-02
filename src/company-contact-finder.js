/**
 * Company contact finder: COMPANY-FIRST only.
 * RULE: You must never search using a person's name alone. All searches must include a company name or company domain.
 * - findCompanyContact(companyName): company name only; never person name.
 * - searchCompanyWebsite(companyName): company name only.
 * - searchDomainForEmail(domain): domain only (site:domain).
 * Never use unrelated third-party sites for contact discovery.
 */

const https = require('https');
const http = require('http');
const { extractEmails, filterBusinessEmails, getBestEmail } = require('./email-extractor');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;
const MAX_BODY_LENGTH = 500000;

/** Use only company name for domain (strip job title, Pty Ltd, etc.). */
function companyNameForDomain(company) {
  if (!company || typeof company !== 'string') return '';
  let s = company.trim();
  s = s.replace(/\s*\(?\s*[Pp]ty\s*\)?\s*[Ll][td][td]\.?\s*$/i, '').replace(/\s*[Pp]ty\s+[Ll][td][td]\.?\s*$/i, '').trim();
  const atIdx = s.toLowerCase().indexOf(' at ');
  if (atIdx >= 0) s = s.slice(atIdx + 4).trim();
  const dashIdx = s.indexOf(' - ');
  if (dashIdx >= 0) s = s.slice(dashIdx + 3).trim();
  const pipeIdx = s.indexOf(' | ');
  if (pipeIdx >= 0) s = s.slice(pipeIdx + 3).trim();
  if (/^(cfo|ceo|cto|coo|cmo|director|manager|head|lead|founder|partner)\s+/i.test(s)) s = s.replace(/^(cfo|ceo|cto|coo|cmo|director|manager|head|lead|founder|partner)\s+/i, '').trim();
  return s;
}

/** Domains to try for a company (.co.za first, then .com). Uses company name only, not title+Pty Ltd. */
function companyToDomains(company) {
  if (!company || typeof company !== 'string') return [];
  const clean = companyNameForDomain(company);
  if (!clean) return [];
  const slug = clean.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (!slug || slug.length < 2) return [];
  return [slug + '.co.za', slug + '.com'];
}

function companyToDomain(company) {
  const domains = companyToDomains(company);
  return domains.length > 0 ? domains[0] : null;
}

function extractPhoneNumbers(text) {
  if (!text) return [];
  const patterns = [
    /\+27[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /0\d{2}[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/g,
    /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/g
  ];
  const allMatches = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    allMatches.push(...matches);
  }
  const cleaned = allMatches
    .map(p => p.replace(/[\s.-]/g, '').replace(/\D/g, ''))
    .filter(p => p.length >= 9 && p.length <= 15);
  return [...new Set(cleaned)];
}

/**
 * Fetch HTML from URL (follows one redirect, respects timeout).
 * @param {string} url
 * @returns {Promise<string|null>}
 */
function fetchHtml(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(
        parsed.toString(),
        { headers: { 'User-Agent': USER_AGENT } },
        (res) => {
          if (res.statusCode >= 301 && res.statusCode <= 302 && res.headers.location) {
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, url).toString();
            res.destroy();
            fetchHtml(next).then(resolve).catch(() => resolve(null));
            return;
          }
          if (res.statusCode !== 200) {
            res.destroy();
            resolve(null);
            return;
          }
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY_LENGTH) {
              res.destroy();
              resolve(body);
            }
          });
          res.on('end', () => resolve(body));
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(FETCH_TIMEOUT_MS, () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * Extract email and phone from HTML string.
 * @param {string} html
 * @returns {{ email: string|null, phone_number: string|null }}
 */
function extractContactFromHtml(html) {
  if (!html || typeof html !== 'string') return { email: null, phone_number: null };
  const text = html.replace(/<[^>]+>/g, ' ');
  const emails = extractEmails(text, html);
  const business = filterBusinessEmails(emails);
  const email = getBestEmail(emails) || (business.length ? business[0] : null) || null;
  const phones = extractPhoneNumbers(text);
  const phone_number = phones.length ? phones[0] : null;
  return { email, phone_number };
}

/**
 * Try to find company website via DuckDuckGo. RULE: Company name only — never person name.
 * @param {string} companyName - Company name only (required; do not pass person name).
 * @returns {Promise<string|null>}
 */
async function searchCompanyWebsite(companyName) {
  if (!companyName || typeof companyName !== 'string') return null;
  const query = encodeURIComponent(companyName + ' official website contact');
  const url = `https://html.duckduckgo.com/html/?q=${query}`;
  const html = await fetchHtml(url);
  if (!html) return null;
  const uddgMatch = html.match(/uddg=([^&"'\s]+)/);
  if (uddgMatch && uddgMatch[1]) {
    try {
      const decoded = decodeURIComponent(uddgMatch[1]);
      if (decoded.startsWith('http')) return decoded;
    } catch (e) {}
  }
  const hrefMatches = html.match(/href="(https?:\/\/[^"]+)"/g);
  if (hrefMatches) {
    for (const m of hrefMatches) {
      const u = m.replace(/^href="|"$/g, '');
      if (u.includes('duckduckgo.com') || u.includes('duck.com')) continue;
      if (u.startsWith('http')) return u;
    }
  }
  const resultLink = html.match(/class="result__a"[^>]*href="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*class="result__a"/);
  if (resultLink && resultLink[1]) {
    const raw = resultLink[1];
    if (raw.startsWith('//')) return 'https:' + raw;
    if (raw.startsWith('http')) return raw;
  }
  return null;
}

/**
 * Domain-restricted search: find pages on company domain (site:domain email).
 * RULE: All searches must include company/domain — never person name only.
 * @param {string} domain - e.g. "company.com" (no protocol)
 * @returns {Promise<{ email?: string, phone_number?: string, company_website?: string }|null>}
 */
async function searchDomainForEmail(domain) {
  if (!domain || typeof domain !== 'string') return null;
  const clean = domain.replace(/^https?:\/\//i, '').split('/')[0].trim();
  if (!clean || clean.length < 4) return null;
  const query = encodeURIComponent('site:' + clean + ' email');
  const url = `https://html.duckduckgo.com/html/?q=${query}`;
  const html = await fetchHtml(url);
  if (!html) return null;
  const resultLink = html.match(/class="result__a"[^>]*href="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*class="result__a"/);
  if (!resultLink || !resultLink[1]) return null;
  let pageUrl = resultLink[1];
  if (pageUrl.startsWith('//')) pageUrl = 'https:' + pageUrl;
  if (!pageUrl.startsWith('http')) return null;
  try {
    const pageHtml = await fetchHtml(pageUrl);
    if (pageHtml) {
      const { email, phone_number } = extractContactFromHtml(pageHtml);
      if (email || phone_number) {
        return { email: email || undefined, phone_number: phone_number || undefined, company_website: pageUrl };
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Find email and/or phone for a company. COMPANY-FIRST: official website, /contact, /about, /team, footer/header.
 * Never use person name only; requires company name.
 * @param {string} companyName - Company name only
 * @returns {Promise<{ email?: string, phone_number?: string, company_website?: string }|null>}
 */
async function findCompanyContact(companyName) {
  if (!companyName || typeof companyName !== 'string') return null;
  const domains = companyToDomains(companyName);
  const candidates = [];
  for (const domain of domains) {
    const base = 'https://' + domain;
    candidates.push(base, base + '/contact', base + '/contact-us', base + '/about', base + '/about-us', base + '/team', base + '/careers');
  }
  for (const url of candidates) {
    try {
      const html = await fetchHtml(url);
      if (!html) continue;
      const { email, phone_number } = extractContactFromHtml(html);
      if (email || phone_number) {
        return { email: email || undefined, phone_number: phone_number || undefined, company_website: url };
      }
    } catch (e) {
      // continue
    }
  }
  const searchUrl = await searchCompanyWebsite(companyName);
  if (searchUrl) {
    try {
      const html = await fetchHtml(searchUrl);
      if (html) {
        const { email, phone_number } = extractContactFromHtml(html);
        if (email || phone_number) {
          return { email: email || undefined, phone_number: phone_number || undefined, company_website: searchUrl };
        }
      }
      const contactPaths = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/careers'];
      for (const path of contactPaths) {
        const contactUrl = searchUrl.replace(/\/$/, '') + path;
        const contactHtml = await fetchHtml(contactUrl);
        if (contactHtml) {
          const { email, phone_number } = extractContactFromHtml(contactHtml);
          if (email || phone_number) {
            return { email: email || undefined, phone_number: phone_number || undefined, company_website: contactUrl };
          }
        }
      }
    } catch (e) {}
  }
  return null;
}

module.exports = {
  findCompanyContact,
  searchDomainForEmail,
  companyToDomain,
  extractContactFromHtml,
  fetchHtml
};
