'use strict';

/**
 * Pure member write pipeline:
 * zone decision → round to step (toward the inside of the band) → clamp to member limits → validate,
 * plus anti-flapping, report classification and the on/off relay rule.
 * No Homey dependencies; reasons are returned as { code, args } and translated by the caller.
 */

const EPS = 1e-6;
const MIN_RELAY_BAND = 0.2;

// Default relay band: on 0.3 °C below the target, off 0.3 °C above it.
const RELAY_ON_BELOW = 0.3;
const RELAY_OFF_AT = 0.3;

function decimals(step) {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

/**
 * @description Snap to the step grid with fixed precision: 21 not 21.000000001; step 1 gives a true integer.
 */
function clean(value, step) {
  return Number((Math.round(value / step) * step).toFixed(decimals(step)));
}

function stepUp(value, step) {
  return clean(Math.ceil(value / step - EPS) * step, step);
}

function stepDown(value, step) {
  return clean(Math.floor(value / step + EPS) * step, step);
}

/**
 * @description What one thermostat or A/C member should do for the zone decision.
 * Off: A/C mode off; thermostats are switched off when they have onoff, else get their own lowest setpoint.
 * Thermostats are heating devices, so in cooling they are off too; when heating, a thermostat with onoff is switched on.
 * A/C: heat/cool by action; eco "fan" when chosen and the device offers it.
 * @param {Object} decision - From zone.decide
 * @param {Object} member - { control, ecoMode, seasonOffMode, modes, min, offSwitch ('thermostat_mode' | 'onoff' | 'system_mode' | null) }
 * @returns {Object} { skip } or { mode: string|null, power: boolean|null, decision: Object|null, reasons }
 */
// Long absence with an A/C set to eco fan: fan only while the room is this much above eco, heat again at eco.
const LONG_ABSENCE_FAN_ABOVE = 1;

/**
 * @param {Object} [room] - { temperature (zone °C or null), lastMode (mode last written to this member) }
 */
function memberPlan(decision, member, room = {}) {
  if (decision.action === 'none') return { skip: true };

  if (member.control !== 'ac') {
    const reasons = decision.action === 'cool' ? [{ code: 'heating_device_cooling', args: {} }] : [];
    // Off with the device's own switch (thermostat_mode, onoff or system_mode), never by lowering the setpoint.
    const onoff = member.offSwitch === 'onoff';
    const modeCap = member.offSwitch && !onoff ? member.offSwitch : null;
    if (decision.action === 'off' || decision.action === 'cool') {
      if (onoff) return { mode: null, power: false, decision: null, reasons };
      if (modeCap) return { mode: 'off', modeCap, power: null, decision: null, reasons };
      return { mode: null, power: null, decision: null, reasons: [...reasons, { code: 'no_off_switch', args: {} }] };
    }
    return { mode: modeCap ? 'heat' : null, modeCap, power: onoff ? true : null, decision, reasons };
  }

  if (decision.action === 'off') {
    // Season off: fan instead of off when chosen for this unit and it has a fan mode.
    const fan = decision.offCause === 'season_off' && member.seasonOffMode === 'fan' && (member.modes || []).includes('fan');
    return { mode: fan ? 'fan' : 'off', power: null, decision: null, reasons: fan ? [{ code: 'fan', args: {} }] : [] };
  }
  if (decision.eco && member.ecoMode === 'fan' && (member.modes || []).includes('fan')) {
    if (!decision.longAbsence) return { mode: 'fan', power: null, decision: null, reasons: [{ code: 'fan', args: {} }] };
    // Long absence: the unit may be the main heat source, so it heats at eco and runs fan only while the room is warm.
    const { temperature, lastMode } = room;
    const known = typeof temperature === 'number';
    const warm = known && (temperature >= decision.target + LONG_ABSENCE_FAN_ABOVE || (lastMode === 'fan' && temperature > decision.target));
    if (warm) return { mode: 'fan', power: null, decision: null, reasons: [{ code: 'fan_warm', args: {} }] };
  }
  return { mode: decision.action, power: null, decision, reasons: [] };
}

/**
 * @description Setpoint for one thermostat member.
 * @param {Object} decision - From zone.decide: { action, aim, target, band }
 * @param {Object} member - { min, max, step }
 * @returns {Object} { value, raw, reasons } — value null when nothing valid can be written
 */
function setpoint(decision, member) {
  const { min, max, step } = member;
  const reasons = [];
  const heating = decision.action !== 'cool';
  const raw = decision.target;
  let value;

  if (decision.aim === 'comfort' || decision.aim === 'eco') {
    const { low, high } = decision.band;
    const lowIn = stepUp(low, step);
    const highIn = stepDown(high, step);
    if (lowIn <= highIn + EPS) {
      // Round toward the inside of the band: down from the top end, up from the bottom end.
      const atTop = raw >= (low + high) / 2;
      value = Math.min(Math.max(atTop ? stepDown(raw, step) : stepUp(raw, step), lowIn), highIn);
    } else {
      // No step value fits the band: protect comfort.
      value = heating ? stepUp(high, step) : stepDown(low, step);
      reasons.push({ code: 'no_step_in_band', args: { step } });
    }
  } else {
    // Off and boost: round up when heating, down when cooling.
    value = heating ? stepUp(raw, step) : stepDown(raw, step);
  }

  const minIn = stepUp(min, step);
  const maxIn = stepDown(max, step);
  if (value < minIn) {
    reasons.push({ code: 'clamped_min', args: { value, min: minIn } });
    value = minIn;
  } else if (value > maxIn) {
    reasons.push({ code: 'clamped_max', args: { value, max: maxIn } });
    value = maxIn;
  }
  value = clean(value, step);

  if (!valid(value, member)) return { value: null, raw, reasons: [...reasons, { code: 'invalid', args: { value } }] };
  return { value, raw, reasons };
}

/**
 * @description Never write NaN, null, strings or out-of-range values.
 */
function valid(value, member) {
  return typeof value === 'number' && Number.isFinite(value) && value >= member.min - EPS && value <= member.max + EPS;
}

/**
 * @description Hysteresis: keep the last written value when the new one is one step away and the unrounded target
 * has not passed the midpoint between them by the margin.
 */
function keepWritten(raw, value, lastWritten, step, margin) {
  if (typeof lastWritten !== 'number' || value === lastWritten) return false;
  if (Math.abs(value - lastWritten) > step + EPS) return false;
  return Math.abs(raw - lastWritten) < step / 2 + margin;
}

/**
 * @description Classify a reported setpoint against the last written one, in this order:
 * fault value or outside the device limits → 'fault'; equal → 'ok'; a fractional value written and a whole degree within
 * 0.5 reported → 'whole_degree' (the device only takes whole degrees); within half a step → 'rounding'; else 'hand'.
 * @returns {string} 'unknown' | 'fault' | 'ok' | 'whole_degree' | 'rounding' | 'hand'
 */
function classifyReport(reported, written, member) {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) return 'unknown';
  const { faultValue, min, max, step } = member;
  if (typeof faultValue === 'number' && Math.abs(reported - faultValue) < 0.01 && Math.abs(written - faultValue) >= 0.01) return 'fault';
  if (reported < min - EPS || reported > max + EPS) return 'fault';
  if (typeof written !== 'number') return 'hand';
  if (Math.abs(reported - written) < EPS) return 'ok';
  if (!Number.isInteger(written) && Number.isInteger(reported) && Math.abs(reported - written) <= 0.5 + EPS) return 'whole_degree';
  if (Math.abs(reported - written) <= step / 2 + EPS) return 'rounding';
  return 'hand';
}

