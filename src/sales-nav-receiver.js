/**
 * Local HTTP receiver for Sales Nav Chrome extension.
 * Extension POSTs current search results; we normalize to contacts and save.
 * Run when app is ready; listens on port 8765.
 */

const http = require('http');
const { findCompanyContact, searchDomainForEmail } = require('./company-contact-finder');

const PORT = 8765;

function truncate(value, max = 100) {
  if (value == null || typeof value !== 'string') return value;
  return value.length > max ? value.substring(0, max) : value;
}

/** Use only company name for domain (strip job title, Pty Ltd). */
function companyNameForDomain(company) {
  if (!company || typeof company !== 'string') return '';
  let s = company.trim();
  s = s.replace(/\s*\(?\s*[Pp]ty\s*\)?\s*[Ll][td][td]\.?\s*$/i, '').replace(/\s*[Pp]ty\s+[Ll][td][td]\.?\s*$/i, '').trim();
  const atIdx = s.toLowerCase().indexOf(' at ');
  if (atIdx >= 0) s = s.slice(atIdx + 4).trim();
  const dashIdx = s.indexOf(' - ');
  if (dashIdx >= 0) s = s.slice(dashIdx + 3).trim();
  if (/^(cfo|ceo|cto|coo|cmo|director|manager|head|lead|founder|partner)\s+/i.test(s)) s = s.replace(/^(cfo|ceo|cto|coo|cmo|director|manager|head|lead|founder|partner)\s+/i, '').trim();
  return s;
}

/** Return domains to try for email inference (.co.za first, then .com). */
function companyToDomains(company) {
  if (!company || typeof company !== 'string') return [];
  const clean = companyNameForDomain(company);
  if (!clean) return [];
  const slug = clean.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (!slug || slug.length < 2) return [];
  return [slug + '.co.za', slug + '.com'];
}

function generateEmailCandidates(firstName, lastName, domain) {
  if (!domain) return [];
  const patterns = ['info@' + domain];
  const first = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const last = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (first || last) {
    patterns.push(
      first + '.' + last + '@' + domain,
      first + '@' + domain,
      first + last + '@' + domain,
      (first.charAt(0) || '') + last + '@' + domain,
      first + '_' + last + '@' + domain,
      first + '-' + last + '@' + domain
    );
  }
  return patterns.filter(e => e.includes('@') && !e.includes('undefined'));
}

