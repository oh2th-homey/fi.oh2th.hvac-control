'use strict';

/**
 * Compact quarter-hour history for learning and replay: binary, one file per local day in /userdata (on disk, not
 * in memory), kept for 60 days. Each file starts with a version byte, then one row per quarter:
 *
 *   header (12 bytes): uint32 quarter (ms / 900000), int16 outdoor ×10, int32 price ×10000, uint8 flags, uint8 zones
 *   zone   (13 bytes): uint8 slot, int16 temperature ×10, int16 target ×10, int16 band low ×10, int16 band high ×10,
 *                      uint16 energy Wh, uint8 humidity %, uint8 flags
 *                      (zone flags: action 2 bits, aim 3 bits, window open, price peak acted, low temperature)
 *
 * Unknown values are stored as the type's sentinel (int16 −32768, int32 −2147483648, uint16 65535, uint8 255).
 * Ten zones take 142 bytes a quarter, about 14 kB a day. Zone slots (small numbers) map to device ids in zones.json.
 *
 * Daily summary rows, kept long term in days.bin (version byte, then 23 bytes a row; ~90 kB a year for ten zones):
 *   uint16 day (days since 1970-01-01 of the local date), uint8 slot (255 = controller), uint32 Wh, uint32 Wh with a
 *   known price, int32 cost ×10000, int16 temperature ×10 (zone: indoor mean, controller: outdoor mean),
 *   int32 price average ×10000, uint8 eco quarters (controller: expensive quarters), uint8 quarters
 */

const fs = require('fs');
const path = require('path');
const { addDays } = require('oh2th-homey-helpers');

const VERSION = 1;
const DIR = '/userdata/history';
const KEEP_DAYS = 60;
const QUARTER_MS = 15 * 60 * 1000;
const HEADER_BYTES = 12;
const ZONE_BYTES = 13;
const DAY_BYTES = 23;
const DAY_MS = 24 * 60 * 60 * 1000;
// Slot of the controller's row in the daily summary.
const CONTROLLER_SLOT = 255;
const NULL16 = -32768;
const NULL32 = -2147483648;
const NULLU16 = 65535;
const NULLU8 = 255;

const OCCUPANCY = ['present', 'coming_home', 'away'];
const SEASONS = ['heating', 'cooling', 'off'];
const ACTIONS = ['none', 'heat', 'cool', 'off'];
const AIMS = ['manual', 'comfort', 'eco', 'boost', 'off'];

function int16(value, scale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NULL16;
  return Math.max(NULL16 + 1, Math.min(32767, Math.round(value * scale)));
}

function int32(value, scale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NULL32;
  return Math.max(NULL32 + 1, Math.min(2147483647, Math.round(value * scale)));
}

function uint(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return max;
  return Math.max(0, Math.min(max - 1, Math.round(value)));
}

function index(list, value) {
  const i = list.indexOf(value);
  return i < 0 ? list.length : i;
}

/**
 * @description One quarter as bytes.
 * @param {Object} row - { quarter (ms, start), outdoor, price, occupancy, season, longAbsence, expensive,
 *   zones: [{ slot, temperature, target, low, high, energy, humidity, action, aim, windowOpen, pricePeak, lowTemperature }] }
 * @returns {Buffer}
 */
function encodeRow(row) {
  const zones = (row.zones || []).slice(0, 255);
  const buffer = Buffer.alloc(HEADER_BYTES + zones.length * ZONE_BYTES);
  buffer.writeUInt32LE(Math.floor(row.quarter / QUARTER_MS), 0);
  buffer.writeInt16LE(int16(row.outdoor, 10), 4);
  buffer.writeInt32LE(int32(row.price, 10000), 6);
  const flags = index(OCCUPANCY, row.occupancy) | (index(SEASONS, row.season) << 2) | (row.longAbsence ? 16 : 0) | (row.expensive ? 32 : 0);
  buffer.writeUInt8(flags, 10);
  buffer.writeUInt8(zones.length, 11);
  zones.forEach((zone, i) => {
    const at = HEADER_BYTES + i * ZONE_BYTES;
    buffer.writeUInt8(uint(zone.slot, 255), at);
    buffer.writeInt16LE(int16(zone.temperature, 10), at + 1);
    buffer.writeInt16LE(int16(zone.target, 10), at + 3);
    buffer.writeInt16LE(int16(zone.low, 10), at + 5);
    buffer.writeInt16LE(int16(zone.high, 10), at + 7);
    buffer.writeUInt16LE(uint(zone.energy, NULLU16), at + 9);
    buffer.writeUInt8(uint(zone.humidity, NULLU8), at + 11);
    const zoneFlags = (index(ACTIONS, zone.action) & 3) | (index(AIMS, zone.aim) << 2) | (zone.windowOpen ? 32 : 0) | (zone.pricePeak ? 64 : 0) | (zone.lowTemperature ? 128 : 0);
    buffer.writeUInt8(zoneFlags, at + 12);
  });
  return buffer;
}

