'use strict';

/**
 * Pure zone decision: from the shared facts (occupancy, season, mode, price) and the zone's own
 * setpoints and mode, decide what the zone aims at now. No Homey dependencies; reasons are
 * returned as { code, args } and translated by the caller.
 */

const ZONE_MODES = ['auto', 'manual', 'off'];
const SHARED_MAX_AGE_MS = 60 * 60 * 1000;

const FALLBACK_SHARED = { occupancy: 'present', season: 'heating', masterMode: 'auto', expensive: false };

/**
 * @description Shared state to use: the controller's when fresh, the last known for up to 1 h, then present without price control.
 * @param {Object|null} live - State from the controller now, null when missing or unavailable
 * @param {Object|null} last - Last known state { ...state, at }
 * @param {number} now - ms
 * @returns {Object} { shared, source: 'live' | 'last' | 'fallback' }
 */
function sharedState(live, last, now) {
  if (live) return { shared: live, source: 'live' };
  if (last && now - last.at <= SHARED_MAX_AGE_MS) return { shared: last, source: 'last' };
  // Safety over savings: keep the last known season, never fall back to eco.
  return { shared: { ...FALLBACK_SHARED, season: last && last.season ? last.season : FALLBACK_SHARED.season }, source: 'fallback' };
}

/**
 * @description Decide the zone's aim now.
 * @param {Object} opts
 * @param {Object} opts.shared - { occupancy, season, masterMode, expensive }
 * @param {string} opts.source - 'live' | 'last' | 'fallback' (from sharedState)
 * @param {Object} opts.zone - { mode, boostUntil (null when boost is off), heat, cool, setback, frostFloor, boostDelta, occupancyRule }
 * @param {number|null} opts.temperature - Zone temperature, null when unknown
 * @param {number} opts.now - ms
 * @returns {Object} { action, aim, target, band, season, eco, priceDriven, reasons }
 *   action: 'heat' | 'cool' | 'frost' | 'none'; aim: 'comfort' | 'eco' | 'boost' | 'frost' | 'manual';
 *   band: { low, high } of the season, target: °C (null for 'none')
 */
function decide({ shared, source = 'live', zone, temperature = null, now }) {
  const reasons = [];
  if (source === 'last') reasons.push({ code: 'controller_last', args: {} });
  if (source === 'fallback') reasons.push({ code: 'controller_fallback', args: {} });

  const cooling = shared.season === 'cooling';
  const band = cooling ? { low: zone.cool, high: zone.cool + zone.setback } : { low: zone.heat - zone.setback, high: zone.heat };
  const result = { action: 'none', aim: 'manual', target: null, band, season: shared.season, eco: false, priceDriven: false, reasons };

  if (zone.mode === 'manual') {
    if (typeof temperature === 'number' && temperature < zone.frostFloor) {
      reasons.push({ code: 'frost_watchdog', args: { temperature, frost: zone.frostFloor } });
      return { ...result, action: 'frost', aim: 'frost', target: zone.frostFloor };
    }
    reasons.push({ code: 'manual', args: {} });
    return result;
  }

  const frost = { ...result, action: 'frost', aim: 'frost', target: zone.frostFloor };
  if (zone.mode === 'off') {
    reasons.push({ code: 'zone_off', args: { frost: zone.frostFloor } });
    return frost;
  }
  if (shared.masterMode === 'off') {
    reasons.push({ code: 'master_off', args: { frost: zone.frostFloor } });
    return frost;
  }
  if (shared.masterMode === 'long_absence') {
    reasons.push({ code: 'long_absence', args: { frost: zone.frostFloor } });
    return frost;
  }
  if (shared.season === 'off') {
    reasons.push({ code: 'season_off', args: { frost: zone.frostFloor } });
    return frost;
  }

  const action = cooling ? 'cool' : 'heat';
  const comfort = cooling ? zone.cool : zone.heat;
  const ecoTarget = cooling ? zone.cool + zone.setback : zone.heat - zone.setback;

  if (zone.boostUntil && now < zone.boostUntil) {
    const target = cooling ? comfort : comfort + zone.boostDelta;
    reasons.push({ code: 'boost', args: { target, until: zone.boostUntil } });
    return { ...result, action, aim: 'boost', target: cooling ? target : Math.max(target, zone.frostFloor) };
  }

  let eco = false;
  let priceDriven = false;
  if (zone.occupancyRule === 'always_eco') {
    eco = true;
    reasons.push({ code: 'always_eco', args: {} });
  } else if (shared.occupancy === 'away') {
    eco = true;
    reasons.push({ code: 'away', args: {} });
  } else {
    reasons.push({ code: shared.occupancy === 'coming_home' ? 'coming_home' : 'present', args: {} });
    priceDriven = true;
    if (shared.expensive) {
      eco = true;
      reasons.push({ code: 'expensive', args: {} });
    }
  }
  if (eco && zone.setback === 0) reasons.push({ code: 'setback_zero', args: {} });

  let target = eco ? ecoTarget : comfort;
  if (!cooling) target = Math.max(target, zone.frostFloor);
  return { ...result, action, aim: eco ? 'eco' : 'comfort', target, eco, priceDriven };
}

module.exports = {
  ZONE_MODES,
  SHARED_MAX_AGE_MS,
  sharedState,
  decide
};
