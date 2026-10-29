'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const zone = require('../lib/zone');
const pipeline = require('../lib/pipeline');
const { offSwitch, isAirConditioner, temperatureCapabilities } = require('../lib/members');

const NOW = Date.UTC(2026, 10, 10, 12);
const ZONE = { mode: 'auto', boostUntil: null, heat: 21, eco: 19, cool: 24, ecoCool: 26, boostDelta: 1, occupancyRule: 'follows', lowAlarm: 5 };
const SHARED = { occupancy: 'present', season: 'heating', longAbsence: false, expensive: false };

function decide(shared = {}, z = {}, extra = {}) {
  return zone.decide({ shared: { ...SHARED, ...shared }, zone: { ...ZONE, ...z }, now: NOW, ...extra });
}

test('facts pick comfort or eco', () => {
  assert.deepStrictEqual([decide().aim, decide().target], ['comfort', 21]);
  assert.deepStrictEqual([decide({ occupancy: 'coming_home' }).aim, decide({ occupancy: 'coming_home' }).target], ['comfort', 21]);
  assert.deepStrictEqual([decide({ occupancy: 'away' }).aim, decide({ occupancy: 'away' }).target], ['eco', 19]);
  const expensive = decide({ expensive: true });
  assert.deepStrictEqual([expensive.aim, expensive.target, expensive.priceDriven], ['eco', 19, true]);
  assert.strictEqual(decide({ occupancy: 'away' }).priceDriven, false);
  assert.strictEqual(decide({}, { occupancyRule: 'always_eco' }).aim, 'eco');
});

test('cooling inverts the band', () => {
  const comfort = decide({ season: 'cooling' });
  assert.deepStrictEqual([comfort.action, comfort.target, comfort.band], ['cool', 24, { low: 24, high: 26 }]);
  assert.strictEqual(decide({ season: 'cooling', expensive: true }).target, 26);
});

test('off: zone off, master off, season off, cooling without cooling', () => {
  for (const [shared, z, code] of [
    [{}, { mode: 'off' }, 'zone_off'],
    [{ season: 'off' }, {}, 'season_off'],
    [{ season: 'cooling' }, { hasCooling: false, cool: null }, 'no_cooling'],
    [{ longAbsence: true, season: 'cooling' }, {}, 'long_absence_cooling']
  ]) {
    const d = decide(shared, z);
    assert.deepStrictEqual([d.action, d.target, d.reasons.at(-1).code], ['off', null, code]);
  }
});

test('long absence: eco like away, not price driven', () => {
  const d = decide({ longAbsence: true, expensive: true });
  assert.deepStrictEqual([d.action, d.aim, d.target, d.priceDriven, d.reasons.at(-1).code], ['heat', 'eco', 19, false, 'long_absence']);
});

test('no floor: eco is the eco setpoint, never warmer than comfort', () => {
  assert.strictEqual(decide({ occupancy: 'away' }, { heat: 9, eco: 5 }).target, 5);
  assert.strictEqual(decide({ occupancy: 'away' }, { heat: 20, eco: 22 }).target, 20);
  assert.strictEqual(decide({ occupancy: 'away', season: 'cooling' }, { cool: 24, ecoCool: 22 }).target, 24);
  assert.strictEqual(decide({ occupancy: 'away' }, { eco: null }).target, 21);
});

test('manual: hands off; low temperature alarm in every mode, no heating', () => {
  const warm = decide({}, { mode: 'manual' }, { temperature: 15 });
  assert.deepStrictEqual([warm.action, warm.lowTemperature], ['none', false]);
  const cold = decide({}, { mode: 'manual' }, { temperature: 4 });
  assert.deepStrictEqual([cold.action, cold.lowTemperature, cold.reasons[0].code], ['none', true, 'low_temperature']);
  assert.strictEqual(decide({}, { mode: 'off' }, { temperature: 4 }).lowTemperature, true);
  assert.strictEqual(decide({}, { lowAlarm: 0 }, { temperature: 1 }).lowTemperature, false);
});