function fromInt16(value, scale) {
  return value === NULL16 ? null : value / scale;
}

/**
 * @description All rows of a day file (version byte first); a cut-off last row is ignored.
 * @returns {Object[]} rows as given to encodeRow
 */
function decodeDay(buffer) {
  if (!buffer || buffer.length < 1 || buffer.readUInt8(0) !== VERSION) return [];
  const rows = [];
  let at = 1;
  while (at + HEADER_BYTES <= buffer.length) {
    const count = buffer.readUInt8(at + 11);
    if (at + HEADER_BYTES + count * ZONE_BYTES > buffer.length) break;
    const price = buffer.readInt32LE(at + 6);
    const flags = buffer.readUInt8(at + 10);
    const row = {
      quarter: buffer.readUInt32LE(at) * QUARTER_MS,
      outdoor: fromInt16(buffer.readInt16LE(at + 4), 10),
      price: price === NULL32 ? null : price / 10000,
      occupancy: OCCUPANCY[flags & 3] || null,
      season: SEASONS[(flags >> 2) & 3] || null,
      longAbsence: !!(flags & 16),
      expensive: !!(flags & 32),
      zones: []
    };
    for (let i = 0; i < count; i++) {
      const z = at + HEADER_BYTES + i * ZONE_BYTES;
      const energy = buffer.readUInt16LE(z + 9);
      const humidity = buffer.readUInt8(z + 11);
      const zoneFlags = buffer.readUInt8(z + 12);
      row.zones.push({
        slot: buffer.readUInt8(z),
        temperature: fromInt16(buffer.readInt16LE(z + 1), 10),
        target: fromInt16(buffer.readInt16LE(z + 3), 10),
        low: fromInt16(buffer.readInt16LE(z + 5), 10),
        high: fromInt16(buffer.readInt16LE(z + 7), 10),
        energy: energy === NULLU16 ? null : energy,
        humidity: humidity === NULLU8 ? null : humidity,
        action: ACTIONS[zoneFlags & 3],
        aim: AIMS[(zoneFlags >> 2) & 7] || null,
        windowOpen: !!(zoneFlags & 32),
        pricePeak: !!(zoneFlags & 64),
        lowTemperature: !!(zoneFlags & 128)
      });
    }
    rows.push(row);
    at += HEADER_BYTES + count * ZONE_BYTES;
  }
  return rows;
}

