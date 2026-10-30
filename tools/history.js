'use strict';

/**
 * Read the app's quarter-hour history (lib/history.js) from a Homey and print it as a table, or as JSON rows.
 *
 *   HOMEY_URL=http://<homey-ip> HOMEY_KEY=<api key> node tools/history.js [YYYY-MM-DD] [--json]
 *   HOMEY_URL=... HOMEY_KEY=... node tools/history.js days [--json]      (daily summary rows)
 *   curl ... /api/app/fi.oh2th.hvac-control/history?date=YYYY-MM-DD | node tools/history.js -
 *
 * The API key needs the scopes View Apps and Control Apps. HOMEY_URL is the Homey's local address
 * (Homey Pro: port 80; Self-Hosted Server: port 4859) or its cloud address. Times are printed in local time.
 */

const { decodeDay, decodeDays, CONTROLLER_SLOT } = require('../lib/history');

const APP_ID = 'fi.oh2th.hvac-control';

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function fetchPath(route) {
  const { HOMEY_URL, HOMEY_KEY } = process.env;
  if (!HOMEY_URL || !HOMEY_KEY) throw new Error('Set HOMEY_URL and HOMEY_KEY, or pipe the API response in with "-".');
  const response = await fetch(`${HOMEY_URL.replace(/\/$/, '')}/api/app/${APP_ID}${route}`, { headers: { Authorization: `Bearer ${HOMEY_KEY}` } });
  return response.text();
}

function parse(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(text ? `Not JSON from Homey: ${text.slice(0, 300)}` : 'Empty response from Homey.');
  }
  if (body.error || (body.message && !body.version)) throw new Error(`Homey said: ${body.error || ''} ${body.message || ''}`.trim());
  return body;
}

function print(body, rows) {
  const names = Object.fromEntries(Object.values(body.zones || {}).map((zone) => [zone.slot, zone.name]));
  const bytes = body.data ? Buffer.from(body.data, 'base64').length : 0;
  console.log(`${body.date}: ${rows.length} quarters, ${bytes} bytes`);
  for (const row of rows) {
    const time = new Date(row.quarter).toTimeString().slice(0, 5);
    const state = [row.occupancy, row.season, row.expensive && 'EXPENSIVE', row.longAbsence && 'ABSENCE'].filter(Boolean).join(' ');
    console.log(`${time} out ${row.outdoor} °C, price ${row.price}, ${state}`);
    for (const zone of row.zones) {
      const flags = [zone.windowOpen && 'window', zone.pricePeak && 'peak', zone.lowTemperature && 'low'].filter(Boolean).join(',');
      const name = String(names[zone.slot] ?? zone.slot).padEnd(22);
      const climate = `${String(zone.temperature).padStart(5)} → ${String(zone.target).padStart(5)} [${zone.low}–${zone.high}]`;
      console.log(`  ${name} ${climate} ${String(zone.energy).padStart(5)} Wh ${zone.humidity ?? '-'}% ${zone.action}/${zone.aim} ${flags}`);
    }
  }
}

function printDays(body, rows) {
  const names = Object.fromEntries(Object.values(body.zones || {}).map((zone) => [zone.slot, zone.name]));
  names[CONTROLLER_SLOT] = 'All zones';
  const fixed = (value, digits) => (typeof value === 'number' ? value.toFixed(digits) : '-');
  for (const day of rows) {
    const paid = day.pricedWh > 0 ? day.cost / (day.pricedWh / 1000) : null;
    const eco = day.slot === CONTROLLER_SLOT ? 'expensive' : 'eco';
    console.log(
      `${day.date}  ${String(names[day.slot] ?? day.slot).padEnd(22)} ${fixed(day.wh / 1000, 2).padStart(7)} kWh ${fixed(day.cost, 2).padStart(6)}`
        + `  paid ${fixed(paid, 4)}  avg ${fixed(day.priceAverage, 4)}  ${fixed(day.temperature, 1)} °C  ${day.eco}/${day.quarters} ${eco}`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const source = args.find((arg) => arg !== '--json');
  if (source === 'days') {
    const body = parse(await fetchPath('/history/days'));
    const rows = body.data ? decodeDays(Buffer.from(body.data, 'base64')) : [];
    if (json) console.log(JSON.stringify({ zones: body.zones, rows }, null, 2));
    else if (!rows.length) console.log('No daily summary rows yet (written at the first quarter of a new day).');
    else printDays(body, rows);
    return;
  }
  const text = source === '-' ? await readStdin() : await fetchPath(`/history?date=${source || today()}`);
  const body = parse(text);
  if (!body.data) {
    console.log(`No history for ${body.date}`);
    return;
  }
  const rows = decodeDay(Buffer.from(body.data, 'base64'));
  if (json) {
    console.log(JSON.stringify({ date: body.date, zones: body.zones, rows }, null, 2));
    return;
  }
  print(body, rows);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