test('window open: eco, overrides boost and comfort, not off or manual', () => {
  const open = decide({}, { windowOpen: true, boostUntil: NOW + 60000 });
  assert.deepStrictEqual([open.aim, open.target, open.eco, open.reasons.at(-1).code], ['eco', 19, true, 'window_open']);
  assert.strictEqual(decide({ season: 'cooling' }, { windowOpen: true }).target, 26);
  assert.strictEqual(decide({}, { windowOpen: true, mode: 'off' }).aim, 'off');
  assert.strictEqual(decide({}, { windowOpen: true, mode: 'manual' }).aim, 'manual');
});

test('heat all year: heating in the cooling and off seasons', () => {
  const summer = decide({ season: 'cooling' }, { heatAllYear: true });
  assert.deepStrictEqual([summer.action, summer.target, summer.season], ['heat', 21, 'heating']);
  assert.strictEqual(decide({ season: 'off' }, { heatAllYear: true }).action, 'heat');
});

test('outdoor limit: heat only when cold enough, dead band keeps the state', () => {
  const limit = { enabled: true, onBelow: -10, offAbove: -8 };
  assert.strictEqual(decide({ outdoor: -11 }, { outdoorLimit: limit }).action, 'heat');
  const warm = decide({ outdoor: -7 }, { outdoorLimit: limit, outdoorAllowed: true });
  assert.deepStrictEqual([warm.action, warm.offCause, warm.outdoorAllowed], ['off', 'outdoor_warm', false]);
  assert.strictEqual(decide({ outdoor: -9 }, { outdoorLimit: limit, outdoorAllowed: true }).action, 'heat');
  assert.strictEqual(decide({ outdoor: -9 }, { outdoorLimit: limit, outdoorAllowed: false }).action, 'off');
  assert.strictEqual(decide({ outdoor: null }, { outdoorLimit: limit }).action, 'heat');
  assert.strictEqual(decide({ outdoor: 5 }, { outdoorLimit: { ...limit, enabled: false } }).action, 'heat');
});

test('occupancy rule always comfort: comfort when away, price still applies', () => {
  assert.deepStrictEqual([decide({ occupancy: 'away' }, { occupancyRule: 'always_comfort' }).aim], ['comfort']);
  assert.strictEqual(decide({ occupancy: 'away', expensive: true }, { occupancyRule: 'always_comfort' }).aim, 'eco');
});

test('price use per zone and off when expensive', () => {
  assert.strictEqual(decide({ expensive: true, season: 'cooling' }).aim, 'eco');
  assert.strictEqual(decide({ expensive: true }, { pricePeak: 'ignore' }).aim, 'comfort');
  const offExpensive = decide({ expensive: true }, { pricePeak: 'off' });
  assert.deepStrictEqual([offExpensive.action, offExpensive.offCause, offExpensive.priceDriven], ['off', 'expensive_off', true]);
});

test('boost until a time, then normal; not in manual or off', () => {
  assert.strictEqual(decide({}, { mode: 'manual', boostUntil: NOW + 60000 }).aim, 'manual');
  assert.strictEqual(decide({}, { mode: 'off', boostUntil: NOW + 60000 }).aim, 'off');
  const boost = decide({ occupancy: 'away' }, { boostUntil: NOW + 60000 });
  assert.deepStrictEqual([boost.aim, boost.target], ['boost', 22]);
  assert.strictEqual(decide({ occupancy: 'away' }, { boostUntil: NOW - 1 }).aim, 'eco');
  assert.strictEqual(decide({ season: 'cooling' }, { boostUntil: NOW + 60000 }).target, 24);
});