function dayNumber(date) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function dayDate(number) {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

/**
 * @description One daily summary row as bytes.
 * @param {Object} row - { date, slot, wh, pricedWh, cost, temperature, priceAverage, eco, quarters }
 * @returns {Buffer}
 */
function encodeDayRow(row) {
  const buffer = Buffer.alloc(DAY_BYTES);
  buffer.writeUInt16LE(dayNumber(row.date), 0);
  buffer.writeUInt8(uint(row.slot, 256), 2);
  buffer.writeUInt32LE(uint(row.wh, 4294967295), 3);
  buffer.writeUInt32LE(uint(row.pricedWh, 4294967295), 7);
  buffer.writeInt32LE(int32(row.cost, 10000), 11);
  buffer.writeInt16LE(int16(row.temperature, 10), 15);
  buffer.writeInt32LE(int32(row.priceAverage, 10000), 17);
  buffer.writeUInt8(uint(row.eco, 256), 21);
  buffer.writeUInt8(uint(row.quarters, 256), 22);
  return buffer;
}

/**
 * @description All daily summary rows of days.bin (version byte first); a cut-off last row is ignored.
 */
function decodeDays(buffer) {
  if (!buffer || buffer.length < 1 || buffer.readUInt8(0) !== VERSION) return [];
  const rows = [];
  for (let at = 1; at + DAY_BYTES <= buffer.length; at += DAY_BYTES) {
    const cost = buffer.readInt32LE(at + 11);
    const priceAverage = buffer.readInt32LE(at + 17);
    rows.push({
      date: dayDate(buffer.readUInt16LE(at)),
      slot: buffer.readUInt8(at + 2),
      wh: buffer.readUInt32LE(at + 3),
      pricedWh: buffer.readUInt32LE(at + 7),
      cost: cost === NULL32 ? null : cost / 10000,
      temperature: fromInt16(buffer.readInt16LE(at + 15), 10),
      priceAverage: priceAverage === NULL32 ? null : priceAverage / 10000,
      eco: buffer.readUInt8(at + 21),
      quarters: buffer.readUInt8(at + 22)
    });
  }
  return rows;
}

/**
 * @description Day files and the zone slot map in a directory; one append per quarter, nothing kept in memory but the map.
 */
class History {
  constructor(ctx, dir = DIR) {
    this.ctx = ctx;
    this.dir = dir;
    this.slots = null;
  }

  file(date) {
    return path.join(this.dir, `${date}.bin`);
  }

  async loadSlots() {
    if (this.slots) return this.slots;
    try {
      this.slots = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'zones.json'), 'utf8'));
    } catch (error) {
      this.slots = {};
    }
    return this.slots;
  }

  /**
   * @description The zone's slot, a new one on first use; the name is kept up to date for reading the files.
   */
  async slot(id, name) {
    const slots = await this.loadSlots();
    let entry = slots[id];
    if (!entry) {
      const used = Object.values(slots).map((s) => s.slot);
      let next = 0;
      while (used.includes(next)) next++;
      entry = { slot: next, name };
      slots[id] = entry;
    } else if (entry.name === name) {
      return entry.slot;
    }
    entry.name = name;
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(path.join(this.dir, 'zones.json'), JSON.stringify(slots));
    return entry.slot;
  }

  /**
   * @description Append one quarter to its day file.
   * @param {string} date - Local date of the quarter (YYYY-MM-DD)
   */
  async append(date, row) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = this.file(date);
    const exists = await fs.promises
      .access(file)
      .then(() => true)
      .catch(() => false);
    const data = encodeRow(row);
    await fs.promises.appendFile(file, exists ? data : Buffer.concat([Buffer.from([VERSION]), data]));
  }

  /**
   * @description Append daily summary rows to days.bin.
   */
  async appendDays(rows) {
    if (!rows.length) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'days.bin');
    const exists = await fs.promises
      .access(file)
      .then(() => true)
      .catch(() => false);
    const data = Buffer.concat(rows.map(encodeDayRow));
    await fs.promises.appendFile(file, exists ? data : Buffer.concat([Buffer.from([VERSION]), data]));
  }

  /**
   * @description days.bin as stored (null when none) and the slot map, for the Web API.
   */
  async readDays() {
    const data = await fs.promises.readFile(path.join(this.dir, 'days.bin')).catch(() => null);
    return { version: VERSION, zones: await this.loadSlots(), data };
  }

  /**
   * @description Delete day files older than KEEP_DAYS.
   * @param {string} today - Local date (YYYY-MM-DD)
   */
  async prune(today) {
    const oldest = addDays(today, -(KEEP_DAYS - 1));
    const names = await fs.promises.readdir(this.dir).catch(() => []);
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.bin$/.exec(name);
      if (match && match[1] < oldest) await fs.promises.unlink(path.join(this.dir, name)).catch(() => {});
    }
  }

  /**
   * @description A day file as stored (null when none) and the slot map, for the Web API.
   */
  async read(date) {
    const data = await fs.promises.readFile(this.file(date)).catch(() => null);
    return { version: VERSION, zones: await this.loadSlots(), data };
  }
}

module.exports = {
  VERSION,
  QUARTER_MS,
  HEADER_BYTES,
  ZONE_BYTES,
  DAY_BYTES,
  KEEP_DAYS,
  CONTROLLER_SLOT,
  encodeRow,
  decodeDay,
  encodeDayRow,
  decodeDays,
  History
};
