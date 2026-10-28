# Smart HVAC Control (fi.oh2th.hvac-control)

Generic Homey Pro (SDK3) app that replaces complex heating flows. It decides each zone's
temperature from **occupancy, energy prices and outdoor temperature/forecast**. There is
**no fixed weekly schedule**. Flows only feed facts into the app.

Local design notes and environment details live in `CLAUDE.local.md` (not in the repo).

## Public repository: no local or personal information

This repo goes to GitHub. Never commit, in code, tests, fixtures, comments, commit messages or
docs: Homey names or IDs, device/flow/zone IDs, home or room names tied to a real house,
addresses, geofence names, people's names, e-mail addresses, tokens or API keys.
Test fixtures captured from a real Homey must be anonymised first. Local-only files are listed
in `.gitignore`; check `git status` before every commit.

## Homey App Store guidelines

Follow <https://apps.developer.homey.app/app-store/guidelines> (checked 2026-10-25). Key points:

- Name max 4 words, no Homey/Athom, no protocol names. Description: catchy one-liner, not
  repeating the name or readme, no "adds support for" phrasing.
- `README.md` (GitHub) is the **user instructions / how to use**: setup order, devices, settings,
  flow cards, example flows, troubleshooting. Update it in the same change as any user-visible
  feature. `README.txt` is only the store blurb.
- `README.txt`: 1–2 plain-text paragraphs, no Markdown, headers, URLs, feature lists or changelog.
  Links go in the manifest; changelog via `.homeychangelog.json` at publish time.
- App images: jpg/png, small 250×175 + large 500×350 (xlarge 1000×700 optional), lively/lifestyle,
  no icons on flat backgrounds, no generic AI art, no Homey logo/devices. Driver images 75×75 +
  500×500 on white. Icons: 960×960 line drawings, transparent, no fills/gradients; one unique icon
  per driver. `brandColor` mandatory and icons must stay visible on it.
- Widgets: light + dark previews, 1024×1024, transparent, no text or screenshots.
- `homey:manager:api` must be justified (this app automates other apps' devices; say so in the
  submission). Request no other permissions without a core need.
- Core must work standalone: other apps (e.g. PbtH) are optional inputs, never required.
- Flow card titles: short, no device names, no "When/And/Then", no parentheses; use
  `titleFormatted` for arguments and `hint` when not obvious.
- Every user-facing string (flow cards, settings, capabilities, errors) localised; English
  required, no partial translations, no typos.
- Free for everyone, no paywalls; donations via manifest only. Credit borrowed code in manifest.
- Similar apps exist (see design notes): the submission must explain why this is a separate app.

## Code style (follow the author's other Homey apps)

