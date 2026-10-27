'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const zone = require('../lib/zone');
const pipeline = require('../lib/pipeline');

const NOW = Date.UTC(2026, 10, 10, 12);
const ZONE = { mode: 'auto', boostUntil: null, heat: 21, cool: 24, setback: 2, boostDelta: 1, occupancyRule: 'follows', lowAlarm: 5 };
const SHARED = { occupancy: 'present', season: 'heating', masterMode: 'auto', expensive: false };

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
    [{ masterMode: 'off' }, {}, 'master_off'],
    [{ season: 'off' }, {}, 'season_off'],
    [{ season: 'cooling' }, { hasCooling: false, cool: null }, 'no_cooling'],
    [{ masterMode: 'long_absence', season: 'cooling' }, {}, 'long_absence_cooling']
  ]) {
    const d = decide(shared, z);
    assert.deepStrictEqual([d.action, d.target, d.reasons.at(-1).code], ['off', null, code]);
  }
});

test('long absence: eco like away, not price driven', () => {
  const d = decide({ masterMode: 'long_absence', expensive: true });
  assert.deepStrictEqual([d.action, d.aim, d.target, d.priceDriven, d.reasons.at(-1).code], ['heat', 'eco', 19, false, 'long_absence']);
});

test('no floor: eco follows the setback', () => {
  assert.strictEqual(decide({ occupancy: 'away' }, { heat: 9, setback: 4 }).target, 5);
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
  assert.strictEqual(pipeline.setpoint(decide({ occupancy: 'away' }, { heat: 21.5 }), step1).value, 20);
  // Cooling comfort 23.5 is the bottom of [23.5, 25.5]: round up.
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5 }), step1).value, 24);
});

test('setpoint: no step in band protects comfort', () => {
  const step1 = { min: 5, max: 30, step: 1 };
  const heat = pipeline.setpoint(decide({}, { heat: 21.5, setback: 0 }), step1);
  assert.deepStrictEqual([heat.value, heat.reasons[0].code], [22, 'no_step_in_band']);
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5, setback: 0 }), step1).value, 23);
});

test('setpoint: clean numbers, clamp, off', () => {
  const half = pipeline.setpoint(decide({}, { heat: 20.7 }), { min: 5, max: 30, step: 0.5 });
  assert.strictEqual(half.value, 20.5);
  const step1 = pipeline.setpoint(decide(), { min: 5, max: 30, step: 1 }).value;
  assert.ok(Number.isInteger(step1));
  assert.strictEqual(pipeline.setpoint(decide({}, {}), { min: 5, max: 30, step: 0.1 }).value, 21);
  const low = pipeline.setpoint(decide({}, { heat: 8, setback: 0 }), { min: 10, max: 30, step: 1 });
  assert.deepStrictEqual([low.value, low.reasons.at(-1).code], [10, 'clamped_min']);
  // Off: the thermostat's own lowest setpoint.
  const member = { control: 'thermostat', min: 5, max: 30, step: 0.5 };
  assert.strictEqual(pipeline.setpoint(pipeline.memberPlan(decide({}, { mode: 'off' }), member).decision, member).value, 5);
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

test('relay band validation: off must be above on', () => {
  assert.strictEqual(pipeline.validRelayBand(0.3, 0.3), true);
  assert.strictEqual(pipeline.validRelayBand(1, -0.5), true);
  assert.strictEqual(pipeline.validRelayBand(0.5, -0.5), false);
  assert.strictEqual(pipeline.validRelayBand(-0.1, 0.3), false);
  assert.strictEqual(pipeline.validRelayBand(NaN, 0.3), false);
});

test('memberPlan: thermostat with onoff is switched on when heating, off otherwise', () => {
  const heater = { control: 'thermostat', min: 5, hasOnoff: true };
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
  assert.strictEqual(pipeline.memberPlan(decide({}, { mode: 'off' }), thermostat).decision.target, 5);
  const summer = pipeline.memberPlan(decide({ season: 'cooling' }), thermostat);
  assert.deepStrictEqual([summer.decision.target, summer.reasons[0].code], [5, 'heating_device_cooling']);
  assert.deepStrictEqual([pipeline.memberPlan(decide({}, { mode: 'off' }), ac).mode, pipeline.memberPlan(decide({}, { mode: 'off' }), ac).decision], ['off', null]);
  assert.strictEqual(pipeline.memberPlan(decide(), ac).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'cooling' }), ac).mode, 'cool');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), ac).mode, 'fan');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), { ...ac, modes: ['heat', 'cool', 'off'] }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ masterMode: 'long_absence' }), { ...ac, ecoMode: 'setback' }).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ masterMode: 'long_absence', season: 'cooling' }), ac).mode, 'off');
});
