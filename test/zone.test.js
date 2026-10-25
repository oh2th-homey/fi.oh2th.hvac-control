'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const zone = require('../lib/zone');
const pipeline = require('../lib/pipeline');

const NOW = Date.UTC(2026, 10, 10, 12);
const ZONE = { mode: 'auto', boostUntil: null, heat: 21, cool: 24, setback: 2, frostFloor: 8, boostDelta: 1, occupancyRule: 'follows' };
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

test('frost: zone off, master off, long absence, season off', () => {
  for (const [shared, z, code] of [
    [{}, { mode: 'off' }, 'zone_off'],
    [{ masterMode: 'off' }, {}, 'master_off'],
    [{ masterMode: 'long_absence' }, {}, 'long_absence'],
    [{ season: 'off' }, {}, 'season_off']
  ]) {
    const d = decide(shared, z);
    assert.deepStrictEqual([d.action, d.target, d.reasons.at(-1).code], ['frost', 8, code]);
  }
});

test('frost floor holds eco up', () => {
  assert.strictEqual(decide({ occupancy: 'away' }, { heat: 9, setback: 4 }).target, 8);
});

test('manual: hands off, frost watchdog still on', () => {
  assert.strictEqual(decide({}, { mode: 'manual' }, { temperature: 15 }).action, 'none');
  const cold = decide({}, { mode: 'manual' }, { temperature: 6 });
  assert.deepStrictEqual([cold.action, cold.target], ['frost', 8]);
});

test('boost until a time, then normal; not in manual or off', () => {
  assert.strictEqual(decide({}, { mode: 'manual', boostUntil: NOW + 60000 }).aim, 'manual');
  assert.strictEqual(decide({}, { mode: 'off', boostUntil: NOW + 60000 }).aim, 'frost');
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
  const step1 = { min: 5, max: 30, step: 1, offset: 0 };
  // Comfort 21.5 is the top of band [19.5, 21.5]: round down.
  assert.strictEqual(pipeline.setpoint(decide({}, { heat: 21.5 }), step1).value, 21);
  // Eco 19.5 is the bottom: round up.
  assert.strictEqual(pipeline.setpoint(decide({ occupancy: 'away' }, { heat: 21.5 }), step1).value, 20);
  // Cooling comfort 23.5 is the bottom of [23.5, 25.5]: round up.
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5 }), step1).value, 24);
  // Offset applies before rounding.
  assert.strictEqual(pipeline.setpoint(decide(), { ...step1, offset: 0.6 }).value, 21);
});

test('setpoint: no step in band protects comfort', () => {
  const step1 = { min: 5, max: 30, step: 1 };
  const heat = pipeline.setpoint(decide({}, { heat: 21.5, setback: 0 }), step1);
  assert.deepStrictEqual([heat.value, heat.reasons[0].code], [22, 'no_step_in_band']);
  assert.strictEqual(pipeline.setpoint(decide({ season: 'cooling' }, { cool: 23.5, setback: 0 }), step1).value, 23);
});

test('setpoint: clean numbers, clamp, frost', () => {
  const half = pipeline.setpoint(decide({}, { heat: 20.7 }), { min: 5, max: 30, step: 0.5 });
  assert.strictEqual(half.value, 20.5);
  const step1 = pipeline.setpoint(decide(), { min: 5, max: 30, step: 1 }).value;
  assert.ok(Number.isInteger(step1));
  assert.strictEqual(pipeline.setpoint(decide({}, {}), { min: 5, max: 30, step: 0.1 }).value, 21);
  // A/C minimum 10 while the frost floor is 8.
  const frost = pipeline.setpoint(decide({}, { mode: 'off' }), { min: 10, max: 30, step: 1 });
  assert.deepStrictEqual([frost.value, frost.reasons[0].code], [10, 'clamped_min']);
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
  assert.strictEqual(pipeline.classifyReport(23, 21, m), 'hand');
  assert.strictEqual(pipeline.classifyReport(null, 21, m), 'unknown');
});

test('relay: hysteresis, min on/off, no temperature', () => {
  const base = { target: 21, hysteresis: 0.3, now: NOW, lastSwitchAt: 0 };
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 20.6 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 20.9 }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 20.9 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 21.4 }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: 21.4, minOnMs: 300000, lastSwitchAt: NOW - 60000 }).on, true);
  assert.strictEqual(pipeline.relay({ ...base, on: true, temperature: null }).on, false);
  assert.strictEqual(pipeline.relay({ ...base, on: false, temperature: 21.4, heating: false }).on, true);
});

test('memberPlan: thermostat in cooling holds frost, A/C modes and fan eco', () => {
  const zoneInfo = { temperature: 20, frostFloor: 8 };
  const thermostat = { control: 'thermostat' };
  const ac = { control: 'ac', ecoMode: 'fan', modes: ['heat', 'cool', 'off', 'fan'] };
  assert.strictEqual(pipeline.memberPlan(decide({}, { mode: 'manual' }), thermostat, zoneInfo).skip, true);
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'cooling' }), thermostat, zoneInfo).decision.target, 8);
  assert.strictEqual(pipeline.memberPlan(decide(), ac, zoneInfo).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ season: 'cooling' }), ac, zoneInfo).mode, 'cool');
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), ac, zoneInfo).mode, 'fan');
  // Heating near the frost floor: no fan, setback instead.
  const cold = pipeline.memberPlan(decide({ occupancy: 'away' }), ac, { temperature: 9, frostFloor: 8 });
  assert.deepStrictEqual([cold.mode, cold.reasons[0].code], ['heat', 'fan_fallback']);
  assert.strictEqual(pipeline.memberPlan(decide({ occupancy: 'away' }), { ...ac, modes: ['heat', 'cool', 'off'] }, zoneInfo).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ masterMode: 'long_absence' }), ac, zoneInfo).mode, 'heat');
  assert.strictEqual(pipeline.memberPlan(decide({ masterMode: 'long_absence', season: 'cooling' }), ac, zoneInfo).mode, 'off');
});
