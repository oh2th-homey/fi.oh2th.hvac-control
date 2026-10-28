'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const units = require('../lib/units');

test('temperatures and differences in the home unit', () => {
  assert.strictEqual(units.formatTemperature(21.5, false), '21.5 °C');
  assert.strictEqual(units.formatTemperature(21.5, true), '70.7 °F');
  assert.strictEqual(units.formatTemperature(-10, true), '14 °F');
  assert.strictEqual(units.formatDifference(0.5, false), '0.5 °C');
  assert.strictEqual(units.formatDifference(0.5, true), '0.9 °F');
  assert.strictEqual(units.formatTemperature(null, true), 'null');
});

test('member temperatures from the Web API in °F convert both ways', () => {
  assert.strictEqual(units.isFahrenheit('°F'), true);
  assert.strictEqual(units.isFahrenheit('°C'), false);
  assert.strictEqual(units.isFahrenheit(undefined), false);
  assert.strictEqual(units.toCelsius(50), 10);
  assert.strictEqual(units.toCelsius(68.9), 20.5);
  assert.strictEqual(units.toFahrenheit(20), 68);
  assert.strictEqual(units.toCelsius(units.toFahrenheit(21.5)), 21.5);
  assert.strictEqual(units.toCelsius(null), null);
});

test('°F when Homey says imperial or a member temperature comes in °F', () => {
  assert.strictEqual(units.isImperial('imperial', false), true);
  assert.strictEqual(units.isImperial('metric', true), true);
  assert.strictEqual(units.isImperial('metric', false), false);
  assert.strictEqual(units.isImperial(undefined, undefined), false);
});
