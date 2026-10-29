# Setup

1. Add the **HVAC Controller** first. You can add only one, and zones need it. It holds what all
   zones share: occupancy, season, long absence, prices and the outdoor temperature. When you add
   it, you can pick an outdoor temperature sensor.

   <img src="images/controller-outdoor.png" alt="Picking the outdoor temperature sensor" width="300">

2. Add a **Heating Zone** for each room or area, and pick its devices.
3. Make flows that tell the controller who is home (see
   [Follow who is home](How-to#follow-who-is-home)), and optionally flows that import energy
   prices (see [Prices](Prices)).

If the HVAC Controller is removed or unavailable, the zones use its last known state for one
hour. After that they heat to comfort and ignore prices.
