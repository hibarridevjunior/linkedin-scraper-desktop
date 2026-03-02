/**
 * Runs on Sales Nav lead profile pages (/sales/lead/...).
 * When the lead page loads, scrape name, headline, company, location, email, industry
 * and POST to the app so the contact can be enriched/updated.
 */
(function () {
  const RECEIVER_URL = 'http://localhost:8765/sales-nav-results';

  function text(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }

  function extractLeadFromPage() {
    const url = window.location.href || '';
    if (!url.includes('/sales/lead/') && !url.includes('/in/')) return null;
    let canonicalUrl = url;
    if (url.includes('/sales/lead/')) {
      const m = url.match(/\/sales\/lead\/([^?]+)/);
      if (m && m[1]) canonicalUrl = 'https://www.linkedin.com/sales/lead/' + m[1].replace(/\?.*$/, '').trim();
    } else if (url.includes('/in/')) {
      const m = url.match(/\/in\/([^\/\?]+)/);
      if (m && m[1]) canonicalUrl = 'https://www.linkedin.com/in/' + m[1];
    }

    const name = text('[data-anonymize="person-name"]') || text('h1') || text('.artdeco-entity-lockup__title');
    const headline = text('[data-anonymize="headline"]') || text('[data-anonymize="title"]') || text('.artdeco-entity-lockup__subtitle');
    const company = text('[data-anonymize="company-name"]') || text('.artdeco-entity-lockup__subtitle');
    const location = text('[data-anonymize="location"]') || text('.artdeco-entity-lockup__caption');
    const industry = text('[data-anonymize="industry"]') || '';
    let email = '';
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto && mailto.href) email = (mailto.href.replace(/^mailto:/i, '').split('?')[0] || '').trim();
    let phone = '';
    const tel = document.querySelector('a[href^="tel:"]');
    if (tel && tel.href) phone = (tel.href.replace(/^tel:/i, '').split('?')[0] || '').trim();
    if (!phone && document.body) {
      const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
      const phoneMatch = bodyText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}(?:[-.\s]?\d{2,4})?/);
      if (phoneMatch) phone = phoneMatch[0].trim();
    }

    return {
      url: canonicalUrl,
      name: name || '',
      headline: headline || '',
      company: company || '',
      location: location || '',
      industry: industry || '',
      email: email || '',
      phone: phone || ''
    };
  }

  function sendToApp(lead) {
    if (!lead || !lead.url) return;
    fetch(RECEIVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: [lead] })
    }).then(res => {
      if (res.ok) console.log('[Sales Nav extension] Lead sent to app');
    }).catch(() => {});
  }

  function run() {
    setTimeout(() => {
      const lead = extractLeadFromPage();
      if (lead && lead.name) sendToApp(lead);
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
