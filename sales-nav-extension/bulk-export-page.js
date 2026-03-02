/**
 * Injected into Sales Nav tab for bulk export. Defines scroll/scrape/next helpers on window.
 */
(function () {
  function findScrollableListContainer() {
    var leadCardSelector = '.artdeco-entity-lockup';
    var cards = document.querySelectorAll(leadCardSelector);
    if (cards.length === 0) return null;
    var best = null;
    var bestCardCount = 0;
    var el = cards[0];
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight) {
        var cardCount = el.querySelectorAll(leadCardSelector).length;
        if (cardCount >= 3 && cardCount > bestCardCount) {
          best = el;
          bestCardCount = cardCount;
        }
      }
      el = el.parentElement;
    }
    if (best) return best;
    var byClass = document.querySelector('.search-results-container') || document.querySelector('.scaffold-layout__main') || document.querySelector('[class*="results-list"]') || document.querySelector('[class*="search-results"]') || document.querySelector('[class*="ResultsList"]');
    if (byClass && byClass.scrollHeight > byClass.clientHeight) return byClass;
    return document.scrollingElement || document.documentElement || document.body;
  }

  function scrollResultsOnce() {
    var leadCardSelector = '.artdeco-entity-lockup';
    var container = findScrollableListContainer();
    if (!container) {
      window.scrollBy(0, 600);
      return { count: document.querySelectorAll(leadCardSelector).length, atBottom: (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100 };
    }
    var step = 700;
    var maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) return { count: document.querySelectorAll(leadCardSelector).length, atBottom: true };
    container.scrollTop = Math.min(container.scrollTop + step, maxScroll);
    var atBottom = container.scrollTop >= maxScroll - 80;
    return { count: document.querySelectorAll(leadCardSelector).length, atBottom: atBottom };
  }

  function hasNextPage() {
    var nextBtn = document.querySelector('button.artdeco-pagination__button--next, .artdeco-pagination__button--next, button[aria-label="Next"]');
    if (nextBtn && nextBtn.getAttribute('aria-disabled') !== 'true' && !nextBtn.disabled) return true;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if ((buttons[i].innerText || buttons[i].textContent || '').trim().toLowerCase() === 'next') return !buttons[i].disabled;
    }
    return false;
  }

  function clickNextPage() {
    var selectors = ['button.artdeco-pagination__button--next', '.artdeco-pagination__button--next', 'button[aria-label="Next"]', 'button[aria-label="Next page"]', 'a[aria-label="Next"]', '.artdeco-pagination button:last-of-type', 'a.next', '.pagination__next a'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
        el.click();
        return true;
      }
    }
    var buttons = document.querySelectorAll('button, a');
    for (var j = 0; j < buttons.length; j++) {
      var text = (buttons[j].innerText || buttons[j].textContent || '').trim().toLowerCase();
      if (text === 'next' || text === 'next page') {
        if (!buttons[j].disabled && buttons[j].getAttribute('aria-disabled') !== 'true') {
          buttons[j].click();
          return true;
        }
      }
    }
    return false;
  }

  function scrapeCurrentPage() {
    var leadCardSelector = '.artdeco-entity-lockup';
    var allCards = Array.from(document.querySelectorAll(leadCardSelector));
    var cardsWithLink = allCards.filter(function (card) {
      var a = card.querySelector('a[href*="/in/"], a[href*="/sales/lead/"]');
      return a && !(a.href || '').includes('/miniprofile/') && !(a.href || '').includes('/pub/');
    });
    if (cardsWithLink.length === 0) return [];
    function getListParent(el) {
      var p = el.parentElement;
      while (p) {
        if (p.querySelectorAll(leadCardSelector).length >= 2) return p;
        p = p.parentElement;
      }
      return null;
    }
    var resultsListRoot = document.body;
    var maxCount = 0;
    cardsWithLink.forEach(function (card) {
      var parent = getListParent(card);
      if (parent) {
        var cardCount = parent.querySelectorAll(leadCardSelector).length;
        if (cardCount > maxCount) {
          maxCount = cardCount;
          resultsListRoot = parent;
        }
      }
    });
    var resultCards = resultsListRoot.querySelectorAll(leadCardSelector);
    var seen = {};
    var payload = [];
    var buttonLabels = /^(Connect|Message|Save|Follow|View|Profile|\.\.\.|More|Insights|Lead|Account)$/i;
    resultCards.forEach(function (card) {
      var inLink = card.querySelector('a[href*="/in/"]');
      var salesLink = card.querySelector('a[href*="/sales/lead/"]');
      var link = inLink || salesLink;
      if (!link) return;
      var href = (link.href || '').trim();
      if (!href || href.includes('/miniprofile/') || href.includes('/pub/')) return;
      var url = '';
      var profileUrl = null;
      if (href.includes('/in/')) {
        var m = href.match(/\/in\/([^\/\?]+)/);
        if (!m || !m[1] || m[1].length < 3 || m[1].includes('search')) return;
        url = 'https://www.linkedin.com/in/' + m[1];
        profileUrl = url;
      } else if (href.includes('/sales/lead/')) {
        var m2 = href.match(/\/sales\/lead\/([^?]+)/);
        if (!m2 || !m2[1] || m2[1].length < 5) return;
        url = 'https://www.linkedin.com/sales/lead/' + m2[1].replace(/\?.*$/, '').trim();
      }
      if (!url || seen[url]) return;
      seen[url] = true;
      function text(sel, rootEl) {
        var r = rootEl || card;
        var e = r.querySelector(sel);
        return e ? (e.innerText || e.textContent || '').trim() : '';
      }
      function firstText(sels, rootEl) {
        var r = rootEl || card;
        for (var s = 0; s < sels.length; s++) {
          var v = text(sels[s], r);
          if (v) return v;
        }
        return '';
      }
      var name = text('.artdeco-entity-lockup__title [data-anonymize="person-name"]', card);
      if (!name) {
        var nameSpan = link.querySelector('[data-anonymize="person-name"]');
        name = nameSpan ? (nameSpan.innerText || nameSpan.textContent || '').trim() : (link.innerText || link.textContent || '').trim().replace(/\s+/g, ' ').split('\n')[0].trim();
      }
      if (!name || name.length > 80 || buttonLabels.test(name)) {
        name = firstText(['.artdeco-entity-lockup__title', '[data-anonymize="person-name"]'], card);
      }
      name = (name || '').trim();
      if (!name || name.toLowerCase() === 'unknown') return;
      var subtitleEl = card.querySelector('.artdeco-entity-lockup__subtitle');
      var subtitleRaw = subtitleEl ? (subtitleEl.innerText || subtitleEl.textContent || '').trim() : '';
      var headline = subtitleRaw || firstText(['[class*="entity-lockup__subtitle"]', '[data-anonymize="headline"]'], card);
      var company = text('.artdeco-entity-lockup__subtitle [data-anonymize="company-name"]', card) || text('[data-anonymize="company-name"]', card) || '';
      if (!company && subtitleRaw && subtitleRaw.indexOf('·') !== -1) {
        var parts = subtitleRaw.split('·').map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts.length >= 2) company = parts[parts.length - 1];
      }
      if (!company && (headline || subtitleRaw).indexOf(' at ') !== -1) {
        var src = headline || subtitleRaw;
        company = src.split(' at ')[1].split(/[·,|]/)[0].trim();
      }
      if (!company && (headline || subtitleRaw).indexOf(' @ ') !== -1) {
        var src2 = headline || subtitleRaw;
        company = src2.split(' @ ')[1].split(/[·,|]/)[0].trim();
      }
      if (!company && (headline || subtitleRaw).indexOf(',') !== -1) {
        var parts2 = (headline || subtitleRaw).split(',').map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts2.length >= 2) company = parts2[parts2.length - 1];
      }
      if (!company && (headline || subtitleRaw).indexOf(' | ') !== -1) {
        var parts3 = (headline || subtitleRaw).split(' | ').map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts3.length >= 2) company = parts3[parts3.length - 1];
      }
      var location = text('.artdeco-entity-lockup__caption [data-anonymize="location"]', card) || firstText(['.artdeco-entity-lockup__caption', '[data-anonymize="location"]'], card);
      var row = { url: url, name: name, headline: (headline || '').trim(), company: (company || '').trim(), location: (location || '').trim() };
      if (profileUrl) row.linkedin_profile_url = profileUrl;
      payload.push(row);
    });
    return payload;
  }

  window.__bulkScrollOnce = scrollResultsOnce;
  window.__bulkScrape = scrapeCurrentPage;
  window.__bulkHasNext = hasNextPage;
  window.__bulkClickNext = clickNextPage;
})();
