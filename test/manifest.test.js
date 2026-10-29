'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const app = require('../app.json');
const compose = require('../.homeycompose/app.json');

test('app.json is in sync with .homeycompose/app.json', () => {
  assert.strictEqual(app.id, compose.id);
  assert.strictEqual(app.version, compose.version);
});

test('package.json matches the app manifest', () => {
  assert.strictEqual(pkg.name, app.id);
  assert.strictEqual(pkg.version, app.version);
});

test('pair and repair views are the same file', () => {
  for (const driver of ['hvac', 'zone']) {
    const dir = path.join(__dirname, '..', 'drivers', driver);
    for (const view of fs.readdirSync(path.join(dir, 'repair'))) {
      const pair = fs.readFileSync(path.join(dir, 'pair', view), 'utf8');
      const repair = fs.readFileSync(path.join(dir, 'repair', view), 'utf8');
      assert.strictEqual(repair, pair, `drivers/${driver}/repair/${view} differs from pair/${view}: copy pair over repair`);
    }
  }
});
