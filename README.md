# Smart HVAC Control

Smart HVAC Control for Homey Pro sets the temperature of each heating zone. It decides from
three things: whether someone is home, the energy price and the outdoor temperature. There is
no weekly schedule. Your flows only tell the app what is going on.

> Status: test version in the Homey App Store, waiting for approval:
> <https://homey.app/a/fi.oh2th.hvac-control/test/>. Discuss it in the
> [community topic](https://community.homey.app/t/161500).

## How to use

The user guide is in the
[wiki](https://github.com/oh2th-homey/fi.oh2th.hvac-control/wiki): setup, devices, prices,
flow cards, examples and troubleshooting.

In short:

1. Add the **HVAC Controller** (one per Homey). It holds occupancy, season, long absence, prices
   and the outdoor temperature.
2. Add a **Heating Zone** for each room or area, and pick its devices.
3. Make flows that tell the controller who is home, and optionally import energy prices.

## License

GPL-3.0
