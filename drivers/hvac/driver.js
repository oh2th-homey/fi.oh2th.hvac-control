'use strict';

const mainDriver = require('../main-driver');

module.exports = class hvacDriver extends mainDriver {
  /**
   * @description Pairing: exactly one HVAC Controller, with an optional outdoor temperature sensor.
   */
  async onPair(session) {
    session.setHandler('get_outdoor', async () => {
      if (this.getDevices().length > 0) throw new Error(this.homey.__('pair.hvac_exists'));
      return { sensors: await this.outdoorSensors(), outdoor: null, repair: false };
    });
    session.setHandler('create_controller', async ({ outdoor }) => {
      if (this.getDevices().length > 0) throw new Error(this.homey.__('pair.hvac_exists'));
      return { name: this.homey.__('pair.hvac_name'), data: { id: 'hvac-controller' }, store: { outdoor: await this.checkOutdoor(outdoor) } };
    });
  }

  /**
   * @description Repair: change the outdoor temperature sensor.
   */
  async onRepair(session, device) {
    session.setHandler('get_outdoor', async () => ({ sensors: await this.outdoorSensors(), outdoor: device.getStoreValue('outdoor') || null, repair: true }));
    session.setHandler('save_outdoor', async ({ outdoor }) => device.onRepairOutdoor(await this.checkOutdoor(outdoor)));
  }

  /**
   * @description Devices with a temperature (sub-capabilities included): [{ id, name, zone, temperatures }].
   */
  async outdoorSensors() {
    const candidates = await this.homey.app.members.candidates();
    const sensors = candidates.filter((device) => device.temperatures.length > 0).map(({ id, name, zone, temperatures }) => ({ id, name, zone, temperatures }));
    this.log(`outdoorSensors - ${sensors.length} of ${candidates.length} devices: ${sensors.map((sensor) => sensor.name).join(', ')}`);
    return sensors;
  }

  /**
   * @description The picked sensor { id, cap, name }, or null for none; the capability must exist on the device.
   */
  async checkOutdoor(outdoor) {
    if (!outdoor || !outdoor.id) return null;
    const sensor = (await this.outdoorSensors()).find((device) => device.id === outdoor.id);
    if (!sensor) return null;
    const cap = sensor.temperatures.some((t) => t.id === outdoor.cap) ? outdoor.cap : sensor.temperatures[0].id;
    return { id: sensor.id, cap, name: sensor.name };
  }
};