test('controller missing: last known for 1 h, then present without price control', () => {
  const last = { ...SHARED, occupancy: 'away', season: 'cooling', at: NOW - 30 * 60000 };
  assert.strictEqual(zone.sharedState(null, last, NOW).source, 'last');
  const old = zone.sharedState(null, { ...last, at: NOW - 2 * 3600000 }, NOW);
  assert.deepStrictEqual([old.source, old.shared.occupancy, old.shared.expensive, old.shared.season], ['fallback', 'present', false, 'cooling']);
  assert.strictEqual(zone.sharedState(null, null, NOW).shared.season, 'heating');
});

test('setpoint rounds toward the inside of the band', () => {
  const step1 = { min: 5, max: 30, step: 1 };
  // Comfort 21.5 is the top of band [19.5, 21.5]: round down.
  assert.strictEqual(pipeline.setpoint(decide({}, { heat: 21.5 }), step1).value, 21);
  // Eco 19.5 is the bottom: round up.
  assert.strictEqual(pipeline.setpoint(decide({ occupancy: 'away' }, { heat: 21.5, eco: 19.5 }), step1).value, 20);
  // Cooling comfort 23.5 is the bottom of [23.5, 25.5]: round up.
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5, ecoCool: 25.5 }), step1).value, 24);
});

test('setpoint: no step in band protects comfort', () => {
  const step1 = { min: 5, max: 30, step: 1 };
  const heat = pipeline.setpoint(decide({}, { heat: 21.5, eco: 21.5 }), step1);
  assert.deepStrictEqual([heat.value, heat.reasons[0].code], [22, 'no_step_in_band']);
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5, ecoCool: 23.5 }), step1).value, 23);
});

test('setpoint: clean numbers, clamp', () => {
  const half = pipeline.setpoint(decide({}, { heat: 20.7 }), { min: 5, max: 30, step: 0.5 });
  assert.strictEqual(half.value, 20.5);
  const step1 = pipeline.setpoint(decide(), { min: 5, max: 30, step: 1 }).value;
  assert.ok(Number.isInteger(step1));
  assert.strictEqual(pipeline.setpoint(decide({}, {}), { min: 5, max: 30, step: 0.1 }).value, 21);
  const low = pipeline.setpoint(decide({}, { heat: 8, eco: 8 }), { min: 10, max: 30, step: 1 });
  assert.deepStrictEqual([low.value, low.reasons.at(-1).code], [10, 'clamped_min']);
  assert.strictEqual(pipeline.setpoint({ ...decide(), target: NaN }, { min: 5, max: 30, step: 1 }).value, null);
});

test('hysteresis keeps the last written value near the midpoint', () => {
  assert.strictEqual(pipeline.keepWritten(20.6, 21, 20, 1, 0.2), true);
  assert.strictEqual(pipeline.keepWritten(20.8, 21, 20, 1, 0.2), false);
  assert.strictEqual(pipeline.keepWritten(22.4, 22, 20, 1, 0.2), false);
});

test('report classification: fault, ok, rounding, hand', () => {
  const m = { faultValue: 4, min: 5, max: 30, step: 1 };
  assert.strictEqual(pipeline.classifyReport(4, 21, { ...m, min: 4 }), 'fault');
  assert.strictEqual(pipeline.classifyReport(3, 21, m), 'fault');
  assert.strictEqual(pipeline.classifyReport(21, 21, m), 'ok');
  assert.strictEqual(pipeline.classifyReport(20.5, 21, m), 'rounding');
  // Step 0.5 declared, the device only keeps whole degrees: 21.5 comes back as 22 or 21.
  const half = { ...m, step: 0.5 };
  assert.strictEqual(pipeline.classifyReport(22, 21.5, half), 'whole_degree');
  assert.strictEqual(pipeline.classifyReport(21, 21.5, half), 'whole_degree');
  assert.strictEqual(pipeline.classifyReport(21.2, 21.5, { ...m, step: 0.1 }), 'hand');
  assert.strictEqual(pipeline.classifyReport(23, 21.5, half), 'hand');
  assert.strictEqual(pipeline.classifyReport(23, 21, m), 'hand');
  assert.strictEqual(pipeline.classifyReport(null, 21, m), 'unknown');
});

