'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { VERSION, QUARTER_MS, HEADER_BYTES, ZONE_BYTES, DAY_BYTES, CONTROLLER_SLOT, encodeRow, decodeDay, encodeDayRow, decodeDays, History } = require('../lib/history');

const QUARTER = Date.UTC(2026, 9, 31, 6, 15);

function zone(slot, extra = {}) {
  return {
    slot,
    temperature: 20.4,
    target: 21,
    low: 19,
    high: 21,
    energy: 187,
    humidity: 52,
    action: 'heat',
    aim: 'comfort',
    windowOpen: false,
    pricePeak: false,
    lowTemperature: false,
    ...extra
  };
}

function row(zones, extra = {}) {
  return { quarter: QUARTER, outdoor: -3.2, price: 0.3125, occupancy: 'present', season: 'heating', longAbsence: false, expensive: true, zones, ...extra };
}

function day(...rows) {
  return Buffer.concat([Buffer.from([VERSION]), ...rows.map(encodeRow)]);
}

test('a quarter with ten zones takes 142 bytes', () => {
  const zones = Array.from({ length: 10 }, (_, i) => zone(i));
  assert.strictEqual(encodeRow(row(zones)).length, HEADER_BYTES + 10 * ZONE_BYTES);
  assert.strictEqual(HEADER_BYTES + 10 * ZONE_BYTES, 142);
});

test('rows round trip', () => {
  const original = row([zone(0), zone(3, { action: 'off', aim: 'eco', windowOpen: true, pricePeak: true, lowTemperature: true, temperature: -1.5 })]);
  const [decoded] = decodeDay(day(original));
  assert.deepStrictEqual(decoded, original);
});

test('unknown values come back as null', () => {
  const original = row([zone(1, { temperature: null, target: null, low: null, high: null, energy: null, humidity: null, action: null, aim: null })], {
    outdoor: null,
    price: null,
    occupancy: null,
    season: null
  });
  const [decoded] = decodeDay(day(original));
  assert.strictEqual(decoded.outdoor, null);
  assert.strictEqual(decoded.price, null);
  assert.strictEqual(decoded.occupancy, null);
  assert.strictEqual(decoded.season, null);
  const z = decoded.zones[0];
  for (const key of ['temperature', 'target', 'low', 'high', 'energy', 'humidity', 'aim']) assert.strictEqual(z[key], null, key);
  assert.strictEqual(z.action, 'none');
});

test('values are rounded and limited to their field', () => {
  const [decoded] = decodeDay(day(row([zone(0, { temperature: 20.44, energy: 70000.4, humidity: 300 })], { price: -0.01234 })));
  assert.strictEqual(decoded.zones[0].temperature, 20.4);
  assert.strictEqual(decoded.zones[0].energy, 65534);
  assert.strictEqual(decoded.zones[0].humidity, 254);
  assert.strictEqual(decoded.price, -0.0123);
});

test('a cut-off last row and a wrong version are ignored', () => {
  const two = day(row([zone(0)]), row([zone(0)], { quarter: QUARTER + QUARTER_MS }));
  assert.strictEqual(decodeDay(two.subarray(0, two.length - 3)).length, 1);
  const wrong = Buffer.from(two);
  wrong[0] = VERSION + 1;
  assert.deepStrictEqual(decodeDay(wrong), []);
});

test('History appends day files, keeps zone slots and prunes old days', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvac-history-'));
  try {
    const history = new History({}, dir);
    assert.strictEqual(await history.slot('zone-a', 'Kitchen'), 0);
    assert.strictEqual(await history.slot('zone-b', 'Bathroom'), 1);
    assert.strictEqual(await history.slot('zone-a', 'Kitchen floor'), 0);
    // A new instance (app restart) reads the map from disk.
    const again = new History({}, dir);
    assert.strictEqual(await again.slot('zone-b', 'Bathroom'), 1);
    assert.strictEqual((await again.loadSlots())['zone-a'].name, 'Kitchen floor');

    await history.append('2026-10-31', row([zone(0)]));
    await history.append('2026-10-31', row([zone(0), zone(1)], { quarter: QUARTER + QUARTER_MS }));
    const { data } = await history.read('2026-10-31');
    assert.strictEqual(data.length, 1 + 2 * HEADER_BYTES + 3 * ZONE_BYTES);
    assert.strictEqual(decodeDay(data).length, 2);

    // Kept for KEEP_DAYS (60): 2026-09-01 is the 61st day back, 2026-09-02 the 60th.
    await history.append('2026-09-01', row([zone(0)]));
    await history.append('2026-09-02', row([zone(0)]));
    await history.prune('2026-10-31');
    const left = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(left, ['2026-09-02.bin', '2026-10-31.bin', 'zones.json']);
    assert.strictEqual((await history.read('2026-11-01')).data, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daily summary rows round trip, 23 bytes each', () => {
  const zoneDay = { date: '2026-10-30', slot: 3, wh: 2412, pricedWh: 2400, cost: 0.6123, temperature: 20.4, priceAverage: 0.1987, eco: 22, quarters: 96 };
  const controllerDay = { date: '2026-10-30', slot: CONTROLLER_SLOT, wh: 8600, pricedWh: 8600, cost: 1.5, temperature: 6.9, priceAverage: 0.1987, eco: 9, quarters: 96 };
  assert.strictEqual(encodeDayRow(zoneDay).length, DAY_BYTES);
  const data = Buffer.concat([Buffer.from([VERSION]), encodeDayRow(zoneDay), encodeDayRow(controllerDay)]);
  assert.deepStrictEqual(decodeDays(data), [zoneDay, controllerDay]);
  const unknown = decodeDays(Buffer.concat([Buffer.from([VERSION]), encodeDayRow({ ...zoneDay, cost: null, temperature: null, priceAverage: null })]))[0];
  assert.strictEqual(unknown.cost, null);
  assert.strictEqual(unknown.temperature, null);
  assert.strictEqual(unknown.priceAverage, null);
  assert.strictEqual(decodeDays(data.subarray(0, data.length - 1)).length, 1);
});

test('History appends daily rows to days.bin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvac-days-'));
  try {
    const history = new History({}, dir);
    assert.strictEqual((await history.readDays()).data, null);
    await history.appendDays([{ date: '2026-10-30', slot: 0, wh: 100, pricedWh: 100, cost: 0.02, temperature: 20, priceAverage: 0.2, eco: 0, quarters: 96 }]);
    await history.appendDays([]);
    await history.appendDays([{ date: '2026-10-31', slot: 0, wh: 200, pricedWh: 200, cost: 0.04, temperature: 20, priceAverage: 0.2, eco: 0, quarters: 96 }]);
    const { data } = await history.readDays();
    assert.strictEqual(data.length, 1 + 2 * DAY_BYTES);
    assert.deepStrictEqual(decodeDays(data).map((day) => day.date), ['2026-10-30', '2026-10-31']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