/** First inferred email trying .co.za then .com for the company slug. */
function getFirstInferredEmail(firstName, lastName, company) {
  const domains = companyToDomains(company);
  for (let i = 0; i < domains.length; i++) {
    const candidates = generateEmailCandidates(firstName, lastName, domains[i]);
    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

function normalizeExtensionResults(results) {
  if (!Array.isArray(results)) return [];
  const contacts = [];
  results.forEach((r) => {
    const url = r.url || '';
    if (!url) return;
    const name = (r.name || '').trim();
    const headline = (r.headline || '').trim();
    const companyFromPayload = (r.company || '').trim();
    const locationFromPayload = (r.location || '').trim();
    let jobTitle = '';
    let company = companyFromPayload;
    if (headline) {
      if (headline.includes(' at ')) {
        const p = headline.split(' at ');
        jobTitle = (p[0] || '').trim();
        if (!company) company = (p[1] || '').split(/[·,|]/)[0].trim();
      } else if (headline.includes(' @ ')) {
        const p = headline.split(' @ ');
        jobTitle = (p[0] || '').trim();
        if (!company) company = (p[1] || '').split(/[·,|]/)[0].trim();
      } else if (headline.includes('·')) {
        const parts = headline.split('·').map(s => s.trim()).filter(Boolean);
        jobTitle = parts[0] || '';
        if (parts.length >= 2 && !company) company = parts[parts.length - 1];
      } else if (headline.includes(',')) {
        const parts = headline.split(',').map(s => s.trim()).filter(Boolean);
        jobTitle = parts[0] || '';
        if (parts.length >= 2 && !company) company = parts[parts.length - 1];
      } else if (headline.includes(' | ')) {
        const parts = headline.split(' | ').map(s => s.trim()).filter(Boolean);
        jobTitle = parts[0] || '';
        if (parts.length >= 2 && !company) company = parts[parts.length - 1];
      } else if (headline.includes(' - ')) {
        const parts = headline.split(' - ').map(s => s.trim()).filter(Boolean);
        jobTitle = parts[0] || '';
        if (parts.length >= 2 && !company) company = parts[parts.length - 1];
      } else {
        const parts = headline.split('·')[0].trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          jobTitle = parts.slice(0, 2).join(' ');
          if (!company) company = parts.slice(2).join(' ').trim();
        } else {
          jobTitle = headline.split('·')[0].trim();
        }
      }
    }
    const nameParts = name ? name.split(/\s+/) : [];
    let firstName = nameParts[0] || '';
    let lastName = nameParts.slice(1).join(' ') || '';
    if (!firstName && !lastName && url) {
      const slug = url.match(/\/in\/([^\/\?]+)/);
      if (slug && slug[1]) {
        firstName = 'Sales Nav';
        lastName = slug[1].replace(/-/g, ' ').substring(0, 50);
      } else {
        firstName = 'Sales Nav';
        lastName = 'lead';
      }
    }
    let email = r.email || null;
    let emailInferred = false;
    if (!email && company) {
      const inferred = getFirstInferredEmail(firstName, lastName, company);
      if (inferred) {
        email = inferred;
        emailInferred = true;
      }
    }
    if (!email && !company && headline && firstName) {
      const segments = headline.split(/\s+at\s+|\s+@\s+|[·,|]|\s+-\s+/).map(s => s.trim()).filter(Boolean);
      let possibleCompany = null;
      if (segments.length >= 2) {
        possibleCompany = segments[segments.length - 1];
      } else if (segments.length === 1) {
        const words = segments[0].trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          possibleCompany = words.slice(2).join(' ');
          if (!jobTitle) jobTitle = words.slice(0, 2).join(' ');
        } else if (segments[0].length >= 3) {
          possibleCompany = segments[0];
        }
      }
      if (possibleCompany && possibleCompany.length >= 2 && possibleCompany.length <= 60 && !/^(director|manager|engineer|lead|head|ceo|cto|vp|sales|marketing)$/i.test(possibleCompany)) {
        const inferred = getFirstInferredEmail(firstName, lastName, possibleCompany);
        if (inferred) {
          email = inferred;
          company = company || possibleCompany;
          emailInferred = true;
        }
      }
    }
    const verificationStatus = email ? (emailInferred ? 'inferred' : 'unverified') : 'no_email';
    const phone = (r.phone || r.phone_number || '').trim();
    contacts.push({
      first_name: truncate(firstName, 100),
      last_name: truncate(lastName, 100),
      email: email ? truncate(email, 255) : null,
      company: truncate(company, 100),
      job_title: truncate(jobTitle, 100),
      location: truncate(locationFromPayload, 100),
      phone_number: phone ? truncate(phone, 50) : null,
      email_domain: null,
      source: 'linkedin_sales_navigator',
      email_verified: false,
      verification_status: verificationStatus,
      industry: truncate(r.industry || null, 100),
      keywords: null,
      linkedin_url: url,
      search_query: truncate('Sales Navigator (extension)', 200)
    });
  });
  return contacts;
}

function handleFindEmail(body, saveContactsToSupabase, onRefresh) {
  const data = typeof body === 'string' ? JSON.parse(body || '{}') : body;
  const name = (data.name || '').trim();
  const company = (data.company || '').trim();
  const url = (data.url || '').trim();
  const headline = (data.headline || '').trim();
  const location = (data.location || '').trim();
  if (!url) {
    return { status: 400, json: { error: 'Missing url', email: null } };
  }
  const nameParts = name ? name.split(/\s+/).filter(Boolean) : [];
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  let jobTitle = '';
  if (headline && headline.includes('·')) {
    jobTitle = headline.split('·')[0].trim();
  } else if (headline) {
    jobTitle = headline.split(' at ')[0].trim();
  }
  const guessedEmail = getFirstInferredEmail(firstName, lastName, company);
  const contact = {
    first_name: truncate(firstName || 'Sales Nav', 100),
    last_name: truncate(lastName || 'lead', 100),
    email: guessedEmail,
    company: truncate(company, 100),
    job_title: truncate(jobTitle, 100),
    location: truncate(location, 100),
    email_domain: guessedEmail ? truncate(guessedEmail.split('@')[1], 100) : null,
    source: 'linkedin_sales_navigator',
    email_verified: false,
    verification_status: guessedEmail ? 'inferred' : 'no_email',
    industry: null,
    keywords: null,
    linkedin_url: url,
    search_query: truncate('Sales Navigator (Find email)', 200)
  };
  saveContactsToSupabase([contact]);
  if (typeof onRefresh === 'function') onRefresh();
  return {
    status: 200,
    json: {
      email: contact.email,
      contact: { first_name: contact.first_name, last_name: contact.last_name, company: contact.company },
      message: guessedEmail
        ? `Guessed email saved: ${guessedEmail}. Verify in the dashboard.`
        : 'No email guessed (need company for domain). Contact saved without email.'
    }
  };
}

/**
 * Enrich a sales lead. RULE: Never search using a person's name alone. All searches must include company name or company domain.
 * Strict order: (1) LinkedIn profile data; (2) Company-first (official site); (3) Domain-restricted site:domain; (4) Infer and label; (5) No company → Needs Manual Review, no search.
 */
