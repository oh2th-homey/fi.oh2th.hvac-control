'use strict';

/**
 * Pure member write pipeline:
 * zone decision → round to step (toward the inside of the band) → clamp to member limits → validate,
 * plus anti-flapping, report classification and the on/off relay rule.
 * No Homey dependencies; reasons are returned as { code, args } and translated by the caller.
 */

const EPS = 1e-6;

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
 * Off: A/C mode off; thermostats get their own lowest setpoint. Thermostats are heating devices, so in cooling they
 * are off too. A/C: heat/cool by action; eco "fan" when chosen and the device offers it.
 * @param {Object} decision - From zone.decide
 * @param {Object} member - { control, ecoMode, modes, min }
 * @returns {Object} { skip } or { mode: string|null, decision: Object|null, reasons }
 */
function memberPlan(decision, member) {
  if (decision.action === 'none') return { skip: true };
  const off = { ...decision, action: 'off', aim: 'off', target: member.min };

  if (member.control !== 'ac') {
    if (decision.action === 'off') return { mode: null, decision: off, reasons: [] };
    if (decision.action === 'cool') return { mode: null, decision: off, reasons: [{ code: 'heating_device_cooling', args: {} }] };
    return { mode: null, decision, reasons: [] };
  }

  if (decision.action === 'off') return { mode: 'off', decision: null, reasons: [] };
  if (decision.eco && member.ecoMode === 'fan' && (member.modes || []).includes('fan')) return { mode: 'fan', decision: null, reasons: [] };
  return { mode: decision.action, decision, reasons: [] };
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
 * fault value or outside the device limits → 'fault'; equal → 'ok'; within half a step → 'rounding'; else 'hand'.
 * @returns {string} 'unknown' | 'fault' | 'ok' | 'rounding' | 'hand'
 */
function classifyReport(reported, written, member) {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) return 'unknown';
  const { faultValue, min, max, step } = member;
  if (typeof faultValue === 'number' && Math.abs(reported - faultValue) < 0.01 && Math.abs(written - faultValue) >= 0.01) return 'fault';
  if (reported < min - EPS || reported > max + EPS) return 'fault';
  if (typeof written !== 'number') return 'hand';
  if (Math.abs(reported - written) < EPS) return 'ok';
  if (Math.abs(reported - written) <= step / 2 + EPS) return 'rounding';
  return 'hand';
}

/**
 * @description On/off relay with hysteresis around the target and minimum on/off times.
 * @param {Object} opts - { on, temperature, target, heating, hysteresis, minOnMs, minOffMs, lastSwitchAt, now }
 * @returns {Object} { on, reason: { code, args } }
 */
function relay({ on, temperature, target, heating = true, hysteresis = 0.3, minOnMs = 0, minOffMs = 0, lastSwitchAt = 0, now }) {
  if (typeof target !== 'number') return { on: false, reason: { code: 'relay_no_target', args: {} } };
  if (typeof temperature !== 'number') return { on: false, reason: { code: 'relay_no_temperature', args: {} } };

  let want = on;
  if (heating) {
    if (temperature <= target - hysteresis) want = true;
    else if (temperature >= target + hysteresis) want = false;
  } else if (temperature >= target + hysteresis) want = true;
  else if (temperature <= target - hysteresis) want = false;

  if (want !== on) {
    const elapsed = now - lastSwitchAt;
    if (on && elapsed < minOnMs) return { on, reason: { code: 'relay_min_on', args: {} } };
    if (!on && elapsed < minOffMs) return { on, reason: { code: 'relay_min_off', args: {} } };
  }
  return { on: want, reason: { code: want ? 'relay_on' : 'relay_off', args: { temperature, target } } };
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
  relay
};
