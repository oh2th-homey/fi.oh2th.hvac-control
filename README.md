# Smart HVAC Control

Comfort when you need it, heat when it's cheap, no schedules

Smart HVAC Control for Homey Pro decides the temperature of each heating zone from facts:
whether someone is home, energy prices and the outdoor temperature. There is no weekly schedule to
maintain; flows only tell the app what is going on.

> Status: in development. Not yet in the Homey App Store.

## Setup

1. **Add the HVAC Controller first.** It is required: it holds the shared state for all zones
   (occupancy, season, long absence, price settings and prices). Only one HVAC Controller can be
   added. Zones cannot be added without it.
2. Add a **Heating Zone** for each area you want to control, and choose its members.
3. Feed facts in with flows: occupancy (e.g. from presence or a geofence), and optionally
   energy prices with the **Import prices** action card.

If the HVAC Controller is removed or unavailable, zones keep their last known state for up to
an hour and then fall back to comfort temperatures without price control.

## Devices

### HVAC Controller

- Occupancy: Present (someone is home), Coming Home (someone is on the way home) or Away
  (nobody is home). Set it with the **Set occupancy** card from whatever presence source you
  use: presence, a geofence, a switch, anything a flow can see.
- Season: heating, cooling, off
- Mode: Auto, Long absence (everyone away for days, until a date: zones at eco, no cooling) or
  Off (zones stop heating and cooling)
- Price model: Rate is highest (short local price peaks), Above average (N % above today's
  average) or Off
- Price resolution: 15 minutes or 60 minutes. Rate is highest needs 15-minute prices; with
  hourly prices the app uses Above average instead.

### Heating Zone

Add one per area. Adding it has two pages: first name the zone and pick its devices room by
room (a device can be both controlled and a sensor); then configure the picked devices. Change
them later with **Repair** in the zone's device settings, which shows the same two pages.

- Comfort heat setpoint (the main dial) and, when **Has cooling** is on in the zone settings,
  a comfort cool setpoint (second dial). Without cooling the zone's members are off in the
  cooling season
- Setback 0–5 °C: the eco drop used when away or when the price is high
- Zone mode: Auto, Manual (hands off: you control the members) and Off (members off: air
  conditioners and relays off, thermostats at their lowest setpoint)
- Low temperature alarm: the zone problem alarm turns on below a set temperature (zone setting)
- Boost button: comfort plus the boost amount for the boost time, then back to normal. Press it
  again to end the boost early
- Target now: the temperature the zone aims at right now (read-only)
- Shows the zone temperature and humidity, and the reason for every change

## Zone members

- **Controlled devices**: thermostats (any device with a settable target temperature), on/off
  relays and smart plugs, and air conditioners / air-to-air heat pumps (heat, cool, off, and
  fan mode when the device offers it)
- **Climate sensors**: temperature and humidity sensors; the zone uses the average of the
  sensors that are available in Homey

Per device, when picking members:

- **Step**: the setpoint step the device really accepts (1, 0.5 or 0.1 °C). Some thermostats
  claim 0.5 but only take whole degrees; the app also learns this from what the device reports.
- **Eco** (air conditioners with a fan mode): setback (lower setpoint) or fan mode.
- **Inverted** (relays): for wiring where relay off means heating.

Setpoints are always rounded to what each device accepts and kept within its own limits, so
devices never receive values they cannot handle.

## Prices

Prices are optional. Without them, occupancy alone decides between comfort and eco.

The app does not read other apps. Your flow brings the prices in with the **Import prices**
action card, so any energy price app (or a script) can be the source: put its price token into
the card and choose whether it is today's or tomorrow's prices. The token must be a JSON array
of quarter-hour (or hourly) rates for one day, starting at local midnight. From these the app
works out the current price and the day's lowest, highest, average and median price itself.
Tomorrow's prices may be partial or missing; import them again when they are published.

Example with the Power by the Hour app:

- When: Power by the Hour, new prices received (or every day at 00:05)
- Then: Power by the Hour, get prices as JSON
- Then: Import prices, today = the "this day" token
- Then: Import prices, tomorrow = the "tomorrow" token

## Flow cards

Where a device uses a standard Homey capability, Homey provides its cards: the season is the
thermostat mode (Heating, Cooling, Off), the price now has price triggers, the comfort heat dial
is the target temperature, and Boost has enable, disable and toggle cards. The app adds:

HVAC Controller:

- Actions: **Set occupancy**, **Set mode** (Auto, Long absence, Off), **Set long absence until**
  a date, **Import prices** (today's or tomorrow's), **Set price model** (with an optional
  percentage for Above average)
- Conditions: occupancy is, price is expensive now
- Triggers: occupancy changed, mode changed, expensive now changed, prices imported, prices
  missing for tomorrow (daily at the check time in the controller settings)

Heating Zone:

- Actions: **Set zone mode** (Auto, Manual, Off), **Boost zone** for a number of minutes,
  **Set comfort cool** (zones with cooling), **Set setback**
- Conditions: zone mode is, zone is in eco
- Triggers: eco changed, target changed (with the reason), member write failed

Example: occupancy from presence

- When: someone came home → Then: Set occupancy to Present
- When: the last person left → Then: Set occupancy to Away

Example: an air conditioner whose app keeps fan mode in its own flow cards

- When: Eco changed (the zone) → And: Eco is on → Then: the air conditioner app's fan mode action

