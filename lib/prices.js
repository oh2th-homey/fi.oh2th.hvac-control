'use strict';

/**
 * Pure price logic: parse imported day arrays, map slots to real time (DST safe, any time zone),
 * day statistics and the expensive-now decision for each price model.
 * No Homey dependencies; reasons are returned as { code, args } and translated by the caller.
 */

const { localDate, addDays, midnight } = require('oh2th-homey-helpers');

const MODELS = ['rate_is_highest', 'above_average', 'off'];
const RESOLUTIONS = [15, 60];

// Minimum gap above the window median (rate is highest) or the day average (above average), €/kWh.
// Smaller peaks save nothing worth a setpoint write: the heat is only shifted by a quarter.
const DEFAULT_MIN_DELTA = 0.01;

/**
 * @description Start, end and number of price slots of a local day (92/96/100 quarters or 23/24/25 hours on DST days).
 * @returns {Object} { start, end, slots }
 */
function dayInfo(timeZone, date, resolution) {
  const start = midnight(timeZone, date);
  const end = midnight(timeZone, addDays(date, 1));
  return { start, end, slots: Math.round((end - start) / (resolution * 60000)) };
}

/**
 * @description Parse an imported price token: JSON string (single quotes tolerated), array, or object with keys "0"…"n".
 * Empty input (null, '', []) gives an empty array (day unknown).
 * @returns {Object} { values } or { error: 'not_json' | 'not_array' | 'not_numeric' }
 */
