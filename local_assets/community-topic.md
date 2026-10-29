https://homey.app/a/fi.oh2th.hvac-control

Smart HVAC Control sets the temperature of each room from what is going on in your home: whether someone is home, the energy price and the outdoor temperature. There is no weekly schedule to keep up to date. Your flows tell the app the facts, and the app decides comfort or eco for every zone and writes the right setpoint to each device.

It needs permission to manage other devices, so it can read and set your thermostats, relays, smart plugs and air conditioners through their standard capabilities. Homey will ask you to approve this when you install the app.

## Is this the right app for you?

There are several good heating apps for Homey, and many of them are built around schedules, comfort periods and profiles. If you like to plan your heating by the clock, one of those will suit you well.

This app takes a different route. It has no schedule at all: a room is at comfort when someone is home and at eco when nobody is, during a price peak or while a window is open. It also handles cooling, air-to-air heat pumps and heaters on smart plugs, and it works with devices from any app. It fits best if your home already knows who is home, and you would rather describe facts than plan times.

## How it works

The **HVAC Controller** holds what all rooms share: who is home, the season, long absence, the energy prices and the outdoor temperature. Each **Heating Zone** has a comfort and an eco temperature, and picks one of them every time something changes. The zone shows the temperature it aims at and a short reason, for example `Present: comfort`, `Away: eco` or `Window open: eco`.

Setpoints are rounded to what each device really accepts and kept within its limits. If a thermostat falls back to a default value, such as 4 °C, the zone writes its setpoint back at once.

## What you need

- **Something that knows who is home**, such as presence, a geofence or a switch, to feed **Set occupancy** from a flow (required).
- **Devices to control**: thermostats, heaters on smart plugs or relays, air conditioners or air-to-air heat pumps, from any app.
- **Temperature sensors** for rooms heated with relays (optional otherwise).
- **Energy prices** from any price app or script (optional). The prices JSON from Power by the Hour works as it is.
- **An outdoor temperature** (optional), for floors or rooms that only need heat in hard frost.

## Two kinds of devices

- **HVAC Controller** - one per home, add it first. Occupancy, season, mode (Auto, Long absence, Off), price now and expensive now.
- **Heating Zone** - one per room or area. Comfort and eco for heating (and cooling, if the zone has it), Boost, zone mode, Follow home and the reason.

## Setting it up

1. Add the **HVAC Controller**.
2. Add a **Heating Zone** for each room. Pick its devices room by room: thermostats, relays, air conditioners, sensors and door or window contacts. On the second page set the options for each device. Use **Repair** later to change them.
3. Make a flow that sets occupancy: when someone comes home **Set occupancy** to Present, when the last person leaves to Away.
4. Optional: import energy prices with **Import prices**, and feed the outdoor temperature with **Set outdoor temperature**.

## What you'll get

- Comfort when someone is home, eco when nobody is. **Coming Home** warms up before you arrive.
- Eco during short price peaks, or the zone switched off if you prefer.
- Eco when a door or window has been open for a while, back when all are closed.
- **Boost** for a while, **Long absence** until a date, and **Follow home for 24 hours** for a guest room.
- Cooling with air conditioners and heat pumps, fan mode when the zone is in eco or between seasons.
- Heat only when it is cold outside, for floors that are only needed in hard frost.
- Triggers for eco changed, target changed (with the reason) and member write failed, and a problem alarm for low temperature.

The full user guide is in the [README on GitHub](https://github.com/oh2th-homey/fi.oh2th.hvac-control#readme).

## Useful links

- [FAQ and Hints](https://community.homey.app/t/161500/2)
- [TODO](https://community.homey.app/t/161500/3)
- [Known Issues](https://community.homey.app/t/161500/4)

## Contribute

If you enjoy what I do, consider supporting me on [Ko-fi](https://ko-fi.com/oh2th) or [Paypal](https://paypal.com/oh2th)! Every little bit means the world!

[![ko-fi|223x30](upload://vh6y6o5mM9l2Sj7o3WOPK0Ayxqt.svg)](https://ko-fi.com/oh2th)

![PayPal-Monogram-FullColor-RGB|414x500, 5%](upload://nrjCT1wMZJc7DTPGYaR7HSgBjV2.png) [![paypal-donate|92x26](upload://qoBCATwokRptgILQOI1JruUvWLu.png)](https://paypal.me/oh2th)