## How to

### Follow who is home

Feed occupancy from any presence source you already have:

- When: someone came home → Then: **Set occupancy** to Present
- When: the last person left → Then: **Set occupancy** to Away
- Optional, when someone is on the way (for example a geofence a few kilometres out): **Set
  occupancy** to Coming Home

Every zone re-evaluates at once. Present and Coming Home aim at comfort, Away at eco (comfort
minus setback). A guest room that should stay at eco until you boost it: set the zone's
**Occupancy** setting to Always eco.

### Save on expensive price peaks

1. Import today's and tomorrow's prices with **Import prices** (see Prices above). Run the
   import again when tomorrow's prices are published; a longer import replaces a partial one.
2. Pick the price model in the HVAC Controller settings, or with **Set price model**:
   - **Rate is highest** (default, needs 15-minute prices): only short local peaks of one or two
     quarters count as expensive. Cheap and flat days are not flagged: a price must also be at
     least the **minimum price difference** (default 0.005 per kWh) above the local median.
   - **Above average**: every quarter more than the percentage (default 30 %) above today's
     average counts as expensive.
3. When a quarter is expensive, the controller shows **Expensive now** and every zone where
   someone is home drops to eco for that quarter, then returns to comfort. Zones that are
   already at eco (Away) do not change.

To avoid needless writes to battery thermostats, a price change waits for the zone's
**Minimum hold time** (default 30 minutes) after the last write to a thermostat. Occupancy, mode
and setpoint changes are written at once. On/off relays switch on their own schedule (see
below).

Use the trigger **Expensive now changed** or the condition **Price is expensive now** for
anything else that should follow the price, such as a water heater.

### Heat a room with a heater on a smart plug or relay

1. Add a Heating Zone and pick the plug or relay as **Relay** and a temperature sensor in the
   same room as **Sensor**. A zone with relays needs at least one temperature sensor.
2. The zone switches the relay on below target minus the **Relay hysteresis** (default 0.3 °C)
   and off above target plus it, with a **minimum on and off time** (default 5 minutes).
3. Without a temperature from an available sensor, the relay stays off and the zone shows a
   problem. A sensor that only reports when its value changes is fine; set **Sensor timeout**
   only if you want old readings ignored.

Wiring where relay off means heating: tick **Inverted** for that relay on the configure page.

### Use an air conditioner or air-to-air heat pump

1. Pick it as **Air conditioner** (and as **Sensor** if it measures the room).
2. On the configure page choose **Eco**: Setback (a lower setpoint) or Fan mode (only shown when
   the device has a fan mode). With Fan mode the unit switches to fan when the zone goes to eco
   and back to heat (or cool) when eco ends.
3. For cooling, turn on **Has cooling** in the zone settings: the zone gets a Comfort cool
   dial, and in the cooling season the unit cools to comfort cool, or comfort cool plus setback
   in eco.

If your air conditioner app keeps fan mode in its own flow cards only, use the zone trigger
**Eco changed** to run that card yourself.

### Boost a room for a while

Press **Boost** on the zone, or use **Boost zone** in a flow with a number of minutes. The zone
heats to comfort plus the **Boost amount** (default 1 °C) for the **Boost time** (default 60
minutes), whatever the occupancy and price, and then returns to normal. Press Boost again to end
it early. Setting the zone to Manual or Off also ends a boost.

### Leave for days

Use **Set long absence until** with the last day of your trip, or set the controller's mode to
Long absence. All zones go to eco and cooling is off; on the day after the given date the mode
returns to Auto by itself. Setting the mode back to Auto ends it early.

### Take a zone over by hand

Set the zone mode to **Manual**: the app stops writing to that zone's devices and you control
them yourself. In Auto, a setpoint changed by hand on a thermostat is put back at the next write,
after the minimum hold time; use Manual or Boost instead.

### Get alerted when a room gets cold

Set the zone's **Low temperature alarm** (default 5 °C, 0 = off). Below it the zone's problem
alarm turns on in every mode; the app does not heat for it. Use the zone's problem alarm in a
flow to send a notification.

### See why a zone does what it does

Every zone shows a **Reason**, for example:

- `Present: comfort` or `Away: eco`
- `Present: comfort; price expensive: eco` during an expensive quarter
- `Boost to 22 °C until 07:25`
- `Long absence: eco`, `Zone off: members off`
- `<device>: waiting for the minimum hold time before writing 19 °C`

The HVAC Controller shows the price reason, for example `Expensive: 0.1050 is a short price
peak (threshold 0.0668)`. The trigger **Target changed** has the reason as a token for
notifications.

## Troubleshooting

- **A zone with relays shows a problem: "no temperature from an available sensor"**: the zone
  has no temperature sensor, or its sensor is unavailable in Homey. If you set **Sensor
  timeout**, a sensor that has not reported for that long also counts as missing.
- **"HVAC Controller missing, using its last known state"**: the controller is unavailable or
  removed. After an hour the zones go to comfort without price control and show a problem.
- **Prices rejected**: the controller's reason tells why, for example a count that fits hourly
  prices while the price resolution is 15 minutes. The previous prices are kept.
- **A thermostat keeps getting the same value back, or reports 4 °C**: the zone retries once
  with a whole degree, then marks the device as failed, fires **Member write failed** and
  retries later. If the device only accepts whole degrees, set its **Step** to 1 in Repair.

## License

GPL-3.0