function parsePrices(input) {
  let data = input;
  if (data === null || data === undefined) return { values: [] };
  if (typeof data === 'string') {
    const text = data.trim();
    if (text === '') return { values: [] };
    try {
      data = JSON.parse(text);
    } catch (error) {
      try {
        data = JSON.parse(text.replace(/'/g, '"'));
      } catch (error2) {
        return { error: 'not_json' };
      }
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (!keys.every((key) => /^\d+$/.test(key))) return { error: 'not_array' };
    const indexes = keys.map(Number).sort((a, b) => a - b);
    if (indexes.some((index, i) => index !== i)) return { error: 'not_array' };
    data = indexes.map((index) => data[String(index)]);
  }
  if (!Array.isArray(data)) return { error: 'not_array' };
  const values = data.map((value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value));
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return { error: 'not_numeric' };
  return { values };
}

/**
 * @description Resolution of an imported day from its number of values: a full hourly day (23–25 values) is 60,
 * anything else 15. A partial day (tomorrow) keeps the known resolution of today when it fits.
 * @param {number} count - Number of values
 * @param {string} timeZone
 * @param {string} date - 'YYYY-MM-DD' of the imported day
 * @param {number|null} known - Resolution of today's stored prices, for a partial tomorrow; null for today
 * @returns {number} 15 or 60
 */
function detectResolution(count, timeZone, date, known = null) {
  const hours = dayInfo(timeZone, date, 60).slots;
  if (known && count <= dayInfo(timeZone, date, known).slots) return known;
  return count === hours ? 60 : 15;
}

/**
 * @description Check an imported day against the expected slot count.
 * Today must be a full day; tomorrow may be empty (unknown) or a prefix from midnight (partial).
 * @param {number[]} values - Parsed prices
 * @param {number} slots - Slots of that local day at its resolution
 * @param {string} day - 'today' or 'tomorrow'
 * @returns {Object} { ok: true, partial } or { ok: false, error, args }
 */
function checkDay(values, slots, day) {
  const count = values.length;
  if (count === slots) return { ok: true, partial: false };
  if (count > slots) return { ok: false, error: 'too_many', args: { count, slots } };
  if (day === 'today') return { ok: false, error: 'today_incomplete', args: { count, slots } };
  return { ok: true, partial: true };
}

/**
 * @description Merge an import into the stored day: the longer array wins, an empty import changes nothing.
 * @returns {Object|null} The day entry to store, or null to keep the stored one
 */
function mergeDay(stored, values, resolution, importedAt) {
  if (values.length === 0) return null;
  if (stored && stored.resolution === resolution && stored.values.length > values.length) return null;
  return { resolution, values, importedAt };
}

/**
 * @description Drop stored days older than yesterday.
 */
function pruneDays(days, today) {
  const yesterday = addDays(today, -1);
  return Object.fromEntries(Object.entries(days || {}).filter(([date]) => date >= yesterday));
}

/**
 * @description Min, max, mean and median of the known values.
 * @returns {Object|null} { min, max, mean, median, count }, null when nothing is known
 */
function dayStats(values) {
  const known = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (known.length === 0) return null;
  return {
    min: Math.min(...known),
    max: Math.max(...known),
    mean: known.reduce((sum, value) => sum + value, 0) / known.length,
    median: percentile(known, 0.5),
    count: known.length
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * @description Yesterday, today and tomorrow as one slot timeline around now. Unknown slots are null.
 * Days stored with another resolution than the current setting count as unknown.
 * @returns {Object} { prices, index, today: { start, end, slots, values }, until }
 *   index = slot of now in prices; until = end of the last known slot (ms) or null
 */
function timeline(days, timeZone, now, resolution) {
  const today = localDate(timeZone, now);
  const dates = [addDays(today, -1), today, addDays(today, 1)];
  const slotMs = resolution * 60000;
  const prices = [];
  let index = 0;
  let until = null;
  let todayInfo = null;
  for (const date of dates) {
    const info = dayInfo(timeZone, date, resolution);
    const entry = days && days[date];
    const values = entry && entry.resolution === resolution ? entry.values : [];
    if (date === today) {
      index = prices.length + Math.floor((now - info.start) / slotMs);
      todayInfo = { ...info, values };
    }
    for (let i = 0; i < info.slots; i++) {
      const value = i < values.length ? values[i] : null;
      prices.push(value);
      if (value !== null) until = info.start + (i + 1) * slotMs;
    }
  }
  return { prices, index, today: todayInfo, until };
}

/**
 * @description Rate is highest: the current quarter is a short local peak (one or two quarters at or above the threshold).
 * Port of the author's rate-isHighest-of-the-hour HomeyScript; the window may cross midnight when known. Unlike the
 * script, the run of high quarters is counted across clock hours, so a flat stretch crossing an hour is not a peak.
 * @param {Array<number|null>} prices - Slot timeline (15 min)
 * @param {number} index - Current slot in prices
 * @param {number} minDelta - Minimum gap above the window median
 * @returns {Object} { expensive, threshold }
 */
function rateIsHighest(prices, index, minDelta = DEFAULT_MIN_DELTA) {
  const current = prices[index];
  const window = [];
  for (let offset = -4; offset <= 7; offset++) {
    const value = prices[index + offset];
    if (typeof value === 'number') window.push(value);
  }
  if (typeof current !== 'number' || window.length === 0) return { expensive: false, threshold: null };

  const median = percentile(window, 0.5);
  const upperQuartile = percentile(window, 0.75);
  const spread = Math.max(...window) - Math.min(...window);
  const threshold = Math.max(upperQuartile, median + Math.max(spread * 0.1, minDelta));

  if (current < threshold) return { expensive: false, threshold };
  const high = (i) => typeof prices[i] === 'number' && prices[i] >= threshold;
  let block = 1;
  for (let i = index - 1; high(i) && block <= 2; i--) block++;
  for (let i = index + 1; high(i) && block <= 2; i++) block++;

  return { expensive: block <= 2, threshold };
}

/**
 * @description Above average: price > average × (1 + pct / 100) and at least minDelta above the average.
 * @returns {Object} { expensive, threshold }
 */
function aboveAverage(price, average, pct, minDelta = DEFAULT_MIN_DELTA) {
  const threshold = Math.max(average * (1 + pct / 100), average + minDelta);
  return { expensive: price > threshold, threshold };
}

/**
 * @description Decide whether the current slot is expensive.
 * @param {Object} opts
 * @param {Object} opts.days - Stored days { 'YYYY-MM-DD': { resolution, values } }
 * @param {string} opts.timeZone - Homey time zone
 * @param {number} opts.now - Instant (ms)
 * @param {number} opts.resolution - 15 or 60
 * @param {string} opts.model - 'rate_is_highest' | 'above_average' | 'off'
 * @param {number} opts.pct - Above average percentage
 * @param {number} opts.minDelta - Minimum delta €/kWh
 * @returns {Object} { price, expensive, model, stats, until, reasons: [{ code, args }] }
 */
function evaluate({ days, timeZone, now, resolution = 15, model = 'rate_is_highest', pct = 30, minDelta = DEFAULT_MIN_DELTA }) {
  const t = timeline(days, timeZone, now, resolution);
  const price = t.prices[t.index];
  const stats = dayStats(t.today.values);
  const reasons = [];
  const result = { price: typeof price === 'number' ? price : null, expensive: false, model, stats, until: t.until, reasons };

  if (model === 'off') {
    reasons.push({ code: 'off', args: {} });
    return result;
  }
  if (result.price === null) {
    reasons.push({ code: 'unknown', args: {} });
    return result;
  }

  let effective = model;
  if (model === 'rate_is_highest' && resolution !== 15) {
    effective = 'above_average';
    reasons.push({ code: 'hourly_fallback', args: {} });
  }
  result.model = effective;

  if (effective === 'rate_is_highest') {
    const { expensive, threshold } = rateIsHighest(t.prices, t.index, minDelta);
    result.expensive = expensive;
    reasons.push({ code: expensive ? 'peak' : 'not_peak', args: { price, threshold } });
    return result;
  }

  const { expensive, threshold } = aboveAverage(price, stats.mean, pct, minDelta);
  result.expensive = expensive;
  reasons.push({ code: expensive ? 'above_average' : 'not_above_average', args: { price, average: stats.mean, pct, threshold } });
  return result;
}

module.exports = {
  MODELS,
  RESOLUTIONS,
  DEFAULT_MIN_DELTA,
  dayInfo,
  detectResolution,
  parsePrices,
  checkDay,
  mergeDay,
  pruneDays,
  dayStats,
  percentile,
  timeline,
  rateIsHighest,
  aboveAverage,
  evaluate
};
