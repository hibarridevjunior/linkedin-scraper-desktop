(function () {
  const RECEIVER_URL = 'http://localhost:8765/sales-nav-results';
  const statusEl = document.getElementById('status');
  const bulkScraperBtn = document.getElementById('bulkScraperBtn');
  const stopBtn = document.getElementById('stopBtn');
  const optRun = document.getElementById('optRun');
  const optEnrich = document.getElementById('optEnrich');
  const optSave = document.getElementById('optSave');

  function setStatus(msg, isError) {
    if (statusEl) {
      statusEl.textContent = msg || '';
      statusEl.className = isError ? 'err' : 'ok';
    }
  }

  function doRecover(data) {
    setStatus('Recovering ' + data.length + ' leads…', false);
    fetch(RECEIVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: data })
    })
      .then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function (result) {
        var toShow = Array.isArray(result.contacts) && result.contacts.length > 0 ? result.contacts : data;
        chrome.storage.local.set({ lastBulkExportResults: toShow }, function () {
          chrome.storage.local.remove(['bulkExportInProgress', 'bulkExportInProgressData'], function () {
            setStatus('Recovered ' + toShow.length + ' leads. Opening results.', false);
            chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
            if (recoverWrap) recoverWrap.style.display = 'none';
          });
        });
      })
      .catch(function () {
        chrome.storage.local.set({ lastBulkExportResults: data }, function () {
          chrome.storage.local.remove(['bulkExportInProgress', 'bulkExportInProgressData'], function () {
            setStatus('Recovered ' + data.length + ' leads (no app response). Opening results.', false);
            chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
            if (recoverWrap) recoverWrap.style.display = 'none';
          });
        });
      });
  }

  const recoverWrap = document.getElementById('recoverWrap');
  const recoverBtn = document.getElementById('recoverBtn');
  chrome.storage.local.get(['bulkExportInProgressData', 'lastBulkExportDone', 'bulkExportInProgress'], function (obj) {
    const data = obj.bulkExportInProgressData;
    const done = obj.lastBulkExportDone;
    const inProgress = obj.bulkExportInProgress === true;
    if (done && typeof done.at === 'number' && (Date.now() - done.at) < 5 * 60 * 1000) {
      setStatus('Done. ' + (done.count || 0) + ' leads saved. Results tab opened.', false);
      chrome.storage.local.remove(['lastBulkExportDone', 'bulkExportInProgress', 'bulkExportInProgressData']);
      return;
    }
    if (inProgress) {
      setStatus('Bulk export in progress…', false);
      return;
    }
    if (!Array.isArray(data) || data.length === 0) return;
    if (recoverWrap) {
      recoverWrap.style.display = 'block';
      const countEl = document.getElementById('recoverCount');
      if (countEl) countEl.textContent = data.length;
    }
    if (recoverBtn) {
      recoverBtn.addEventListener('click', function () {
        doRecover(data);
        recoverBtn.disabled = true;
      });
    }
  });

  /** Extract lead data from current page (run in lead profile tab). Used by Find email. */
  function extractLeadFromProfilePage() {
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
    const text = function (sel) {
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    };
    const name = text('[data-anonymize="person-name"]') || text('h1') || text('.artdeco-entity-lockup__title');
    const headline = text('[data-anonymize="headline"]') || text('[data-anonymize="title"]') || text('.artdeco-entity-lockup__subtitle');
    const company = text('[data-anonymize="company-name"]') || text('.artdeco-entity-lockup__subtitle');
    const location = text('[data-anonymize="location"]') || text('.artdeco-entity-lockup__caption');
    return { url: canonicalUrl, name: name || '', headline: headline || '', company: company || '', location: location || '' };
  }

  /** Get the Sales Nav tab: when popup is open, currentWindow can be the popup (no tabs). Find the tab with linkedin.com/sales. */
  async function getSalesNavTab() {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/sales/*' });
    if (tabs.length > 0) return tabs[0];
    const all = await chrome.tabs.query({ active: true });
    return all.find(function (t) { return t.url && t.url.includes('linkedin.com/sales'); }) || all[0] || null;
  }

  /** Find the element that actually scrolls the results list (scrollHeight > clientHeight). Run in tab. */
  function findScrollableListContainer() {
    const leadCardSelector = '.artdeco-entity-lockup';
    const cards = document.querySelectorAll(leadCardSelector);
    if (cards.length === 0) return null;
    let best = null;
    let bestCardCount = 0;
    let el = cards[0];
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight) {
        const cardCount = el.querySelectorAll(leadCardSelector).length;
        if (cardCount >= 3 && cardCount > bestCardCount) {
          best = el;
          bestCardCount = cardCount;
        }
      }
      el = el.parentElement;
    }
    if (best) return best;
    const byClass = document.querySelector('.search-results-container') || document.querySelector('.scaffold-layout__main') || document.querySelector('[class*="results-list"]') || document.querySelector('[class*="search-results"]') || document.querySelector('[class*="ResultsList"]');
    if (byClass && byClass.scrollHeight > byClass.clientHeight) return byClass;
    return document.scrollingElement || document.documentElement || document.body;
  }

  /** Do one scroll step down the results list. Run in tab. Returns { count, atBottom } so caller can wait for load. */
  function scrollResultsOnce() {
    const leadCardSelector = '.artdeco-entity-lockup';
    const container = findScrollableListContainer();
    if (!container) {
      window.scrollBy(0, 600);
      return { count: document.querySelectorAll(leadCardSelector).length, atBottom: (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100 };
    }
    const step = 700;
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) return { count: document.querySelectorAll(leadCardSelector).length, atBottom: true };
    container.scrollTop = Math.min(container.scrollTop + step, maxScroll);
    const atBottom = container.scrollTop >= maxScroll - 80;
    return { count: document.querySelectorAll(leadCardSelector).length, atBottom: atBottom };
  }

  /** Find and click the "Next" pagination button. Run in tab. Returns true if clicked, false if no Next. */
  function clickNextPage() {
    const selectors = [
      'button.artdeco-pagination__button--next',
      '.artdeco-pagination__button--next',
      'button[aria-label="Next"]',
      'button[aria-label="Next page"]',
      'a[aria-label="Next"]',
      '.artdeco-pagination button:last-of-type',
      'a.next',
      '.pagination__next a',
      'li.artdeco-pagination__indicator--number-active + li button',
      'li.artdeco-pagination__indicator--number-active + li a'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.disabled && (el.getAttribute('aria-disabled') !== 'true')) {
        el.click();
        return true;
      }
    }
    const buttons = document.querySelectorAll('button, a');
    for (const el of buttons) {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (text === 'next' || text === 'next page') {
        if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') {
          el.click();
          return true;
        }
      }
    }
    return false;
  }

  /** Check if there is a Next page button (not disabled). Run in tab. */
  function hasNextPage() {
    const nextBtn = document.querySelector('button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"]');
    if (nextBtn && nextBtn.getAttribute('aria-disabled') !== 'true' && !nextBtn.disabled) return true;
    const buttons = document.querySelectorAll('button');
    for (const el of buttons) {
      if ((el.innerText || el.textContent || '').trim().toLowerCase() === 'next') return !el.disabled;
    }
    return false;
  }

  /** Returns array of lead URLs that have their checkbox selected (run in tab). */
  function getSelectedUrls() {
    function isSelected(card) {
      if (card.querySelector('input[type="checkbox"]:checked')) return true;
      const row = card.closest('tr') || card.closest('[role="row"]') || card.parentElement;
      return !!(row && row.querySelector('input[type="checkbox"]:checked'));
    }
    const urls = [];
    const cards = document.querySelectorAll('.artdeco-entity-lockup');
    cards.forEach(card => {
      if (!isSelected(card)) return;
      const link = card.querySelector('a[href*="/in/"]') || card.querySelector('a[href*="/sales/lead/"]');
      if (!link) return;
      const href = (link.href || '').trim();
      if (!href || href.includes('/miniprofile/') || href.includes('/pub/')) return;
      if (href.includes('/in/')) {
        const m = href.match(/\/in\/([^\/\?]+)/);
        if (m && m[1]) urls.push('https://www.linkedin.com/in/' + m[1]);
      } else if (href.includes('/sales/lead/')) {
        const m = href.match(/\/sales\/lead\/([^?]+)/);
        if (m && m[1]) urls.push('https://www.linkedin.com/sales/lead/' + m[1].replace(/\?.*$/, '').trim());
      }
    });
    return urls;
  }

  function scrapeCurrentPage() {
    // 1) Find ONLY the results list container (left-side list), NOT the right-side preview/selected profile pane.
    // The results list has many lead cards; the preview pane has one. Use the container with the most cards.
    const leadCardSelector = '.artdeco-entity-lockup';
    const allCards = Array.from(document.querySelectorAll(leadCardSelector));
    const cardsWithLink = allCards.filter(card => {
      const a = card.querySelector('a[href*="/in/"]') || card.querySelector('a[href*="/sales/lead/"]');
      return a && !(a.href || '').includes('/miniprofile/') && !(a.href || '').includes('/pub/');
    });
    if (cardsWithLink.length === 0) return [];
    const getListParent = (el) => {
      let p = el.parentElement;
      while (p) {
        const count = p.querySelectorAll(leadCardSelector).length;
        if (count >= 2) return p;
        p = p.parentElement;
      }
      return null;
    };
    const parentCounts = new Map();
    cardsWithLink.forEach(card => {
      const parent = getListParent(card);
      if (parent) parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1);
    });
    let resultsListRoot = null;
    let maxCount = 0;
    parentCounts.forEach((count, parent) => {
      if (count > maxCount) {
        maxCount = count;
        resultsListRoot = parent;
      }
    });
    if (!resultsListRoot) resultsListRoot = document.body;
    const resultCards = resultsListRoot.querySelectorAll(leadCardSelector);
    const seen = new Set();
    const payload = [];
    const buttonLabels = /^(Connect|Message|Save|Follow|View|Profile|\.\.\.|More|Insights|Lead|Account)$/i;
    resultCards.forEach(card => {
      const link = card.querySelector('a[href*="/in/"]') || card.querySelector('a[href*="/sales/lead/"]');
      if (!link) return;
      const href = (link.href || '').trim();
      if (!href || href.includes('/miniprofile/') || href.includes('/pub/')) return;
      let url = '';
      if (href.includes('/in/')) {
        const m = href.match(/\/in\/([^\/\?]+)/);
        if (!m || !m[1] || m[1].length < 3 || m[1].includes('search')) return;
        url = 'https://www.linkedin.com/in/' + m[1];
      } else if (href.includes('/sales/lead/')) {
        const m = href.match(/\/sales\/lead\/([^?]+)/);
        if (!m || !m[1] || m[1].length < 5) return;
        url = 'https://www.linkedin.com/sales/lead/' + m[1].replace(/\?.*$/, '').trim();
      }
      if (!url || seen.has(url)) return;
      seen.add(url);
      const text = (sel, rootEl) => {
        const el = (rootEl || card).querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim() : '';
      };
      const firstText = (sels, rootEl) => {
        const r = rootEl || card;
        for (const sel of sels) {
          const v = text(sel, r);
          if (v) return v;
        }
        return '';
      };
      // Name: from DOM .artdeco-entity-lockup__title a span[data-anonymize="person-name"] (e.g. "Fernando Monteiro")
      let name = text('.artdeco-entity-lockup__title [data-anonymize="person-name"]', card);
      if (!name) {
        const nameSpan = link.querySelector('[data-anonymize="person-name"]');
        name = nameSpan ? (nameSpan.innerText || nameSpan.textContent || '').trim() : (link.innerText || link.textContent || '').trim().replace(/\s+/g, ' ').split('\n')[0].trim();
      }
      if (!name || name.length > 80 || buttonLabels.test(name)) {
        name = firstText([
          '.artdeco-entity-lockup__title',
          '[data-anonymize="person-name"]'
        ], card);
      }
      name = (name || '').trim();
      if (!name || name.toLowerCase() === 'unknown') return;
      // Headline: .artdeco-entity-lockup__subtitle is "Managing Director · Tega Industries SA"; [data-anonymize="title"] is job title
      const subtitleEl = card.querySelector('.artdeco-entity-lockup__subtitle');
      const subtitleRaw = subtitleEl ? (subtitleEl.innerText || subtitleEl.textContent || '').trim() : '';
      let headline = subtitleRaw || firstText(['[class*="entity-lockup__subtitle"]', '[data-anonymize="headline"]'], card);
      const jobTitleFromSub = card.querySelector('.artdeco-entity-lockup__subtitle [data-anonymize="title"]');
      const jobTitleOnly = jobTitleFromSub ? (jobTitleFromSub.innerText || jobTitleFromSub.textContent || '').trim() : '';
      if (jobTitleOnly && !headline) headline = jobTitleOnly;
      let company = '';
      if (subtitleRaw && subtitleRaw.includes('·')) {
        const parts = subtitleRaw.split('·').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) company = parts[parts.length - 1];
      }
      if (!company && (headline || subtitleRaw).includes(' at ')) {
        const src = headline || subtitleRaw;
        company = src.split(' at ')[1].split(/[·,|]/)[0].trim();
      }
      if (!company && (headline || subtitleRaw).includes(' @ ')) {
        const src = headline || subtitleRaw;
        company = src.split(' @ ')[1].split(/[·,|]/)[0].trim();
      }
      if (!company && (headline || subtitleRaw).includes(',')) {
        const src = headline || subtitleRaw;
        const parts = src.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) company = parts[parts.length - 1];
      }
      if (!company && (headline || subtitleRaw).includes(' | ')) {
        const src = headline || subtitleRaw;
        const parts = src.split(' | ').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) company = parts[parts.length - 1];
      }
      // Location: .artdeco-entity-lockup__caption [data-anonymize="location"] (e.g. "City of Johannesburg, Gauteng, South Africa")
      const location = text('.artdeco-entity-lockup__caption [data-anonymize="location"]', card) || firstText(['.artdeco-entity-lockup__caption', '[data-anonymize="location"]'], card);
      payload.push({
        url: url,
        name: name,
        headline: (headline || '').trim(),
        company: (company || '').trim(),
        location: (location || '').trim()
      });
    });
    return payload;
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function (e) {
      e.preventDefault();
      setStatus('Stopping… Save without contact details.', false);
      try {
        chrome.runtime.sendMessage({ action: 'stopBulkExportSaveWithoutEnrich' }, function (res) {
          if (chrome.runtime.lastError) {
            setStatus('Extension error.', true);
            return;
          }
          setStatus('Stop requested. Current leads will be saved without contact details when the run finishes.', false);
        });
      } catch (err) {
        setStatus('Failed: ' + (err.message || ''), true);
      }
    });
  }

  if (bulkScraperBtn) {
    bulkScraperBtn.addEventListener('click', async function (e) {
      e.preventDefault();
      if (!optRun || !optRun.checked) {
        setStatus('Check Run to collect profile data & LinkedIn links.', true);
        return;
      }
      if (!optSave || !optSave.checked) {
        setStatus('Check Save to send leads to the app.', true);
        return;
      }
      bulkScraperBtn.disabled = true;
      const doEnrich = optEnrich && optEnrich.checked;
      const msg = doEnrich
        ? 'Starting bulk scraper: profile data, then emails & contact details. Badge shows count.'
        : 'Starting bulk scraper: profile data & LinkedIn links only. Badge shows count.';
      setStatus(msg, false);
      try {
        const tab = await getSalesNavTab();
        if (!tab || !tab.id || !tab.url || !tab.url.includes('linkedin.com/sales')) {
          setStatus('Open a Sales Navigator search results page first.', true);
          bulkScraperBtn.disabled = false;
          return;
        }
        chrome.runtime.sendMessage({ action: 'startBulkExport', tabId: tab.id, skipEnrich: !doEnrich }, function (res) {
          if (chrome.runtime.lastError) {
            setStatus('Failed: ' + (chrome.runtime.lastError.message || ''), true);
            bulkScraperBtn.disabled = false;
            return;
          }
          setStatus('Bulk scraper running. You can close this popup. Use Stop to save without contact details.', false);
          bulkScraperBtn.disabled = false;
        });
      } catch (err) {
        setStatus('Failed: ' + (err.message || ''), true);
        bulkScraperBtn.disabled = false;
      }
    });
  }

})();
