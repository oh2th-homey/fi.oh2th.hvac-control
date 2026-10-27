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
 * @param {Object} opts.zone - { mode, boostUntil (null when boost is off), heat, cool, hasCooling, setback, boostDelta, occupancyRule, lowAlarm, windowOpen }
 * @param {number|null} opts.temperature - Zone temperature, null when unknown
 * @param {number} opts.now - ms
 * @returns {Object} { action, aim, target, band, season, eco, priceDriven, lowTemperature, reasons }
 *   action: 'heat' | 'cool' | 'off' | 'none'; aim: 'comfort' | 'eco' | 'boost' | 'off' | 'manual';
 *   band: { low, high } of the season, target: °C (null for 'off' and 'none')
 */
function decide({ shared, source = 'live', zone, temperature = null, now }) {
  const reasons = [];
  if (source === 'last') reasons.push({ code: 'controller_last', args: {} });
  if (source === 'fallback') reasons.push({ code: 'controller_fallback', args: {} });

  // Low temperature alarm only, the app does not heat for it. 0 turns it off.
  const lowTemperature = typeof temperature === 'number' && zone.lowAlarm > 0 && temperature < zone.lowAlarm;
  if (lowTemperature) reasons.push({ code: 'low_temperature', args: { temperature, limit: zone.lowAlarm } });

  const cooling = shared.season === 'cooling';
  const band = cooling ? { low: zone.cool, high: zone.cool + zone.setback } : { low: zone.heat - zone.setback, high: zone.heat };
  const result = { action: 'none', aim: 'manual', target: null, band, season: shared.season, eco: false, priceDriven: false, lowTemperature, reasons };

  if (zone.mode === 'manual') {
    reasons.push({ code: 'manual', args: {} });
    return result;
  }

  const off = { ...result, action: 'off', aim: 'off' };
  if (zone.mode === 'off') {
    reasons.push({ code: 'zone_off', args: {} });
    return off;
  }
  if (shared.masterMode === 'off') {
    reasons.push({ code: 'master_off', args: {} });
    return off;
  }
  if (shared.season === 'off') {
    reasons.push({ code: 'season_off', args: {} });
    return off;
  }
  if (cooling && zone.hasCooling === false) {
    reasons.push({ code: 'no_cooling', args: {} });
    return off;
  }

  const action = cooling ? 'cool' : 'heat';
  const comfort = cooling ? zone.cool : zone.heat;
  const ecoTarget = cooling ? zone.cool + zone.setback : zone.heat - zone.setback;

  // An open door or window (open longer than the zone's delay) overrides boost and comfort.
  if (zone.windowOpen) {
    reasons.push({ code: 'window_open', args: {} });
    return { ...result, action, aim: 'eco', target: ecoTarget, eco: true };
  }

  if (zone.boostUntil && now < zone.boostUntil) {
    const target = cooling ? comfort : comfort + zone.boostDelta;
    reasons.push({ code: 'boost', args: { target, until: zone.boostUntil } });
    return { ...result, action, aim: 'boost', target };
  }

  if (shared.masterMode === 'long_absence') {
    if (cooling) {
      reasons.push({ code: 'long_absence_cooling', args: {} });
      return off;
    }
    reasons.push({ code: 'long_absence', args: {} });
    return { ...result, action, aim: 'eco', target: ecoTarget, eco: true };
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

  return { ...result, action, aim: eco ? 'eco' : 'comfort', target: eco ? ecoTarget : comfort, eco, priceDriven };
}

module.exports = {
  ZONE_MODES,
  SHARED_MAX_AGE_MS,
  sharedState,
  decide
};