async function handleEnrich(body, getSupabase, updateContactByLinkedInUrl, onRefresh) {
  const data = typeof body === 'string' ? JSON.parse(body || '{}') : body;
  const url = (data.url || '').trim();
  if (!url) {
    return { status: 400, json: { error: 'Missing url' } };
  }
  const updates = {};
  if (data.name != null && String(data.name).trim()) {
    const nameParts = String(data.name).trim().split(/\s+/).filter(Boolean);
    updates.first_name = truncate(nameParts[0] || '', 100);
    updates.last_name = truncate(nameParts.slice(1).join(' ') || '', 100);
  }
  if (data.headline != null && String(data.headline).trim()) {
    updates.job_title = truncate(String(data.headline).trim(), 100);
  }
  if (data.company != null && String(data.company).trim()) {
    updates.company = truncate(String(data.company).trim(), 100);
  }
  if (data.location != null && String(data.location).trim()) {
    updates.location = truncate(String(data.location).trim(), 100);
  }
  if (data.industry != null && String(data.industry).trim()) {
    updates.industry = truncate(String(data.industry).trim(), 100);
  }
  let row = null;
  const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
  if (supabase) {
    const { data: contactRow } = await supabase
      .from('contacts')
      .select('first_name, last_name, company')
      .eq('linkedin_url', url)
      .maybeSingle();
    row = contactRow || null;
  }

  const companyForSearch = (row && row.company && String(row.company).trim()) || (data.company && String(data.company).trim()) || null;

  if (data.email != null && data.email !== '') {
    updates.email = truncate(String(data.email), 255);
    updates.verification_status = 'unverified';
    updates.email_verified = false;
  }
  if (data.phone != null && data.phone !== '') {
    updates.phone_number = truncate(String(data.phone), 50);
  }
  if (data.website != null && String(data.website).trim() !== '') {
    updates.company_website = truncate(String(data.website).trim(), 255);
  } else if (Array.isArray(data.websites) && data.websites.length > 0 && data.websites[0]) {
    updates.company_website = truncate(String(data.websites[0]), 255);
  }
  if (data.linkedin_profile_url != null && String(data.linkedin_profile_url).trim() !== '') {
    updates.linkedin_url = truncate(String(data.linkedin_profile_url).trim(), 500);
  }

  if (!companyForSearch && !updates.email && !updates.phone_number) {
    updates.verification_status = 'needs_manual_review';
  }

  if (companyForSearch && (!updates.email || !updates.phone_number)) {
    try {
      const found = await findCompanyContact(companyForSearch);
      if (found) {
        if (found.email && !updates.email) {
          updates.email = truncate(found.email, 255);
          updates.verification_status = 'unverified';
          updates.email_verified = false;
        }
        if (found.phone_number && !updates.phone_number) {
          updates.phone_number = truncate(found.phone_number, 50);
        }
        if (found.company_website) {
          updates.company_website = truncate(found.company_website, 255);
        }
      }
    } catch (e) {
      console.error('[Sales Nav receiver] findCompanyContact error:', e.message);
    }
  }

  if (!updates.email && companyForSearch) {
    const domains = companyToDomains(updates.company || companyForSearch);
    for (let i = 0; i < domains.length; i++) {
      try {
        const domainFound = await searchDomainForEmail(domains[i]);
        if (domainFound && domainFound.email) {
          updates.email = truncate(domainFound.email, 255);
          updates.verification_status = 'unverified';
          updates.email_verified = false;
          if (domainFound.company_website) {
            updates.company_website = truncate(domainFound.company_website, 255);
          }
          break;
        }
      } catch (e) {
        console.error('[Sales Nav receiver] searchDomainForEmail error:', e.message);
      }
    }
  }

  if (!updates.email && companyForSearch) {
    const firstName = (updates.first_name != null && updates.first_name !== '') ? updates.first_name : (row?.first_name || '');
    const lastName = (updates.last_name != null && updates.last_name !== '') ? updates.last_name : (row?.last_name || '');
    const inferred = getFirstInferredEmail(firstName, lastName, updates.company || companyForSearch);
    if (inferred) {
      updates.email = truncate(inferred, 255);
      updates.verification_status = 'inferred';
      updates.email_verified = false;
    }
  }

  if (!updates.email && !updates.phone_number) {
    updates.verification_status = 'needs_manual_review';
  }

  if (Object.keys(updates).length === 0) {
    return { status: 200, json: { updated: false, message: 'No contact details to update' } };
  }
  const { error } = await updateContactByLinkedInUrl(url, updates);
  if (typeof onRefresh === 'function') onRefresh();
  return { status: 200, json: { updated: !error, message: error ? error.message : 'Contact updated' } };
}

