# Smart HVAC Control

Smart HVAC Control for Homey Pro sets the temperature of each heating zone. It decides from
three things: whether someone is home, the energy price and the outdoor temperature. There is
no weekly schedule. Your flows only tell the app what is going on.

> Status: test version in the Homey App Store, waiting for approval:
> <https://homey.app/a/fi.oh2th.hvac-control/test/>. Discuss it in the
> [community topic](https://community.homey.app/t/161500).

## Setup

1. Add the **HVAC Controller** first. You can add only one, and zones need it. It holds what all
   zones share: occupancy, season, mode, prices and the outdoor temperature.
2. Add a **Heating Zone** for each room or area, and pick its devices.
3. Make flows that tell the controller who is home, and optionally flows that import energy
   prices and the outdoor temperature.

If the HVAC Controller is removed or unavailable, the zones use its last known state for one
hour. After that they heat to comfort and ignore prices.

## Devices

### HVAC Controller

- **Occupancy**: Present (someone is home), Coming Home (someone is on the way) or Away
  (nobody is home). Set it with the **Set occupancy** card, for example from presence or a
  geofence.
- **Season**: Heating, Cooling or Off.
- **Mode**: Auto, Long absence or Off. Long absence is for trips of several days: all zones go
  to eco and nothing cools. Off stops all heating and cooling.
- **Price now**, in the currency set in the settings (default €).
- **Expensive now**: on during a price peak.
- **Outdoor temperature**, from the **Set outdoor temperature** card. Zones with an outdoor
  limit use it.

Settings: currency, price resolution (15 or 60 minutes), price model, minimum price difference,
percentage for the Above average model, the time of the daily check for tomorrow's prices, and
the last day of a long absence.

### Heating Zone

To add a zone, give it a name and pick its devices room by room. A device can be both a
controlled device and a sensor. On the second page you set options for each device. To change
the devices later, use **Repair** in the zone's device settings.

The zone shows:

- **Comfort heat** (the main dial) and **Eco heat**. Comfort is used when someone is home, eco
  when nobody is home or the price is high. Eco is never warmer than comfort; if you move one past
  the other, both move.
- **Comfort cool** and **Eco cool**, only when **Has cooling** is on in the zone settings. Eco
  cool is never cooler than comfort cool. A zone without cooling switches its devices off in the
  cooling season.
- **Zone mode**: Auto, Manual or Off. In Manual the app leaves the devices alone. Off switches
  the zone's devices off.
- **Boost**: comfort plus the boost amount for the boost time. Press it again to stop early.
- **Target now**: the temperature the zone aims at right now.
- **Follow home**: hours left of a temporary Follow home (see Guests in the guest room).
- The zone temperature and humidity, and a **Reason** that explains what the zone does.

Zone settings:

- **Has cooling** and **Heat all year**. Heat all year keeps heating in the cooling and off
  seasons, for example a bathroom floor.
- **Occupancy**: Follows home, Always eco (for example a guest room) or Always comfort.
- **Low temperature alarm** (default 10 °C, 0 = off).
- **Boost amount** and **Boost time**.
- **Eco after door/window open**: how long a door or window may be open before the zone goes to
  eco (default 2 minutes).
- **Use prices** (in heating and cooling, only one of them, or never) and **When expensive**
  (eco, or switch the zone off).
- **Heat only when cold outside**, with **Heat below** and **Stop above**.
- **Hand change hold time**, **Setpoint hysteresis**, **Relay minimum on and off time** and
  **Sensor timeout**.

### Temperature units

Homey shows the dials and temperatures in °C or °F, depending on the location of your Homey.
The reason texts follow the same unit. Zone settings, the configure page and the values in this
app's flow cards are always in °C.

## Zone devices

A zone can have:

- **Thermostats**: any device with a target temperature. To switch one off, the zone uses the
  first it has of: `thermostat_mode` (off, and heat when heating), the on/off switch, or
  `system_mode` (as on Zigbee2MQTT thermostats). It is found out automatically. The zone never
  lowers the setpoint to mean off; a thermostat with none of these is left as it is and the zone
  says so.
- **Relays and smart plugs** that switch a heater.
- **Air conditioners and air-to-air heat pumps**: heat, cool, off, and fan if the device has
  it.
- **Sensors** for temperature and humidity. The zone uses the average of the sensors that are
  available. If a device has several temperatures, for example a thermostat with
  `measure_temperature.local`, choose which one on the configure page.
- **Windows and doors**: contact sensors.

Options per device, on the configure page:

- **Step**: the setpoint step the device really accepts (1, 0.5 or 0.1 °C). Some thermostats
  say 0.5 but only take whole degrees. The app also notices this from what the device reports.
- **Eco** (air conditioners with fan): use the eco setpoint, or switch to fan.
- **Between seasons** (air conditioners with fan): off or fan while the season is Off.
- **Relay controls**: **Room temperature** switches the relay by the room temperature and the
  relay band. **Heating on/off** is for a heater with its own thermostat: the relay is on at
  comfort and off in eco. No sensor is needed for this.
- **Relay band**: **On below target by** and **Off at target plus**, in °C. With the default 0.3
  and 0.3 and a 21 °C target, the relay switches on at 20.7 °C and off at 21.3 °C. A negative
  off value switches off below the target. Use it for a heater that should only help the main
  heating: on 1.0 and off −0.5 give on at 20.0 °C and off at 20.5 °C.
- **Inverted** (relays): for wiring where relay off means heating.

The app rounds every setpoint to a step the device accepts and keeps it within the device's
limits.

## Prices

Prices are optional. Without them only occupancy decides between comfort and eco.

The app does not read other apps. A flow brings the prices in with the **Import prices** card,
so any price app or script can be the source. The card takes a JSON array of the prices of one
day, from local midnight, in 15- or 60-minute steps. The prices JSON from the Power by the Hour
app works as it is. Choose whether it is today's or tomorrow's prices.

Tomorrow's prices can be partial or missing. Import them again when they are published.

Example with the Power by the Hour app (an advanced flow):

- When **New prices received** for this day, then **Import prices** today's with its Prices
  token.
- When **New prices received** for tomorrow, then **Import prices** tomorrow's with its Prices
  token.
- Every day at 00:05, **Provide import prices JSON** for this day, then **Import prices**
  today's with its Prices token.

Leave **Include forecast prices** off. Forecasts are estimates, not prices.

## Flow cards

Homey gives the standard cards for the standard parts of the devices: the season (thermostat
mode), the price now, the comfort heat dial (target temperature) and Boost (on, off, toggle).
The app adds these:

HVAC Controller

- Actions: **Set occupancy**, **Set mode**, **Set long absence until**, **Set outdoor
  temperature**, **Import prices**, **Set price model** (the percentage is used only by Above
  average).
- Conditions: **Occupancy is**, **Price is expensive**.
- Triggers: **Occupancy changed**, **Mode changed**, **Expensive now changed**, **Prices
  imported**, **Prices missing for tomorrow** (once a day at the check time).

Heating Zone

- Actions: **Set zone mode**, **Boost zone** (for a number of minutes), **Set eco heat**,
  **Set comfort cool**, **Set eco cool**, **Set occupancy rule**, **Follow home for 24 hours**,
  **Use own occupancy setting**.
- Conditions: **Zone mode is**, **Zone is in eco**.
- Triggers: **Eco changed**, **Target changed** (with the reason), **Member write failed**.

## How to

### Follow who is home

- When someone came home, **Set occupancy** to Present.
- When the last person left, **Set occupancy** to Away.
- Optional: when someone is on the way, for example near home by geofence, **Set occupancy** to
  Coming Home.

All zones react at once. Present and Coming Home give comfort, Away gives eco.

### Guests in the guest room

Set the guest room zone's **Occupancy** to Always eco. When guests come, run **Follow home for
24 hours** on that zone. The room then follows who is home like the other rooms. Each run adds
24 hours, so a button flow can extend the stay one day at a time. The zone shows the hours left
under **Follow home**. When the time runs out, or after **Use own occupancy setting**, the room
goes back to Always eco.

### Save on price peaks

1. Import the prices (see Prices).
2. Choose the price model in the controller settings or with **Set price model**:
   - **Rate is highest** (default, needs 15-minute prices): only short peaks of one or two
     quarters count. A price must also be at least the **minimum price difference** (default
     0.005 per kWh) above the local median, so cheap and flat days have no peaks.
   - **Above average**: every quarter more than the percentage (default 30 %) above today's
     average counts.
3. During a peak the controller shows **Expensive now**. Zones that use prices go to eco, or
   off if **When expensive** is Off, and return when the peak ends.

Use **Expensive now changed** or **Price is expensive** for other things that should follow the
price, such as a water heater.

### Heat a room with a heater on a plug or relay

1. In the zone, pick the plug or relay as **Relay** and a temperature sensor in the same room as
   **Sensor**.
2. The zone switches the relay by the relay band around the target. The relay stays on or off
   for at least the **Relay minimum on and off time** (default 5 minutes). In eco the target is
   lower, so the heater stays off until the room cools below it.
3. Without a temperature from an available sensor the relay stays off and the zone shows a
   problem. Set **Sensor timeout** only if you want old readings ignored.

If relay off means heating in your wiring, tick **Inverted** for that relay.

### Use an air conditioner or air-to-air heat pump

1. Pick it as **Air conditioner**, and as **Sensor** if it measures the room.
2. On the configure page, choose **Eco**: the eco setpoint, or fan. With fan, the unit switches
   to fan when the zone goes to eco and back when eco ends. During a long absence it heats at the
   eco setpoint instead, because it may be the main heat source, and uses fan only while the room
   is at least 1 °C above eco.
3. For cooling, turn on **Has cooling** in the zone settings. In the cooling season the unit
   cools to comfort cool, or to eco cool in eco.

If your air conditioner app has fan mode only as its own flow card, use the zone's **Eco
changed** trigger to run that card.

### Save heat while a window is open

Pick the window or door contact as **Window/door** in the zone. When one has been open for the
**Eco after door/window open** time, the zone goes to eco. It returns when all its windows and
doors are closed. Use **Eco changed** if you want a notification.

### Heat a floor only in hard frost

1. Make a flow: when your outdoor sensor's temperature changes, **Set outdoor temperature**.
2. In the zone, pick the floor's relay as **Relay** with **Relay controls: Heating on/off**. The
   floor's own thermostat keeps the temperature.
3. In the zone settings turn on **Heat only when cold outside**, for example heat below −10 °C
   and stop above −8 °C.

### Boost a room

Press **Boost**, or use **Boost zone** in a flow. The zone heats to comfort plus the **Boost
amount** (default 1 °C) for the **Boost time** (default 60 minutes), whatever the occupancy and
price. Press Boost again to stop. Manual and Off also stop a boost.

### Leave for days

Use **Set long absence until** with the last day of the trip, or set the mode to Long absence.
All zones go to eco and nothing cools. Air conditioners set to eco fan keep heating at the eco
setpoint. The day after the given date the mode goes back to Auto.
Set the mode to Auto to end it earlier.

### Control a zone by hand

Set the zone mode to **Manual**, and the app stops writing to the zone's devices. In Auto, a
setpoint changed by hand on a thermostat is put back after the **Hand change hold time**
(default 30 minutes).

### Get an alert when a room gets cold

Set the zone's **Low temperature alarm** (default 10 °C). Below it the zone's problem alarm
turns on. The app does not heat because of it. Use the problem alarm in a flow to send a
notification.

### See why a zone does what it does

Each zone shows a **Reason**, for example:

- `Present: comfort` or `Away: eco`
- `Price peak: eco`
- `Boost 22 °C until 07:25`
- `Window open: eco`
- `Season off; <device>: fan`
- `<device>: set by hand, restoring later`

The HVAC Controller shows the price reason, for example `Normal` or `Peak (over 0.0668)`. The **Target changed** trigger has the reason as a token.

## Troubleshooting

- **"No temperature, off"**: the zone has relays but no working temperature
  sensor. Check that the sensor is available in Homey. With **Sensor timeout** set, a sensor that
  has not reported for that long also counts as missing.
- **"Controller missing"**: the controller is unavailable or
  removed. After one hour the zones heat to comfort, ignore prices and show a problem.
- **Prices rejected**: the controller's reason says why, for example hourly prices while the
  price resolution is 15 minutes. The previous prices are kept.
- **A thermostat does not keep its setpoint, or falls back to 4 °C**: the zone writes it again,
  then tries once with a whole degree. If that fails too, the zone shows a problem, fires
  **Member write failed** and tries again later. If the device only takes whole degrees, set its
  **Step** to 1 in Repair.

## License

GPL-3.0
