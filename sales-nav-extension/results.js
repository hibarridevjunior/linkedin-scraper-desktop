(function () {
  const STORAGE_KEY = 'lastBulkExportResults';
  const tbody = document.getElementById('tbody');
  const countEl = document.getElementById('countEl');
  const emptyEl = document.getElementById('empty');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  let contacts = [];

  function escapeCsv(val) {
    if (val == null || val === undefined) return '';
    const s = String(val).trim();
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function displayName(c) {
    if ((c.first_name || c.last_name)) return ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '—';
    return (c.name || '').trim() || '—';
  }
  function displayEmail(c) {
    const email = (c.email || '').trim();
    const status = c.verification_status;
    if (!email) return '—';
    const statusBadge = status === 'inferred'
      ? ' <span class="email-status inferred" title="Guessed from company domain">Inferred</span>'
      : (status === 'unverified' ? ' <span class="email-status unverified" title="Not verified">Unverified</span>' : '');
    return escapeHtml(email) + statusBadge;
  }
  const doneBannerEl = document.getElementById('doneBanner');
  function render() {
    if (!tbody) return;
    tbody.innerHTML = '';
    if (contacts.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      if (countEl) countEl.textContent = '0 contacts';
      if (doneBannerEl) doneBannerEl.style.display = 'none';
      document.title = 'Collected contacts – Sales Nav';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (countEl) countEl.textContent = contacts.length + ' contact' + (contacts.length === 1 ? '' : 's');
    if (doneBannerEl) {
      doneBannerEl.textContent = 'Done. ' + contacts.length + ' contact' + (contacts.length === 1 ? '' : 's') + ' collected.';
      doneBannerEl.style.display = 'block';
    }
    document.title = 'Collected contacts (Done) – Sales Nav';
    contacts.forEach(function (c) {
      const name = displayName(c);
      const company = (c.company || '').trim() || '—';
      const phone = (c.phone_number || c.phone || '').trim() || '—';
      const profileUrl = (c.linkedin_url || c.linkedin_profile_url || c.url || '').trim();
      const tr = document.createElement('tr');
      const linkCell = profileUrl
        ? '<a class="link" href="' + profileUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">Profile</a>'
        : '—';
      tr.innerHTML =
        '<td>' + escapeHtml(name) + '</td>' +
        '<td>' + escapeHtml(company) + '</td>' +
        '<td>' + displayEmail(c) + '</td>' +
        '<td>' + escapeHtml(phone) + '</td>' +
        '<td>' + linkCell + '</td>';
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function downloadCsv() {
    const headers = ['Name', 'Company', 'Email', 'Phone', 'LinkedIn URL'];
    const rows = contacts.map(function (c) {
      const name = (c.first_name || c.last_name) ? ((c.first_name || '') + ' ' + (c.last_name || '')).trim() : (c.name || '');
      return [
        escapeCsv(name),
        escapeCsv(c.company),
        escapeCsv(c.email || c.email_address),
        escapeCsv(c.phone || c.phone_number),
        escapeCsv(c.linkedin_url || c.linkedin_profile_url || c.url || '')
      ].join(',');
    });
    const csv = [headers.map(escapeCsv).join(','), rows.join('\r\n')].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'collected_contacts_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', function () {
      if (contacts.length === 0) return;
      exportCsvBtn.disabled = true;
      downloadCsv();
      exportCsvBtn.disabled = false;
    });
  }

  function load() {
    try {
      chrome.storage.local.get([STORAGE_KEY], function (obj) {
        contacts = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
        render();
        if (exportCsvBtn) exportCsvBtn.disabled = contacts.length === 0;
      });
    } catch (e) {
      contacts = [];
      render();
    }
  }

  load();
})();
