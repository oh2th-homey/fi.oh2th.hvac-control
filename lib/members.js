'use strict';

const { HomeyAPI } = require('homey-api');
const { isFahrenheit, toCelsius, toFahrenheit } = require('oh2th-homey-helpers');

const RELAY_CLASSES = ['socket', 'heater', 'other'];
/**
 * @description How a thermostat is switched off and back on, in this order: thermostat_mode (off/heat), onoff,
 * system_mode (off/heat, Zigbee2MQTT; taken as such without a value list). Null when none: never by the setpoint.
 */
function offSwitch(caps) {
  const setable = (id) => caps[id] && caps[id].setable !== false;
  const offAndHeat = (id) => {
    const { values } = caps[id];
    return Array.isArray(values) ? values.some((v) => v.id === 'off') && values.some((v) => v.id === 'heat') : null;
  };
  if (setable('thermostat_mode') && offAndHeat('thermostat_mode')) return 'thermostat_mode';
  if (setable('onoff')) return 'onoff';
  if (setable('system_mode') && offAndHeat('system_mode') !== false) return 'system_mode';
  return null;
}

/**
 * @description Temperature capabilities of a device, the plain one first: [{ id, title }].
 */
function temperatureCapabilities(caps) {
  return Object.keys(caps)
    .filter((id) => /^measure_temperature(\..+)?$/.test(id))
    .sort((a, b) => {
      if (a === 'measure_temperature') return -1;
      if (b === 'measure_temperature') return 1;
      return a.localeCompare(b);
    })
    .map((id) => ({ id, title: (caps[id].title && (caps[id].title.en || caps[id].title)) || id }));
}

/**
 * Access to other apps' devices (zone members) through the Homey Web API, using only standard capabilities.
 * One instance per app. Values come from capability instances (realtime), writes from setCapabilityValue.
 * Temperatures are always °C here: in an imperial home the Web API reports and takes °F, converted at this boundary.
 * Realtime reports can be missed (homey-api serves its cache while connected), so refresh() re-reads every member
 * from Homey each minute and corrects what was missed.
 */
function celsius(value, fahrenheit) {
  return fahrenheit ? toCelsius(value) : value;
}