test('relay: default band, min on/off, no temperature', () => {
  const base = { target: 21, now: NOW, lastSwitchAt: 0 };
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 20.7 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 20.9 }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 20.9 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 21.3 }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 21.4, minOnMs: 300000, lastSwitchAt: NOW - 60000 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: null }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 21.4, heating: false }).on, true);
});

test('relay band: asymmetric and extra heat below the target', () => {
  // WC: on 0.5 below, off 0.2 above.
  const wc = { target: 21, onBelow: 0.5, offAt: 0.2, now: NOW };
  assert.strictEqual(pipeline.relay({ ...wc, on: false, temperature: 20.6 }).on, false);
  assert.strictEqual(pipeline.relay({ ...wc, on: false, temperature: 20.5 }).on, true);
  assert.strictEqual(pipeline.relay({ ...wc, on: true, temperature: 21.1 }).on, true);
  assert.strictEqual(pipeline.relay({ ...wc, on: true, temperature: 21.2 }).on, false);
  // Bedroom extra heat: on 1.0 below, off 0.5 below the target.
  const bed = { target: 21, onBelow: 1, offAt: -0.5, now: NOW };
  assert.strictEqual(pipeline.relay({ ...bed, on: false, temperature: 20.2 }).on, false);
  assert.strictEqual(pipeline.relay({ ...bed, on: false, temperature: 20 }).on, true);
  assert.strictEqual(pipeline.relay({ ...bed, on: true, temperature: 20.4 }).on, true);
  assert.strictEqual(pipeline.relay({ ...bed, on: true, temperature: 20.5 }).on, false);
});

test('relay enable switch: on while the zone heats at comfort, off in eco, no temperature needed', () => {
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: true, temperature: null, target: 19, eco: true, now: NOW }).on, false);
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: false, temperature: null, target: 21, eco: false, now: NOW }).on, true);
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: false, temperature: null, target: 21, now: NOW }).on, true);
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: true, temperature: 25, target: 21, now: NOW }).on, true);
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: true, temperature: null, target: null, now: NOW }).on, false);
  assert.strictEqual(pipeline.relay({ mode: 'enable', on: false, target: 21, minOffMs: 300000, lastSwitchAt: NOW - 60000, now: NOW }).on, false);
});

test('relay band validation: off must be above on', () => {
  assert.strictEqual(pipeline.validRelayBand(0.3, 0.3), true);
  assert.strictEqual(pipeline.validRelayBand(1, -0.5), true);
  assert.strictEqual(pipeline.validRelayBand(0.5, -0.5), false);
  assert.strictEqual(pipeline.validRelayBand(-0.1, 0.3), false);
  assert.strictEqual(pipeline.validRelayBand(NaN, 0.3), false);
});

test('memberPlan: thermostat with onoff is switched on when heating, off otherwise', () => {
  const heater = { control: 'thermostat', min: 5, offSwitch: 'onoff' };
  const heat = pipeline.memberPlan(decide(), heater);
  assert.deepStrictEqual([heat.power, heat.decision.target], [true, 21]);
  const eco = pipeline.memberPlan(decide({ occupancy: 'away' }), heater);
  assert.deepStrictEqual([eco.power, eco.decision.target], [true, 19]);
  const off = pipeline.memberPlan(decide({}, { mode: 'off' }), heater);
  assert.deepStrictEqual([off.power, off.decision], [false, null]);
  const summer = pipeline.memberPlan(decide({ season: 'cooling' }), heater);
  assert.deepStrictEqual([summer.power, summer.decision, summer.reasons[0].code], [false, null, 'heating_device_cooling']);
  assert.strictEqual(pipeline.memberPlan(decide(), { control: 'thermostat', min: 5 }).power, null);
});

