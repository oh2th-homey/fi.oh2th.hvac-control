'use strict';

const { HomeyAPI } = require('homey-api');

const RELAY_CLASSES = ['socket', 'heater', 'other'];

/**
 * Access to other apps' devices (zone members) through the Homey Web API, using only standard capabilities.
 * One instance per app. Values come from capability instances (realtime), writes from setCapabilityValue.
 */
module.exports = class Members {
  /**
   * @param {Object} ctx - Homey App
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.api = null;
    this.instances = {};
  }

  async getApi() {
    if (!this.api) this.api = await HomeyAPI.createAppAPI({ homey: this.ctx.homey });
    return this.api;
  }

  /**
   * @description Devices that can be zone members, grouped info for the pair and repair views.
   * Devices of this app are left out.
   * @returns {Promise<Object[]>} [{ id, name, zone, deviceClass, setpoint, onoff, relay, ac, temperature, humidity, contact, options }]
   */
  async candidates() {
    const api = await this.getApi();
    const [devices, zones] = await Promise.all([api.devices.getDevices(), api.zones.getZones()]);
    const own = `homey:app:${this.ctx.homey.manifest.id}`;
    return Object.values(devices)
      .filter((device) => !String(device.driverId || '').startsWith(own))
      .map((device) => {
        const caps = device.capabilitiesObj || {};
        const target = caps.target_temperature;
        const setpoint = !!(target && target.setable !== false);
        const modes = caps.thermostat_mode && Array.isArray(caps.thermostat_mode.values) ? caps.thermostat_mode.values.map((value) => value.id) : [];
        return {
          id: device.id,
          name: device.name,
          zone: zones[device.zone] ? zones[device.zone].name : '',
          deviceClass: device.class,
          setpoint,
          onoff: !!(caps.onoff && caps.onoff.setable !== false),
          // Relays and plugs: switchable devices without a setpoint, not lights and the like.
          relay: !setpoint && !!(caps.onoff && caps.onoff.setable !== false) && RELAY_CLASSES.includes(device.class),
          ac: setpoint && device.class === 'airconditioning' && modes.length > 0,
          temperature: !!caps.measure_temperature,
          humidity: !!caps.measure_humidity,
          contact: !!caps.alarm_contact,
          options: {
            min: target && typeof target.min === 'number' ? target.min : 5,
            max: target && typeof target.max === 'number' ? target.max : 35,
            step: target && typeof target.step === 'number' ? target.step : 0.5,
            modes
          }
        };
      })
      .filter((device) => device.setpoint || device.relay || device.temperature || device.humidity || device.contact)
      .sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
  }

  /**
   * @description Runtime options of a member's capability (min/max/step, thermostat_mode values).
   * @returns {Promise<Object|null>} capabilitiesObj entry or null
   */
  async capability(deviceId, capabilityId) {
    const api = await this.getApi();
    const device = await api.devices.getDevice({ id: deviceId });
    return (device.capabilitiesObj && device.capabilitiesObj[capabilityId]) || null;
  }

  /**
   * @description Subscribe to a member capability; keeps one realtime instance per device capability.
   * @param {Function} listener - (value) => void, may be null
   */
  async subscribe(deviceId, capabilityId, listener = null) {
    const key = `${deviceId}/${capabilityId}`;
    if (this.instances[key]) {
      if (listener) this.instances[key].listeners.add(listener);
      return;
    }
    const api = await this.getApi();
    const device = await api.devices.getDevice({ id: deviceId });
    if (!device.capabilitiesObj || !device.capabilitiesObj[capabilityId]) throw new Error(`${device.name}: no ${capabilityId}`);
    // The device object is kept up to date by homey-api while an instance is connected; it tells availability.
    const entry = { listeners: new Set(listener ? [listener] : []), instance: null, device, lastUpdated: device.capabilitiesObj[capabilityId].lastUpdated || null };
    entry.instance = device.makeCapabilityInstance(capabilityId, (value) => {
      entry.lastUpdated = new Date();
      for (const fn of entry.listeners) {
        try {
          fn(value);
        } catch (error) {
          this.ctx.error(`members - listener ${key} - ${error}`);
        }
      }
    });
    this.instances[key] = entry;
  }

  /**
   * @description Drop a listener; the realtime instance is destroyed with its last listener.
   */
  unsubscribe(deviceId, capabilityId, listener) {
    const key = `${deviceId}/${capabilityId}`;
    const entry = this.instances[key];
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.instance.destroy();
      delete this.instances[key];
    }
  }

  /**
   * @description Last known value of a subscribed capability.
   * @returns {Object|null} { value, lastUpdated: Date|null, available }
   */
  read(deviceId, capabilityId) {
    const entry = this.instances[`${deviceId}/${capabilityId}`];
    if (!entry) return null;
    const lastUpdated = entry.instance.lastChanged || entry.lastUpdated;
    return { value: entry.instance.value, lastUpdated: lastUpdated ? new Date(lastUpdated) : null, available: entry.device.available !== false };
  }

  async write(deviceId, capabilityId, value) {
    const api = await this.getApi();
    await api.devices.setCapabilityValue({ deviceId, capabilityId, value });
  }
};
