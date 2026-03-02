/**
 * Cooldown / rate config for scraping.
 * Set SCRAPE_FAST=1 (env) for ~2–3x faster scraping; higher CAPTCHA/block risk.
 */

const USE_FAST_DELAYS = process.env.SCRAPE_FAST === '1' || process.env.SCRAPE_FAST === 'true';
function v(normal, fast) {
  return USE_FAST_DELAYS ? fast : normal;
}

// ——— Google Search ———
const GOOGLE_AFTER_SEARCH_MIN = v(5000, 2000);
const GOOGLE_AFTER_SEARCH_MAX = v(8000, 3500);
const GOOGLE_AFTER_RESULTS_MIN = v(5000, 2000);
const GOOGLE_AFTER_RESULTS_MAX = v(8000, 3500);
const GOOGLE_CAPTCHA_CHECK_MIN = v(2000, 1000);
const GOOGLE_CAPTCHA_CHECK_MAX = v(3000, 1500);
const GOOGLE_SCROLL_MIN = v(2000, 800);
const GOOGLE_SCROLL_MAX = v(3500, 1500);
const GOOGLE_BETWEEN_RESULTS_MIN = v(500, 200);
const GOOGLE_BETWEEN_RESULTS_MAX = v(900, 400);
const GOOGLE_BETWEEN_PAGE_VISITS_MIN = v(400, 150);
const GOOGLE_BETWEEN_PAGE_VISITS_MAX = v(900, 400);
const GOOGLE_FINAL_MIN = v(500, 200);
const GOOGLE_FINAL_MAX = v(1000, 400);

// ——— LinkedIn ———
const LINKEDIN_AFTER_NAV_MIN = v(2000, 800);
const LINKEDIN_AFTER_NAV_MAX = v(3000, 1200);
const LINKEDIN_SCROLL_SHORT_MIN = v(100, 50);
const LINKEDIN_SCROLL_SHORT_MAX = v(200, 100);
const LINKEDIN_SCROLL_MED_MIN = v(300, 150);
const LINKEDIN_SCROLL_MED_MAX = v(500, 250);
const LINKEDIN_PROFILE_MIN = v(400, 200);
const LINKEDIN_PROFILE_MAX = v(700, 350);
const LINKEDIN_FINAL_MIN = v(500, 200);
const LINKEDIN_FINAL_MAX = v(1000, 400);

// ——— Google Maps ———
const MAPS_PAGE_STABILITY_MIN = v(500, 300);
const MAPS_PAGE_STABILITY_MAX = v(800, 450);
const MAPS_TILES_LOAD_MIN = v(1000, 500);
const MAPS_TILES_LOAD_MAX = v(1500, 700);
const MAPS_SCROLL_MORE_MIN = v(2500, 1000);
const MAPS_SCROLL_MORE_MAX = v(3500, 1500);
const MAPS_BETWEEN_ENRICH_MIN = v(400, 200);
const MAPS_BETWEEN_ENRICH_MAX = v(700, 350);
const MAPS_BETWEEN_VISITS_MIN = v(1000, 400);
const MAPS_BETWEEN_VISITS_MAX = v(2000, 800);
const MAPS_FINAL_MIN = v(500, 200);
const MAPS_FINAL_MAX = v(1000, 400);

// ——— Website scraper ———
const WEBSITE_INIT_MIN = v(2000, 800);
const WEBSITE_INIT_MAX = v(3000, 1200);
const WEBSITE_BETWEEN_PAGES_MIN = v(1500, 600);
const WEBSITE_BETWEEN_PAGES_MAX = v(2500, 1000);
const WEBSITE_BETWEEN_SITES_MIN = v(800, 300);
const WEBSITE_BETWEEN_SITES_MAX = v(1500, 600);
const WEBSITE_FINAL_MIN = v(300, 150);
const WEBSITE_FINAL_MAX = v(500, 250);

// ——— Between jobs (job runner) ———
const BETWEEN_JOBS_MS = USE_FAST_DELAYS ? 10000 : 30000;

function randomMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Delay for Google Search cooldowns (returns a Promise). */
function googleDelay(key) {
  const map = {
    afterSearch: [GOOGLE_AFTER_SEARCH_MIN, GOOGLE_AFTER_SEARCH_MAX],
    afterResults: [GOOGLE_AFTER_RESULTS_MIN, GOOGLE_AFTER_RESULTS_MAX],
    captchaCheck: [GOOGLE_CAPTCHA_CHECK_MIN, GOOGLE_CAPTCHA_CHECK_MAX],
    scroll: [GOOGLE_SCROLL_MIN, GOOGLE_SCROLL_MAX],
    betweenResults: [GOOGLE_BETWEEN_RESULTS_MIN, GOOGLE_BETWEEN_RESULTS_MAX],
    betweenPageVisits: [GOOGLE_BETWEEN_PAGE_VISITS_MIN, GOOGLE_BETWEEN_PAGE_VISITS_MAX],
    final: [GOOGLE_FINAL_MIN, GOOGLE_FINAL_MAX]
  };
  const [min, max] = map[key] || [1000, 2000];
  return sleep(randomMs(min, max));
}

function linkedinDelay(key) {
  const map = {
    afterNav: [LINKEDIN_AFTER_NAV_MIN, LINKEDIN_AFTER_NAV_MAX],
    scrollShort: [LINKEDIN_SCROLL_SHORT_MIN, LINKEDIN_SCROLL_SHORT_MAX],
    scrollMed: [LINKEDIN_SCROLL_MED_MIN, LINKEDIN_SCROLL_MED_MAX],
    betweenProfiles: [LINKEDIN_PROFILE_MIN, LINKEDIN_PROFILE_MAX],
    final: [LINKEDIN_FINAL_MIN, LINKEDIN_FINAL_MAX]
  };
  const [min, max] = map[key] || [500, 1000];
  return sleep(randomMs(min, max));
}

function mapsDelay(key) {
  const map = {
    pageStability: [MAPS_PAGE_STABILITY_MIN, MAPS_PAGE_STABILITY_MAX],
    tilesLoad: [MAPS_TILES_LOAD_MIN, MAPS_TILES_LOAD_MAX],
    scrollMore: [MAPS_SCROLL_MORE_MIN, MAPS_SCROLL_MORE_MAX],
    betweenEnrich: [MAPS_BETWEEN_ENRICH_MIN, MAPS_BETWEEN_ENRICH_MAX],
    betweenVisits: [MAPS_BETWEEN_VISITS_MIN, MAPS_BETWEEN_VISITS_MAX],
    final: [MAPS_FINAL_MIN, MAPS_FINAL_MAX]
  };
  const [min, max] = map[key] || [500, 1000];
  return sleep(randomMs(min, max));
}

function websiteDelay(key) {
  const map = {
    init: [WEBSITE_INIT_MIN, WEBSITE_INIT_MAX],
    betweenPages: [WEBSITE_BETWEEN_PAGES_MIN, WEBSITE_BETWEEN_PAGES_MAX],
    betweenSites: [WEBSITE_BETWEEN_SITES_MIN, WEBSITE_BETWEEN_SITES_MAX],
    final: [WEBSITE_FINAL_MIN, WEBSITE_FINAL_MAX]
  };
  const [min, max] = map[key] || [500, 1000];
  return sleep(randomMs(min, max));
}

module.exports = {
  BETWEEN_JOBS_MS,
  googleDelay,
  linkedinDelay,
  mapsDelay,
  websiteDelay,
  randomMs,
  sleep
};
