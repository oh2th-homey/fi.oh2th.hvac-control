# Flow cards

Homey gives the standard cards for the standard parts of the devices: the season (thermostat
mode), the price now and Boost (on, off, toggle). The app adds these:

## HVAC Controller

- Actions: **Set occupancy**, **Set long absence until**, **End long absence**, **Import
  prices**.
- Conditions: **Occupancy is**, **Long absence is on**, **Price is expensive**.
- Triggers: **Occupancy changed**, **Long absence changed**, **Expensive now changed**, **Prices
  imported**, **Prices missing for tomorrow** (once a day at the check time). The **Occupancy
  changed** token is `present`, `coming_home` or `away`.

## Heating Zone

- Actions: **Set zone mode**, **Boost zone** (for a number of minutes), **Set comfort heat**,
  **Set eco heat**, **Set comfort cool**, **Set eco cool**, **Follow home for 24 hours**, **Use own
  occupancy setting**.
- Conditions: **Zone mode is**, **Zone is in eco**.
- Triggers: **Eco changed**, **Target changed** (with the reason), **Member write failed**.
