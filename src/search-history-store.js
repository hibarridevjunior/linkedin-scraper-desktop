/**
 * Search history store: persists LinkedIn (and other) search runs for the dashboard.
 * Used only from main process. File: userData/search-history.json
 * Format: { runs: [ { runId, keyword, leadCount, source, createdAt }, ... ] }
 */

const fs = require('fs');
const path = require('path');

const FILENAME = 'search-history.json';

function getStorePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), FILENAME);
  } catch (e) {
    return path.join(process.cwd(), FILENAME);
  }
}

function load() {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) return { runs: [] };
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.runs) ? data : { runs: [] };
  } catch (e) {
    return { runs: [] };
  }
}

function append(runId, keyword, leadCount, source) {
  try {
    const data = load();
    data.runs.unshift({
      runId,
      keyword: keyword || 'Search',
      leadCount: typeof leadCount === 'number' ? leadCount : 0,
      source: source || null,
      createdAt: new Date().toISOString()
    });
    const filePath = getStorePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
  } catch (e) {
    console.error('Search history append error:', e.message);
  }
}

module.exports = {
  load,
  append,
  getStorePath
};
