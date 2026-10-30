'use strict';

const { HomeyAPI } = require('homey-api');
const { isFahrenheit, toCelsius, toFahrenheit } = require('oh2th-homey-helpers');

// Only devices of these classes are offered, so an appliance (fridge, oven, boiler, car) can't be picked by mistake.
const THERMOSTAT_CLASSES = ['thermostat', 'heater', 'radiator', 'airconditioning', 'heatpump', 'other'];
const RELAY_CLASSES = ['socket', 'heater', 'radiator', 'relay', 'other'];
const SENSOR_CLASSES = [...THERMOSTAT_CLASSES, 'sensor', 'fan', 'airpurifier', 'airtreatment', 'dehumidifier', 'humidifier'];
const AC_CLASSES = ['airconditioning', 'heatpump'];
const AC_MODES = ['fan', 'dry'];
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
 * @description An A/C or heat pump: by its class, or by an A/C-only mode (fan, dry). Not by 'cool': the standard
 * thermostat_mode lists auto, heat, cool and off on plain heating thermostats too.
 */
function isAirConditioner(deviceClass, modes) {
  return modes.length > 0 && (AC_CLASSES.includes(deviceClass) || modes.some((mode) => AC_MODES.includes(mode)));
}

/**
 * @description Temperature capabilities of a device: [{ id, title, reading }]. The reading is the current value as Homey
 * shows it (e.g. "−7.5 °C", or °F in an imperial home), shown in the pairing lists. Ones with a value come first, then
 * the plain measure_temperature: some Zigbee2MQTT thermostats leave it empty and report in measure_temperature.local,
 * and the first one is the default choice.
 */
function temperatureCapabilities(caps) {
  return Object.keys(caps)
    .filter((id) => /^measure_temperature(\..+)?$/.test(id))
    .map((id) => {
      const { value, units, decimals } = caps[id];
      const shown = typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(Number.isInteger(decimals) ? decimals : 1)) : null;
      const reading = shown === null ? null : `${shown}${units ? ` ${units}` : ''}`;
      return { id, title: (caps[id].title && (caps[id].title.en || caps[id].title)) || id, reading };
    })
    .sort((a, b) => {
      if (!a.reading !== !b.reading) return a.reading ? -1 : 1;
      if (a.id === 'measure_temperature') return -1;
      if (b.id === 'measure_temperature') return 1;
      return a.id.localeCompare(b.id);
    });
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
    // Fresh from Homey: homey-api's cache can miss devices added or re-paired while the app runs.
    const [devices, zones] = await Promise.all([api.devices.getDevices({ $cache: false }), api.zones.getZones({ $cache: false })]);
    const own = `homey:app:${this.ctx.homey.manifest.id}`;
    return Object.values(devices)
      .filter((device) => !String(device.driverId || '').startsWith(own))
      .map((device) => {
        const caps = device.capabilitiesObj || {};
        const target = caps.target_temperature;
        const setpoint = !!(target && target.setable !== false) && THERMOSTAT_CLASSES.includes(device.class);
        const fahrenheit = !!target && isFahrenheit(target.units);
        const modes = caps.thermostat_mode && Array.isArray(caps.thermostat_mode.values) ? caps.thermostat_mode.values.map((value) => value.id) : [];
        const temperatures = SENSOR_CLASSES.includes(device.class) ? temperatureCapabilities(caps) : [];
        return {
          id: device.id,
          name: device.name,
          zone: zones[device.zone] ? zones[device.zone].name : '',
          deviceClass: device.class,
          setpoint,
          onoff: !!(caps.onoff && caps.onoff.setable !== false),
          // Relays and plugs: switchable devices without a setpoint, not lights and the like.
          relay: !setpoint && !!(caps.onoff && caps.onoff.setable !== false) && RELAY_CLASSES.includes(device.class),
          ac: setpoint && isAirConditioner(device.class, modes),
          temperature: temperatures.length > 0,
          temperatures,
          offSwitch: setpoint ? offSwitch(caps) : null,
          humidity: !!caps.measure_humidity && SENSOR_CLASSES.includes(device.class),
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
module.exports.isAirConditioner = isAirConditioner;
module.exports.temperatureCapabilities = temperatureCapabilities;