test('memberPlan: off, thermostat in cooling, A/C modes and fan eco', () => {
  const thermostat = { control: 'thermostat', min: 5 };
  const ac = { control: 'ac', ecoMode: 'fan', modes: ['heat', 'cool', 'off', 'fan'], min: 10 };
  assert.strictEqual(pipeline.memberPlan(decide({}, { mode: 'manual' }), thermostat).skip, true);
  // Never off by lowering the setpoint: onoff, else the mode capability, else left as is with a note.
  const noSwitch = pipeline.memberPlan(decide({}, { mode: 'off' }), thermostat);
  assert.deepStrictEqual([noSwitch.decision, noSwitch.mode, noSwitch.reasons.at(-1).code], [null, null, 'no_off_switch']);
  const z2m = { ...thermostat, offSwitch: 'system_mode' };
  const z2mOff = pipeline.memberPlan(decide({}, { mode: 'off' }), z2m);
  assert.deepStrictEqual([z2mOff.mode, z2mOff.modeCap, z2mOff.decision], ['off', 'system_mode', null]);
  const z2mHeat = pipeline.memberPlan(decide(), z2m);
  assert.deepStrictEqual([z2mHeat.mode, z2mHeat.modeCap, z2mHeat.decision.target], ['heat', 'system_mode', 21]);
  const byMode = pipeline.memberPlan(decide({}, { mode: 'off' }), { ...thermostat, offSwitch: 'thermostat_mode' });
  assert.deepStrictEqual([byMode.mode, byMode.modeCap, byMode.power], ['off', 'thermostat_mode', null]);
  const summer = pipeline.memberPlan(decide({ season: 'cooling' }), z2m);
  assert.deepStrictEqual([summer.mode, summer.decision, summer.reasons[0].code], ['off', null, 'heating_device_cooling']);
  assert.deepStrictEqual([pipeline.memberPlan(decide({}, { mode: 'off' }), ac).mode, pipeline.memberPlan(decide({}, { mode: 'off' }), ac).decision], ['off', null]);
  assert.strictEqual(pipeline.memberPlan(decide(), ac).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'cooling' }), ac).mode, 'cool');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), ac).mode, 'fan');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), { ...ac, modes: ['heat', 'cool', 'off'] }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ longAbsence: true }), { ...ac, ecoMode: 'setback' }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ longAbsence: true, season: 'cooling' }), ac).mode, 'off');
  // Season off: fan when chosen, off for other off causes.
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'off' }), { ...ac, seasonOffMode: 'fan' }).mode, 'fan');
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'off' }), ac).mode, 'off');
  assert.strictEqual(pipeline.memberPlan(decide({}, { mode: 'off' }), { ...ac, seasonOffMode: 'fan' }).mode, 'off');
});

test('follow home overrides the occupancy rule until it runs out', () => {
  const guest = { occupancyRule: 'always_eco', followUntil: NOW + 3600000 };
  const following = decide({}, guest);
  assert.deepStrictEqual([following.aim, following.reasons[0].code], ['comfort', 'follow_home']);
  assert.strictEqual(decide({ occupancy: 'away' }, guest).aim, 'eco');
  assert.strictEqual(decide({}, { ...guest, followUntil: NOW - 1 }).aim, 'eco');
});

