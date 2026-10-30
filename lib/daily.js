'use strict';

/**
 * Daily energy and cost from the quarter-hour samples. The running day is kept in the device store; at the first quarter of
 * a new local day it is closed and written as a daily summary row (lib/history.js).
 */

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function emptyDay(date) {
  return { date, wh: 0, pricedWh: 0, cost: 0, tempSum: 0, temps: 0, priceSum: 0, prices: 0, eco: 0, quarters: 0 };
}

/**
 * @description Add one quarter to the day.
 * @param {Object|null} day - The running day from the store
 * @param {string} date - Local date of the quarter (YYYY-MM-DD)
 * @param {Object} quarter - { energy (Wh), price (per kWh), temperature (°C), eco (boolean) }; unknown values null
 * @returns {Object} { day, finished }: finished is the previous day when the date changed, else null
 */
function addQuarter(day, date, { energy = null, price = null, temperature = null, eco = false } = {}) {
  const finished = day && day.date !== date ? day : null;
  const next = day && day.date === date ? { ...day } : emptyDay(date);
  next.quarters += 1;
  if (eco) next.eco += 1;
  if (finite(temperature)) {
    next.tempSum += temperature;
    next.temps += 1;
  }
  if (finite(price)) {
    next.priceSum += price;
    next.prices += 1;
  }
  if (finite(energy)) {
    next.wh += energy;
    // Cost only from quarters with a known price; the price paid is the cost over that energy.
    if (finite(price)) {
      next.pricedWh += energy;
      next.cost += (energy * price) / 1000;
    }
  }
  return { day: next, finished };
}

/**
 * @description The day's figures.
 * @returns {Object} { kWh, cost, pricePaid (cost per kWh), priceAverage (mean of the quarters' prices), temperature (mean) }
 */
function summary(day) {
  if (!day) return { kWh: null, cost: null, pricePaid: null, priceAverage: null, temperature: null };
  return {
    kWh: day.wh / 1000,
    cost: day.cost,
    pricePaid: day.pricedWh > 0 ? day.cost / (day.pricedWh / 1000) : null,
    priceAverage: day.prices ? day.priceSum / day.prices : null,
    temperature: day.temps ? day.tempSum / day.temps : null
  };
}

/**
 * @description A finished day as a daily summary row (lib/history.js encodeDayRow).
 */
function row(day, slot) {
  const s = summary(day);
  return { date: day.date, slot, wh: day.wh, pricedWh: day.pricedWh, cost: day.cost, temperature: s.temperature, priceAverage: s.priceAverage, eco: day.eco, quarters: day.quarters };
}

module.exports = { emptyDay, addQuarter, summary, row };
