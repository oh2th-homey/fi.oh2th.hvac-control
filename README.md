# Smart HVAC Control

Comfort when you need it, heat when it's cheap, no schedules

Smart HVAC Control for Homey Pro decides the temperature of each heating zone from facts:
who is home, holiday, energy prices and the outdoor temperature. There is no weekly schedule to
maintain; flows only tell the app what is going on.

> Status: in development. Not yet in the Homey App Store.

## Setup

1. **Add the HVAC Controller first.** It is required: it holds the shared state for all zones
   (occupancy, season, holiday, price settings and prices). Only one HVAC Controller can be
   added. Zones cannot be added without it.
2. Add a **Heating Zone** for each area you want to control, and choose its members.
3. Feed facts in with flows: occupancy (e.g. from presence or a geofence), and optionally
   energy prices with the **Import prices** action card.

If the HVAC Controller is removed or unavailable, zones keep their last known state for up to
an hour and then fall back to comfort temperatures without price control. Frost protection is
always active.

## Devices

### HVAC Controller

- Occupancy: Present, Coming Home, Away
- Season: heating, cooling, off
- Holiday until a date
- Price model: Rate is highest (short local price peaks), Above average (N % above today's
  average) or Off
- Price resolution: 15 minutes or 60 minutes. Rate is highest needs 15-minute prices; with
  hourly prices the app uses Above average instead.

### Heating Zone

- Comfort heat setpoint and comfort cool setpoint
- Setback 0–5 °C: the eco drop used when away or when the price is high
- Modes: auto, boost, manual (hands off), off
- Shows the zone temperature and humidity, and the reason for every change

## Zone members

- **Controlled devices**: thermostats (any device with a settable target temperature), on/off
  relays and smart plugs, and air conditioners / air-to-air heat pumps (heat, cool, off, and
  fan mode when the device offers it)
- **Climate sensors**: temperature and humidity sensors; the zone uses the average of fresh
  readings

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

To be documented per release: actions (Import prices, Set price model, Set occupancy, Set
season, Set holiday until, Boost zone), conditions and triggers, with example flows.

## Troubleshooting

To be documented per release: reading the zone reason text, prices rejected, member write
failed, controller missing.

## License

GPL-3.0