Reference apps (all public in GitHub org `oh2th-homey`): `com.go-e.charger` (devices,
capabilities, polling), `fi.oh2th.aprs-is` (flow actions, helpers with a context argument),
`fi.oh2th.alarmutils` (one app-level minute tick driving devices), `fi.oh2th.energy-allocator`
(`homey-api` `HomeyAPI.createAppAPI` to read other apps' devices, Homey timers).
Plain JavaScript, `'use strict';`, CommonJS.

### Shared helpers package

Generic helpers live in `oh2th-homey-helpers` (repo `../fi.oh2th.homey-helpers`, see its README):
`sleep`, `startMinuteInterval` / `stopMinuteInterval` / `dispatchInterval` / `forEachDevice`,
`checkCapabilities` / `updateCapabilities`, `setValue`, `localTime` / `strToMins` / `minsToStr`,
`localDate` / `addDays` / `midnight` / `utcOffset` / `isDate` / `isTime`, temperature units
(`formatTemperature`, `formatDifference`, `toCelsius`, `toFahrenheit`, `isFahrenheit`, `isImperial`),
`serialize` (one run at a time).
Use them instead of copying. When new code here could be generic (useful to other Homey apps),
suggest moving it to the helpers package (with a test) rather than keeping it in this app's
`lib/`; the author decides. Installed as a real copy (`.npmrc` `install-links=true`) from
`file:../fi.oh2th.homey-helpers`; switch to a tagged `github:` dependency before publishing.
Never use `Date.getHours()` etc. for local time on Homey (it is UTC); use `localTime(ctx)`.

### Repo layout

```text
app.js                      thin: log start, init flow cards from lib/flows/*, the one app interval
drivers/main-driver.js      shared Driver base class
drivers/main-device.js      shared Device base class: lifecycle, listeners, setValue, polling
drivers/<id>/device.js      `class extends mainDevice {}`, overrides only what differs
drivers/<id>/driver.js      `class extends mainDriver {}`
drivers/<id>/driver.compose.json   name + "$extends" of templates
drivers/<id>/pair/*.html
lib/helpers.js              app-specific helpers only (generic ones: oh2th-homey-helpers)
lib/flows/actions.js        exports.init(ctx): register action run listeners
lib/flows/conditions.js     exports.init(ctx): register condition run listeners
lib/<name>.js               one class per external API/protocol, plus pure logic modules
.homeycompose/app.json, capabilities/*.json, flow/{actions,conditions,triggers}/*.json,
.homeycompose/drivers/templates/*.json   (device.json, settings.json, pair-*.json)
locales/en.json, assets/, local_assets/ (sources, listed in .homeyignore), .github/FUNDING.yml
```

Lint/format: `.eslintrc.json` extends `athom` (same relaxed rule set as go-e), `.prettierrc`
2 spaces, single quotes, semicolons, printWidth 200, no trailing commas.

### Device lifecycle (main-device.js)

`onInit`: `setUnavailable('Initializing …')` → read settings / create lib client →
`checkCapabilities` → `setCapabilityListeners` → `setCapabilityValues(true)` → `setAvailable`.
No device interval: periodic work runs from `onInterval(now)`, called by the app (see Timers).
`onDeleted` (and `onUninit`) clear any pending timeouts. Keep the JSDoc stubs for
`onAdded`, `onSettings({ oldSettings, newSettings, changedKeys })`, `onRenamed`, `onDeleted`.

### Capabilities

- `setCapabilityListeners()` only registers:
  `this.registerCapabilityListener('<cap>', this.onCapability_<UPPER_SNAKE>.bind(this));`
- `async onCapability_<UPPER_SNAKE>(value)`: log, skip if equal to current value, translate and
  send to the device/lib, `try { return Promise.resolve(await …) } catch (error) { return Promise.reject(error) }`.
  Flow actions that do the same thing call these methods; don't duplicate logic.
- `setCapabilityValues(check = false)`: read state (poll), map each field with
  `await this.setValue(key, value, check)`; on error `setUnavailable(error)` and log.
- `setValue(key, value, firstRun = false, delay = 10)`: only if `hasCapability(key)`, log when
  changed, `setCapabilityValue(…).catch(this.error)`. On change and not `firstRun`, fire the
  device trigger `<key>_changed` (dots → underscores) for `is_*` booleans and `num_*` numbers when
  that trigger exists in `this.homey.manifest.flow.triggers`, token `{ [key]: value }`.
- `checkCapabilities(ctx)` / `updateCapabilities(ctx, driverCaps, deviceCaps)` (helpers package):
  diff the driver manifest against the device, remove old then add new caps with short sleeps,
  so changing `driver.compose.json` upgrades existing devices. Await it in `onInit`.

### Flow cards

- `lib/flows/actions.js`: `exports.init = async function (ctx) { … }` with ctx = the app.
  Per card: `const onAction_<UPPER_SNAKE> = ctx.homey.flow.getActionCard('<id>');` and
  `registerRunListener(async (args, state) => args.device.onAction_<UPPER_SNAKE>(args…))`.
- Device handlers: `async onAction_<UPPER_SNAKE>(value|args)` with a JSDoc `@description` line.
- Conditions in `lib/flows/conditions.js` the same way, returning a boolean.
- Card JSON: `title`, `titleFormatted`, `hint`, `args` (device arg with `driver_id=` filter), `tokens`.
- Standard capabilities get their flow cards from Homey: never add a card that duplicates or
  overrides one (same id or same purpose). Add own cards only for custom capabilities and for
  what Homey's cards can't do (e.g. Boost for N minutes, triggers with a reason token).

### Timers: one interval, always Homey's

- **One interval in the whole app**, owned by `app.js` via `startMinuteInterval(this, tick)`
  and `dispatchInterval(this, now)` from the helpers package: `this.homey.setInterval`, aligned to
  the start of the minute (initial `this.homey.setTimeout` to the next :00, as aprs-is
  `startInterval` does). Each tick calls the app's own periodic work and then
  `onInterval(now)` on every device of every driver
  (`this.homey.drivers.getDrivers()` → `driver.getDevices()`), each call caught so one failing
  device can't stop the others. Pass the same `now` to all.
- Drivers/devices never create intervals. A device implements `async onInterval(now)` and decides
  itself what is due, e.g. `if (now.getMinutes() % 15 === 0) …` for the planner, or its own
  "last run" timestamp for odd periods. Keep `onInterval` quick; long work is awaited per device.
- One-shot delays (write verify timeout, retry backoff, `sleep()`) use `this.homey.setTimeout`;
  store the handle and clear it in `onDeleted`/`onUninit`.
- Never the global `setTimeout`/`setInterval`, including in `sleep()`:
  `new Promise((resolve) => ctx.homey.setTimeout(resolve, ms))`. (The reference apps still use
  globals and per-device intervals; don't copy that.)

### Logging

Device: ``this.log(`${this.getName()} - <method> - <detail>`)``. App: `${this.homey.manifest.id}/${version}`.
Use `this.homey.manifest`, not `Homey.manifest`. Don't write `.then(this.log(…))` (it logs
immediately); use `.then(() => this.log(…))`.

## Ground rules

- Homey Apps SDK v3, Homey Pro only. Needs `homey:manager:api` to read/control other apps' devices.
- Generic first: nothing installation-specific in code.
- No dependency on any specific app, PbtH (Power by the Hour) included: no app-specific code
  paths, names, capability lists or settings. The app never calls another app's flow cards;
  users build the flows they need (our triggers → their app's actions). Member
  devices (thermostats, relays, A/C, sensors) are read and written only through standard
  Homey capabilities, whatever app owns them. Data sources such as prices come in only as
  tokens on this app's own action cards (e.g. Import prices takes a JSON text token). Other
  apps may appear in README examples only.
- Inputs are **facts, not modes** (occupancy, long absence, prices, forecast). Never make the user
  translate facts into modes in flows; that is what made Homey Heating Scheduler too complex.
- Few concepts: Heating Zone devices, one required HVAC Controller device (shared state), per zone
  comfort and eco setpoints for heat (and cool), members. Eco is a setpoint, not a difference.
  Resist adding plans, schedules or mode lists.
- Safety over savings: the band between comfort and eco is a hard limit, never write NaN/out-of-range/wrongly-typed values to devices (some Zigbee
  thermostats fall back to 4.0 °C).
- Every decision carries a human-readable **reason** string (UI, camera images, notifications).
- Planner and value pipeline are pure functions with unit tests.
- Localisation: en (nl later). Homey does not support Finnish; use only Homey-supported
  languages.
