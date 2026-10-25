'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

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