test('long absence: an A/C with eco fan heats at eco and runs fan only while the room is warm', () => {
  const ac = { control: 'ac', ecoMode: 'fan', modes: ['heat', 'cool', 'fan', 'off'], min: 10, max: 30, step: 1 };
  const absence = decide({ longAbsence: true });
  assert.strictEqual(pipeline.memberPlan(absence, ac, { temperature: 18.5 }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(absence, ac, { temperature: null }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(absence, ac, { temperature: 20 }).mode, 'fan');
  assert.strictEqual(pipeline.memberPlan(absence, ac, { temperature: 19.5, lastMode: 'fan' }).mode, 'fan');
  assert.strictEqual(pipeline.memberPlan(absence, ac, { temperature: 19, lastMode: 'fan' }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), ac, { temperature: 15 }).mode, 'fan');
});

test('a price peak replaces the presence reason; fan gets a device note', () => {
  assert.deepStrictEqual(decide({ expensive: true }).reasons.map((r) => r.code), ['expensive']);
  assert.deepStrictEqual(decide({ expensive: true }, { pricePeak: 'off' }).reasons.map((r) => r.code), ['expensive_off']);
  const ac = { control: 'ac', ecoMode: 'fan', seasonOffMode: 'fan', modes: ['heat', 'cool', 'fan', 'off'], min: 10, max: 30, step: 1 };
  assert.deepStrictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), ac).reasons.map((r) => r.code), ['fan']);
  assert.deepStrictEqual(pipeline.memberPlan(decide({ season: 'off' }), ac).reasons.map((r) => r.code), ['fan']);
});

test('off switch detection: thermostat_mode, then onoff, then system_mode', () => {
  const mode = (ids) => ({ setable: true, values: ids.map((id) => ({ id })) });
  assert.strictEqual(offSwitch({ thermostat_mode: mode(['heat', 'off']), onoff: { setable: true } }), 'thermostat_mode');
  assert.strictEqual(offSwitch({ thermostat_mode: mode(['heat', 'cool']), onoff: { setable: true } }), 'onoff');
  assert.strictEqual(offSwitch({ onoff: { setable: true }, system_mode: mode(['heat', 'off']) }), 'onoff');
  assert.strictEqual(offSwitch({ system_mode: { setable: true } }), 'system_mode');
  assert.strictEqual(offSwitch({ system_mode: mode(['heat', 'auto']) }), null);
  assert.strictEqual(offSwitch({ target_temperature: {} }), null);
});

test('air conditioner detection: class or A/C-only modes, not the standard cool mode', () => {
  assert.strictEqual(isAirConditioner('thermostat', ['auto', 'heat', 'cool', 'off']), false);
  assert.strictEqual(isAirConditioner('airconditioning', ['heat', 'cool', 'off']), true);
  assert.strictEqual(isAirConditioner('heatpump', ['heat', 'cool', 'off']), true);
  assert.strictEqual(isAirConditioner('thermostat', ['heat', 'cool', 'fan', 'off']), true);
  assert.strictEqual(isAirConditioner('airconditioning', []), false);
});

test('relay band needs at least 0.2 °C between on and off', () => {
  assert.strictEqual(pipeline.validRelayBand(0.3, 0.3), true);
  assert.strictEqual(pipeline.validRelayBand(1.0, -0.5), true);
  assert.strictEqual(pipeline.validRelayBand(0.1, 0.1), true);
  assert.strictEqual(pipeline.validRelayBand(0.1, 0.05), false);
  assert.strictEqual(pipeline.validRelayBand(0.5, -0.4), false);
  assert.strictEqual(pipeline.validRelayBand(NaN, 0.3), false);
});

test('temperature choices: one with a value first, then the plain one', () => {
  const t = (value) => ({ value, units: '°C', decimals: 1 });
  // Zigbee2MQTT thermostat: plain measure_temperature empty, the value in .local.
  const z2m = temperatureCapabilities({ 'measure_temperature': t(null), 'measure_temperature.local': t(21.04) });
  assert.deepStrictEqual(z2m.map((cap) => [cap.id, cap.reading]), [['measure_temperature.local', '21 °C'], ['measure_temperature', null]]);
  const both = temperatureCapabilities({ 'measure_temperature.floor': t(24.5), 'measure_temperature': t(20.5) });
  assert.deepStrictEqual(both.map((cap) => cap.id), ['measure_temperature', 'measure_temperature.floor']);
});
