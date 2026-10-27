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
 * @description Heating allowed by the zone's outdoor limit: on at or below onBelow, off at or above offAbove, and in
 * between the previous state (dead band). Unknown outdoor temperature keeps the previous state, heating when none.
 * @returns {boolean}
 */
function outdoorAllowed(limit, outdoor, previous) {
  if (!limit || !limit.enabled) return true;
  if (typeof outdoor !== 'number') return previous === undefined || previous === null ? true : previous;
  if (outdoor <= limit.onBelow) return true;
  if (outdoor >= limit.offAbove) return false;
  return previous === undefined || previous === null ? false : previous;
}

/**
 * @description Decide the zone's aim now.
 * @param {Object} opts
 * @param {Object} opts.shared - { occupancy, season, masterMode, expensive, outdoor }
 * @param {string} opts.source - 'live' | 'last' | 'fallback' (from sharedState)
 * @param {Object} opts.zone - { mode, boostUntil (null when boost is off), heat, cool, hasCooling, setback, boostDelta,
 *   occupancyRule ('follows' | 'always_eco' | 'always_comfort'), lowAlarm, windowOpen, heatAllYear,
 *   priceUse ('both' | 'heating' | 'cooling' | 'never'), priceAction ('eco' | 'off'),
 *   outdoorLimit { enabled, onBelow, offAbove }, outdoorAllowed (previous state) }
 * @param {number|null} opts.temperature - Zone temperature, null when unknown
 * @param {number} opts.now - ms
 * @returns {Object} { action, aim, target, band, season, eco, priceDriven, lowTemperature, offCause, outdoorAllowed, reasons }
 *   action: 'heat' | 'cool' | 'off' | 'none'; aim: 'comfort' | 'eco' | 'boost' | 'off' | 'manual';
 *   band: { low, high } of the season, target: °C (null for 'off' and 'none'); offCause: reason code of an off result
 */
function decide({ shared, source = 'live', zone, temperature = null, now }) {
  const reasons = [];
  if (source === 'last') reasons.push({ code: 'controller_last', args: {} });
  if (source === 'fallback') reasons.push({ code: 'controller_fallback', args: {} });

  // Low temperature alarm only, the app does not heat for it. 0 turns it off.
  const lowTemperature = typeof temperature === 'number' && zone.lowAlarm > 0 && temperature < zone.lowAlarm;
  if (lowTemperature) reasons.push({ code: 'low_temperature', args: { temperature, limit: zone.lowAlarm } });

  // Heat all year: the zone stays in the heating season when the house is cooling or off.
  const season = zone.heatAllYear ? 'heating' : shared.season;
  const cooling = season === 'cooling';
  const band = cooling ? { low: zone.cool, high: zone.cool + zone.setback } : { low: zone.heat - zone.setback, high: zone.heat };
  const allowed = outdoorAllowed(zone.outdoorLimit, shared.outdoor, zone.outdoorAllowed);
  const result = { action: 'none', aim: 'manual', target: null, band, season, eco: false, priceDriven: false, lowTemperature, offCause: null, outdoorAllowed: allowed, reasons };

  if (zone.mode === 'manual') {
    reasons.push({ code: 'manual', args: {} });
    return result;
  }

  const off = (code, args = {}) => {
    reasons.push({ code, args });
    return { ...result, action: 'off', aim: 'off', offCause: code };
  };
  if (zone.mode === 'off') return off('zone_off');
  if (shared.masterMode === 'off') return off('master_off');
  if (season === 'off') return off('season_off');
  if (cooling && zone.hasCooling === false) return off('no_cooling');
  if (!cooling && !allowed) return off('outdoor_warm', { outdoor: shared.outdoor, limit: zone.outdoorLimit.onBelow });

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
    if (cooling) return off('long_absence_cooling');
    reasons.push({ code: 'long_absence', args: {} });
    return { ...result, action, aim: 'eco', target: ecoTarget, eco: true };
  }

  let eco = false;
  let priceDriven = false;
  if (zone.occupancyRule === 'always_eco') {
    eco = true;
    reasons.push({ code: 'always_eco', args: {} });
  } else if (zone.occupancyRule !== 'always_comfort' && shared.occupancy === 'away') {
    eco = true;
    reasons.push({ code: 'away', args: {} });
  } else {
    let code = shared.occupancy === 'coming_home' ? 'coming_home' : 'present';
    if (zone.occupancyRule === 'always_comfort') code = 'always_comfort';
    reasons.push({ code, args: {} });
    priceDriven = true;
    // Price use per zone: both seasons (default), one season only, or never.
    const priceUse = zone.priceUse || 'both';
    const usesPrice = priceUse === 'both' || priceUse === (cooling ? 'cooling' : 'heating');
    if (shared.expensive && usesPrice) {
      if (zone.priceAction === 'off') return { ...off('expensive_off'), priceDriven: true };
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
  outdoorAllowed,
  decide
};
