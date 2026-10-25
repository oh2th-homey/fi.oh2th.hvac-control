'use strict';

const crypto = require('crypto');
const mainDriver = require('../main-driver');

const FAULT_VALUE = 4;

module.exports = class zoneDriver extends mainDriver {
  /**
   * @description Pairing: the HVAC Controller must exist; members are picked in the members view.
   */
  async onPair(session) {
    session.setHandler('check_controller', async () => {
      this.homey.app.getController();
      return true;
    });
    session.setHandler('get_candidates', async () => this.homey.app.members.candidates());
    session.setHandler('create_zone', async ({ name, members }) => {
      this.homey.app.getController();
      return {
        name,
        data: { id: `zone-${crypto.randomUUID()}` },
        store: { members: await this.prepareMembers(members) }
      };
    });
  }

  /**
   * @description Repair: edit the member list of a running zone.
   */
  async onRepair(session, device) {
    session.setHandler('get_members', async () => device.getStoreValue('members') || []);
    session.setHandler('get_candidates', async () => this.homey.app.members.candidates());
    session.setHandler('save_members', async ({ members }) => device.onRepairMembers(await this.prepareMembers(members)));
  }

  /**
   * @description Validate the picked members and fill limits from each device's runtime options.
   * @returns {Promise<Object[]>} members for the device store
   */
  async prepareMembers(picked) {
    const candidates = Object.fromEntries((await this.homey.app.members.candidates()).map((device) => [device.id, device]));
    const members = (picked || [])
      .filter((member) => candidates[member.id])
      .map((member) => {
        const device = candidates[member.id];
        const { options } = device;
        return {
          id: member.id,
          name: device.name,
          control: ['thermostat', 'ac', 'relay'].includes(member.control) ? member.control : null,
          sensor: !!member.sensor && (device.temperature || device.humidity),
          temperature: device.temperature,
          humidity: device.humidity,
          step: [1, 0.5, 0.1].includes(member.step) ? member.step : options.step,
          offset: Math.min(5, Math.max(-5, Number(member.offset) || 0)),
          min: options.min,
          max: options.max,
          faultValue: FAULT_VALUE,
          modes: options.modes,
          ecoMode: member.ecoMode === 'fan' && options.modes.includes('fan') ? 'fan' : 'setback',
          invert: !!member.invert
        };
      });

    if (!members.some((member) => member.control)) throw new Error(this.homey.__('pair.members.error_no_control'));
    if (members.some((member) => member.control === 'relay') && !members.some((member) => member.sensor && member.temperature)) {
      throw new Error(this.homey.__('pair.members.error_relay_sensor'));
    }
    return members;
  }
};