function escapeCsv(val) {
  if (val == null) return '';
  const s = String(val).trim();
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function handleExportContacts(getSupabase) {
  const supabase = typeof getSupabase === 'function' ? getSupabase() : null;
  if (!supabase) return { status: 500, body: 'App not ready' };
  const { data: rows, error } = await supabase
    .from('contacts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return { status: 500, body: 'Error loading contacts' };
  const contacts = rows || [];
  const headers = [
    'Name', 'Email', 'Company', 'Industry', 'Job Title', 'Phone', 'Location',
    'Source', 'LinkedIn', 'Verified', 'Website'
  ];
  const lines = [headers.map(escapeCsv).join(',')];
  contacts.forEach((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    lines.push([
      escapeCsv(name),
      escapeCsv(c.email),
      escapeCsv(c.company),
      escapeCsv(c.industry),
      escapeCsv(c.job_title),
      escapeCsv(c.phone_number),
      escapeCsv(c.location),
      escapeCsv(c.source),
      escapeCsv(c.linkedin_url),
      c.email_verified ? 'Yes' : 'No',
      escapeCsv(c.company_website)
    ].join(','));
  });
  return { status: 200, body: lines.join('\r\n'), contentType: 'text/csv; charset=utf-8' };
}

function createReceiverServer(getSupabase, saveContactsToSupabase, onRefresh, updateContactByLinkedInUrl) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/export-contacts') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      try {
        const result = await handleExportContacts(getSupabase);
        res.writeHead(result.status, {
          'Content-Type': result.contentType || 'text/plain',
          'Content-Disposition': 'attachment; filename="contacts_export.csv"'
        });
        res.end(result.body || '');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Export failed');
      }
      return;
    }
    const allowed = ['/sales-nav-results', '/sales-nav-find-email', '/sales-nav-enrich'];
    if (req.method !== 'POST' || !allowed.includes(req.url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      try {
        if (req.url === '/sales-nav-find-email') {
          const result = handleFindEmail(body, saveContactsToSupabase, onRefresh);
          res.writeHead(result.status);
          res.end(JSON.stringify(result.json));
          return;
        }
        if (req.url === '/sales-nav-enrich') {
          const updateFn = typeof updateContactByLinkedInUrl === 'function' ? updateContactByLinkedInUrl : () => Promise.resolve({});
          handleEnrich(body, getSupabase, updateFn, onRefresh).then(result => {
            res.writeHead(result.status);
            res.end(JSON.stringify(result.json));
          });
          return;
        }
        const data = JSON.parse(body || '{}');
        const raw = data.results || [];
        const contacts = normalizeExtensionResults(raw);
        if (contacts.length === 0) {
          res.writeHead(200);
          res.end(JSON.stringify({ saved: 0, message: 'No valid leads to save.' }));
          return;
        }
        try {
          await saveContactsToSupabase(contacts);
        } catch (saveErr) {
          console.error('[Sales Nav receiver] Save to Supabase failed:', saveErr && saveErr.message ? saveErr.message : saveErr);
          res.writeHead(200);
          res.end(JSON.stringify({
            saved: 0,
            withEmail: 0,
            error: 'Save failed: ' + (saveErr && saveErr.message ? saveErr.message : String(saveErr)),
            message: 'Leads could not be saved to the app. Check app console and Supabase config.'
          }));
          return;
        }
        const withEmail = contacts.filter(c => c && c.email);
        if (typeof onRefresh === 'function') onRefresh();
        res.writeHead(200);
        res.end(JSON.stringify({
          saved: contacts.length,
          withEmail: withEmail.length,
          message: contacts.length + ' leads saved to Marketing System.',
          contacts: contacts
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Server error' }));
      }
    });
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn('[Sales Nav receiver] Port ' + PORT + ' is already in use. Close any other instance of this app (or the app using port ' + PORT + '), then restart. Extension send will not work until the port is free.');
    } else {
      console.error('[Sales Nav receiver]', err.message);
    }
    serverInstance = null;
  });
  return server;
}

let serverInstance = null;

function startSalesNavReceiver(getSupabase, saveContactsToSupabase, onRefresh, updateContactByLinkedInUrl) {
  if (serverInstance) return { port: PORT, alreadyRunning: true };
  const server = createReceiverServer(getSupabase, saveContactsToSupabase, onRefresh, updateContactByLinkedInUrl);
  server.listen(PORT, '127.0.0.1', () => {
    console.log('[Sales Nav receiver] Listening on http://127.0.0.1:' + PORT);
  });
  serverInstance = server;
  return { port: PORT };
}

function stopSalesNavReceiver() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    console.log('[Sales Nav receiver] Stopped');
  }
}

function isSalesNavReceiverRunning() {
  return !!serverInstance;
}

module.exports = {
  startSalesNavReceiver,
  stopSalesNavReceiver,
  isSalesNavReceiverRunning,
  PORT
};
