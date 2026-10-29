'use strict';

const crypto = require('crypto');
const mainDriver = require('../main-driver');
const pipeline = require('../../lib/pipeline');

const FAULT_VALUE = 4;

/**
 * @description The temperature capability picked for a member, else the device's first (plain one first), or null.
 */
function chooseTemperature(device, picked) {
  if (device.temperatures.some((cap) => cap.id === picked)) return picked;
  return device.temperatures.length ? device.temperatures[0].id : null;
}

module.exports = class zoneDriver extends mainDriver {
  /**
   * @description Pairing: the HVAC Controller must exist; page "select" picks the devices per room, page "configure" sets them up.
   */
  async onPair(session) {
    const state = { name: null, members: [], candidates: null };
    session.setHandler('check_controller', async () => {
      this.homey.app.getController();
      return true;
    });
    this.setSelectionHandlers(session, state);
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
   * @description Repair: edit the members of a running zone with the same two pages.
   */
  async onRepair(session, device) {
    const state = { name: null, members: device.getStoreValue('members') || [], candidates: null };
    this.setSelectionHandlers(session, state);
    session.setHandler('save_members', async ({ members }) => device.onRepairMembers(await this.prepareMembers(members)));
  }

  /**
   * @description Session handlers shared by pair and repair: the selection is kept between the two pages.
   */
  setSelectionHandlers(session, state) {
    session.setHandler('get_selection', async () => {
      if (!state.candidates) state.candidates = await this.homey.app.members.candidates();
      return state;
    });
    // Every change on either page is saved here, so Homey's Continue and Previous buttons lose nothing.
    session.setHandler('select', async ({ name, members }) => {
      // Keep the configuration of devices that stay picked.
      const previous = Object.fromEntries(state.members.map((member) => [member.id, member]));
      state.members = members.map((member) => ({ ...previous[member.id], ...member }));
      if (name !== null && name !== undefined) state.name = name;
      return true;
    });
    session.setHandler('check_selection', async () => {
      this.checkSelection(state.members, state.candidates || []);
      return true;
    });
  }

  /**
   * @description At least one controlled device. On save also: relays that switch on the room temperature need a
   * temperature sensor (an enable switch does not); the relay mode is chosen on the configure page, so not before.
   */
  checkSelection(members, candidates, onSave = false) {
    const byId = Object.fromEntries(candidates.map((device) => [device.id, device]));
    if (!members.some((member) => member.control)) throw new Error(this.homey.__('pair.members.error_no_control'));
    if (!onSave) return;
    const hasTemperature = members.some((member) => member.sensor && byId[member.id] && byId[member.id].temperature);
    const needsSensor = members.some((member) => member.control === 'relay' && member.relayMode !== 'enable');
    if (needsSensor && !hasTemperature) throw new Error(this.homey.__('pair.members.error_relay_sensor'));
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
          contact: !!member.contact && device.contact,
          temperature: device.temperature,
          // Which temperature capability the zone reads, e.g. measure_temperature.local on some thermostats.
          temperatureCap: chooseTemperature(device, member.temperatureCap),
          humidity: device.humidity,
          // How a thermostat is switched off: thermostat_mode, onoff or system_mode; never by its setpoint.
          offSwitch: device.offSwitch,
          step: [1, 0.5, 0.1].includes(member.step) ? member.step : options.step,
          min: options.min,
          max: options.max,
          faultValue: FAULT_VALUE,
          modes: options.modes,
          ecoMode: member.ecoMode === 'fan' && options.modes.includes('fan') ? 'fan' : 'setback',
          invert: !!member.invert,
          relayMode: member.relayMode === 'enable' ? 'enable' : 'thermostat',
          seasonOffMode: member.seasonOffMode === 'fan' && options.modes.includes('fan') ? 'fan' : 'off',
          // A band never set gets the default; an unreadable one (null after JSON) stays invalid and is refused below.
          relayOnBelow: member.relayOnBelow === undefined ? pipeline.RELAY_ON_BELOW : Number(member.relayOnBelow ?? NaN),
          relayOffAt: member.relayOffAt === undefined ? pipeline.RELAY_OFF_AT : Number(member.relayOffAt ?? NaN)
        };
      });

    this.checkSelection(members, Object.values(candidates), true);
    const badBand = members.find((member) => member.control === 'relay' && member.relayMode !== 'enable' && !pipeline.validRelayBand(member.relayOnBelow, member.relayOffAt));
    if (badBand) throw new Error(this.homey.__('pair.members.error_relay_band', { name: badBand.name }));
    return members;
  }
};