/**
 * @description On/off relay with a band around the target and minimum on/off times.
 * Heating: on at or below target − onBelow, off at or above target + offAt (offAt may be negative: off below the
 * target, for extra heat that only helps the main heating). In between the relay keeps its state.
 * Mode 'enable': an enable switch for a device with its own thermostat (e.g. floor heating): on while the zone
 * heats at comfort or boost, off in eco and otherwise; no room temperature needed.
 * @param {Object} opts - { on, temperature, target, eco, heating, mode, onBelow, offAt, minOnMs, minOffMs, lastSwitchAt, now }
 * @returns {Object} { on, reason: { code, args } }
 */
function relay({ on, temperature, target, eco = false, heating = true, mode = 'thermostat', onBelow = RELAY_ON_BELOW, offAt = RELAY_OFF_AT, minOnMs = 0, minOffMs = 0, lastSwitchAt = 0, now }) {
  if (typeof target !== 'number') return { on: false, reason: { code: 'relay_no_target', args: {} } };
  if (mode !== 'enable' && typeof temperature !== 'number') return { on: false, reason: { code: 'relay_no_temperature', args: {} } };

  let want = on;
  if (mode === 'enable') want = !eco;
  else if (heating) {
    if (temperature <= target - onBelow) want = true;
    else if (temperature >= target + offAt) want = false;
  } else if (temperature >= target + onBelow) want = true;
  else if (temperature <= target - offAt) want = false;

  if (want !== on) {
    const elapsed = now - lastSwitchAt;
    if (on && elapsed < minOnMs) return { on, reason: { code: 'relay_min_on', args: {} } };
    if (!on && elapsed < minOffMs) return { on, reason: { code: 'relay_min_off', args: {} } };
  }
  return { on: want, reason: { code: want ? 'relay_on' : 'relay_off', args: { temperature, target } } };
}

/**
 * @description A relay band is valid when the off point lies above the on point (offAt > −onBelow).
 */
function validRelayBand(onBelow, offAt) {
  // At least MIN_RELAY_BAND between on and off, so a noisy sensor can't flip the relay back and forth.
  return Number.isFinite(onBelow) && Number.isFinite(offAt) && onBelow >= 0 && onBelow <= 5 && offAt >= -5 && offAt <= 5 && offAt + onBelow >= MIN_RELAY_BAND - EPS;
}

module.exports = {
  clean,
  memberPlan,
  stepUp,
  stepDown,
  setpoint,
  valid,
  keepWritten,
  classifyReport,
  relay,
  validRelayBand,
  RELAY_ON_BELOW,
  RELAY_OFF_AT
};
