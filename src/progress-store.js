/**
 * Progress store: persists run state for resume after restart.
 * Used only from main process. Stores: runId, queue (remaining jobs), configSummary, counts, lastUpdated.
 * No contact payloads — only job state and counts.
 */

const fs = require('fs');
const path = require('path');

const FILENAME = 'scraper-run-progress.json';

function getStorePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), FILENAME);
  } catch (e) {
    return path.join(process.cwd(), FILENAME);
  }
}

/**
 * Load progress from disk. Returns null if no file or invalid.
 */
function load() {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.queue)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Save progress to disk. data: { runId, queue, configSummary, counts, lastUpdated }.
 */
function save(data) {
  try {
    const filePath = getStorePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const toWrite = {
      runId: data.runId || null,
      queue: Array.isArray(data.queue) ? data.queue : [],
      configSummary: data.configSummary || null,
      counts: data.counts || { contactsCollected: 0 },
      lastUpdated: typeof data.lastUpdated === 'number' ? data.lastUpdated : Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 0), 'utf8');
  } catch (e) {
    console.error('Progress store save error:', e.message);
  }
}

/**
 * Clear progress (e.g. after run complete or user discard).
 */
function clear() {
  try {
    const filePath = getStorePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Progress store clear error:', e.message);
  }
}

module.exports = {
  load,
  save,
  clear,
  getStorePath
};
