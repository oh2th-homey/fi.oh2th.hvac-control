'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { addQuarter, summary } = require('../lib/daily');

test('quarters add up to the day, cost only with a known price', () => {
  let day = null;
  ({ day } = addQuarter(day, '2026-10-30', { energy: 200, price: 0.3, temperature: 20, eco: false }));
  ({ day } = addQuarter(day, '2026-10-30', { energy: 100, price: 0.1, temperature: 21, eco: true }));
  ({ day } = addQuarter(day, '2026-10-30', { energy: 50, price: null, temperature: null }));
  const s = summary(day);
  assert.strictEqual(s.kWh, 0.35);
  assert.ok(Math.abs(s.cost - 0.07) < 1e-9);
  // 0.07 over the 0.3 kWh with a price.
  assert.ok(Math.abs(s.pricePaid - 0.07 / 0.3) < 1e-9);
  assert.ok(Math.abs(s.priceAverage - 0.2) < 1e-9);
  assert.strictEqual(s.temperature, 20.5);
  assert.strictEqual(day.eco, 1);
  assert.strictEqual(day.quarters, 3);
});

test('a new date closes the previous day', () => {
  const { day: first } = addQuarter(null, '2026-10-30', { energy: 100, price: 0.2 });
  const { day, finished } = addQuarter(first, '2026-10-31', { energy: 40, price: 0.1 });
  assert.strictEqual(finished.date, '2026-10-30');
  assert.strictEqual(finished.wh, 100);
  assert.strictEqual(day.date, '2026-10-31');
  assert.strictEqual(day.wh, 40);
  assert.strictEqual(addQuarter(day, '2026-10-31', {}).finished, null);
});

test('no energy: no cost and no price paid', () => {
  const { day } = addQuarter(null, '2026-10-30', { energy: null, price: 0.2, temperature: 19 });
  const s = summary(day);
  assert.strictEqual(s.kWh, 0);
  assert.strictEqual(s.cost, 0);
  assert.strictEqual(s.pricePaid, null);
  assert.deepStrictEqual(summary(null), { kWh: null, cost: null, pricePaid: null, priceAverage: null, temperature: null });
});
