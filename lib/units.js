'use strict';

/**
 * Temperature units. Homey stores temperatures in °C and converts capability values with unit °C for display in an
 * imperial home. Texts are converted here, and member values from the Web API. No Homey dependencies.
 */

/**
 * @description °F or not. getUnits() can stay metric while Homey shows °F (by location); the Web API labels member
 * temperatures °F then, which is the reliable sign.
 * @param {string} system - homey.i18n.getUnits(): 'metric' | 'imperial'
 * @param {boolean} membersFahrenheit - a member temperature is reported in °F
 */
function isImperial(system, membersFahrenheit) {
  return membersFahrenheit === true || system === 'imperial';
}

function trim1(value) {
  return String(Math.round(value * 10) / 10);
}

/**
 * @description A temperature in °C as text in the home's unit, e.g. '21.5 °C' or '70.7 °F'.
 */
function formatTemperature(celsius, imperial) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return String(celsius);
  return imperial ? `${trim1(celsius * 1.8 + 32)} °F` : `${trim1(celsius)} °C`;
}

/**
 * @description A temperature difference in °C as text in the home's unit, e.g. '0.5 °C' or '0.9 °F'.
 */
function formatDifference(celsius, imperial) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return String(celsius);
  return imperial ? `${trim1(celsius * 1.8)} °F` : `${trim1(celsius)} °C`;
}

/**
 * @description True when a capability's units say °F. The Homey Web API reports temperatures in °F in an imperial
 * home, also to apps, and takes written values in °F.
 */
function isFahrenheit(capabilityUnits) {
  return typeof capabilityUnits === 'string' && capabilityUnits.trim().toUpperCase() === '°F';
}

function toCelsius(fahrenheit) {
  return typeof fahrenheit === 'number' && Number.isFinite(fahrenheit) ? Math.round(((fahrenheit - 32) / 1.8) * 100) / 100 : fahrenheit;
}

function toFahrenheit(celsius) {
  return typeof celsius === 'number' && Number.isFinite(celsius) ? Math.round((celsius * 1.8 + 32) * 100) / 100 : celsius;
}

module.exports = {
  isFahrenheit,
  toCelsius,
  toFahrenheit,
  isImperial,
  formatTemperature,
  formatDifference
};
