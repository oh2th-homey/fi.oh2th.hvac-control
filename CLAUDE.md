# Heating Zone Controller (fi.oh2th.heat-cntrl)

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

## Ground rules

- Homey Apps SDK v3, Homey Pro only. Needs `homey:manager:api` to read/control other apps' devices.
- Generic first: nothing installation-specific in code. PbtH (Power by the Hour) is optional.
- Inputs are **facts, not modes** (occupancy, holiday, prices, forecast). Never make the user
  translate facts into modes in flows; that is what made Homey Heating Scheduler too complex.
- Few concepts: Heating Zone devices, optional single House device, comfort bands per occupancy
  state, members. Resist adding plans, schedules or mode lists.
- Safety over savings: comfort bands are hard limits, frost floor always enforced, never write
  NaN/out-of-range/wrongly-typed values to devices (some Zigbee thermostats fall back to 4.0 °C).
- Every decision carries a human-readable **reason** string (UI, camera images, notifications).
- Planner and value pipeline are pure functions with unit tests.
- Localisation: en (nl later). Homey does not support Finnish; use only Homey-supported
  languages.
