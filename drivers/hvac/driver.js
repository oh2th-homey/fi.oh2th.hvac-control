'use strict';

const mainDriver = require('../main-driver');

module.exports = class hvacDriver extends mainDriver {
  /**
   * @description Pairing offers exactly one HVAC Controller.
   */
  async onPair(session) {
    session.setHandler('list_devices', async () => {
      if (this.getDevices().length > 0) throw new Error(this.homey.__('pair.hvac_exists'));
      return [{ name: this.homey.__('pair.hvac_name'), data: { id: 'hvac-controller' } }];
    });
  }
};