module.exports = class Members {
  /**
   * @param {Object} ctx - Homey App
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.apiPromise = null;
    this.instances = {};
  }

  async getApi() {
    // One API for all zones, also when they start at the same time.
    if (!this.apiPromise) {
      this.apiPromise = (async () => {
        const api = await HomeyAPI.createAppAPI({ homey: this.ctx.homey });
        // Realtime device events need the devices manager connected first (Athom, SDK issue #262).
        await api.devices.connect();
        return api;
      })().catch((error) => {
        this.apiPromise = null;
        throw error;
      });
    }
    return this.apiPromise;
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
        const fahrenheit = !!target && isFahrenheit(target.units);
        const modes = caps.thermostat_mode && Array.isArray(caps.thermostat_mode.values) ? caps.thermostat_mode.values.map((value) => value.id) : [];
        const temperatures = temperatureCapabilities(caps);
        return {
          id: device.id,
          name: device.name,
          zone: zones[device.zone] ? zones[device.zone].name : '',
          deviceClass: device.class,
          setpoint,
          onoff: !!(caps.onoff && caps.onoff.setable !== false),
          // Relays and plugs: switchable devices without a setpoint, not lights and the like.
          relay: !setpoint && !!(caps.onoff && caps.onoff.setable !== false) && RELAY_CLASSES.includes(device.class),
          // An A/C or heat pump: by its class, or by a thermostat mode that can cool (e.g. Sensibo as class thermostat).
          ac: setpoint && modes.length > 0 && (device.class === 'airconditioning' || modes.includes('cool')),
          temperature: temperatures.length > 0,
          temperatures,
          offSwitch: setpoint ? offSwitch(caps) : null,
          humidity: !!caps.measure_humidity,
          contact: !!caps.alarm_contact,
          options: {
            min: target && typeof target.min === 'number' ? Math.ceil(celsius(target.min, fahrenheit) * 2) / 2 : 5,
            max: target && typeof target.max === 'number' ? Math.floor(celsius(target.max, fahrenheit) * 2) / 2 : 35,
            // A °F step has no exact °C equivalent; the pipeline learns whole degrees if the device needs them.
            step: target && typeof target.step === 'number' && !fahrenheit ? target.step : 0.5,
            modes
          }
        };
      })
      .filter((device) => device.setpoint || device.relay || device.temperature || device.humidity || device.contact)
      .sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
  }

  /**
   * @description How a thermostat member is switched off: 'thermostat_mode', 'onoff', 'system_mode' or null.
   */
  async offSwitch(deviceId) {
    const api = await this.getApi();
    const device = await api.devices.getDevice({ id: deviceId });
    return offSwitch(device.capabilitiesObj || {});
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
    const fahrenheit = isFahrenheit(device.capabilitiesObj[capabilityId].units);
    if (fahrenheit) this.ctx.log(`members - ${device.name} ${capabilityId} is in °F, converting to °C`);
    const capability = device.capabilitiesObj[capabilityId];
    const entry = {
      listeners: new Set(listener ? [listener] : []),
      instance: null,
      device,
      name: device.name,
      capabilityId,
      fahrenheit,
      value: capability.value,
      lastUpdated: capability.lastUpdated ? new Date(capability.lastUpdated) : null,
      available: device.available !== false
    };
    entry.instance = device.makeCapabilityInstance(capabilityId, (value) => {
      entry.value = value;
      entry.lastUpdated = new Date();
      this.notify(entry, key);
    });
    this.instances[key] = entry;
  }

  notify(entry, key) {
    for (const fn of entry.listeners) {
      try {
        fn(celsius(entry.value, this.isFahrenheit(entry)));
      } catch (error) {
        this.ctx.error(`members - listener ${key} - ${error}`);
      }
    }
  }

  /**
   * @description Re-read all subscribed members from Homey (not homey-api's cache): a value that missed its
   * realtime report is corrected and its listeners are called, availability is updated.
   */
  async refresh() {
    if (Object.keys(this.instances).length === 0) return;
    const api = await this.getApi();
    const devices = await api.devices.getDevices({ $cache: false });
    for (const [key, entry] of Object.entries(this.instances)) {
      const device = devices[key.split('/')[0]];
      if (!device) continue;
      entry.available = device.available !== false;
      const capability = device.capabilitiesObj && device.capabilitiesObj[entry.capabilityId];
      if (!capability) continue;
      // The Homey's location can change the reported unit while the app runs.
      if (capability.units) entry.fahrenheit = isFahrenheit(capability.units);
      if (capability.value === entry.value) continue;
      this.ctx.log(`members - ${entry.name} ${entry.capabilityId} missed a report: ${entry.value} => ${capability.value}`);
      entry.value = capability.value;
      entry.lastUpdated = capability.lastUpdated ? new Date(capability.lastUpdated) : new Date();
      this.notify(entry, key);
    }
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
   * @description The Web API reports this capability in °F (set on subscribe, kept current by refresh()).
   */
  isFahrenheit(entry) {
    return entry.fahrenheit === true;
  }

  /**
   * @description True when any subscribed member temperature comes in °F: the home shows °F.
   */
  fahrenheit() {
    return Object.values(this.instances).some((entry) => this.isFahrenheit(entry));
  }

  /**
   * @description Last known value of a subscribed capability.
   * @returns {Object|null} { value, lastUpdated: Date|null, available }
   */
  read(deviceId, capabilityId) {
    const entry = this.instances[`${deviceId}/${capabilityId}`];
    if (!entry) return null;
    return { value: celsius(entry.value, this.isFahrenheit(entry)), lastUpdated: entry.lastUpdated, available: entry.available };
  }

  async write(deviceId, capabilityId, value) {
    const api = await this.getApi();
    const entry = this.instances[`${deviceId}/${capabilityId}`];
    let fahrenheit = entry ? this.isFahrenheit(entry) : false;
    if (!entry && typeof value === 'number') {
      const capability = await this.capability(deviceId, capabilityId);
      fahrenheit = !!capability && isFahrenheit(capability.units);
    }
    await api.devices.setCapabilityValue({ deviceId, capabilityId, value: fahrenheit ? toFahrenheit(value) : value });
  }
};

module.exports.offSwitch = offSwitch;
