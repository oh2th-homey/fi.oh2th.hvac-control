'use strict';

const Homey = require('homey');
const { startMinuteInterval, stopMinuteInterval, dispatchInterval, forEachDevice, isImperial, localDate, localTime } = require('oh2th-homey-helpers');
const flowActions = require('./lib/flows/actions');
const flowConditions = require('./lib/flows/conditions');
const Members = require('./lib/members');
const { History, QUARTER_MS } = require('./lib/history');

module.exports = class HvacControlApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log(`${this.homey.manifest.id}/${this.homey.manifest.version} - onInit - units ${this.homey.i18n.getUnits()}, language ${this.homey.i18n.getLanguage()}`);

    // Other apps' devices (zone members), through the Homey Web API.
    this.members = new Members(this);
    // Quarter-hour history on disk for learning and replay.
    this.history = new History(this);

    await flowActions.init(this);
    await flowConditions.init(this);

    this.appInterval = startMinuteInterval(this, async (now) => this.onInterval(now));
  }

  async onUninit() {
    stopMinuteInterval(this, this.appInterval);
  }

  /**
   * @description The one app interval: app-level work, then onInterval(now) on every device.
   */
  async onInterval(now) {
    await this.members.refresh().catch((error) => this.error(`onInterval - members refresh - ${error}`));
    // Before the devices evaluate the new quarter, so the row has the state of the quarter that ended.
    if (localTime(this, now).minutes % 15 === 0) await this.recordHistory(now).catch((error) => this.error(`onInterval - history - ${error}`));
    await dispatchInterval(this, now);
  }

  /**
   * @description Append the quarter that just ended to the history: controller state and every zone's sample.
   */
  async recordHistory(now) {
    const quarter = (Math.round(now.getTime() / QUARTER_MS) - 1) * QUARTER_MS;
    const timeZone = this.homey.clock.getTimezone();
    const controller = this.findController();
    const shared = controller ? controller.getSharedState() : {};
    const zones = [];
    for (const zone of this.homey.drivers.getDriver('zone').getDevices()) {
      if (typeof zone.historySample !== 'function') continue;
      zones.push({ slot: await this.history.slot(zone.getData().id, zone.getName()), ...zone.historySample(now.getTime()) });
    }
    const date = localDate(timeZone, quarter);
    await this.history.append(date, {
      quarter,
      outdoor: shared.outdoor,
      price: shared.price,
      occupancy: shared.occupancy,
      season: shared.season,
      longAbsence: shared.longAbsence,
      expensive: shared.expensive,
      zones
    });
    // The first quarter of a day: drop the files older than two weeks.
    if (localDate(timeZone, now.getTime()) !== date) await this.history.prune(localDate(timeZone, now.getTime()));
  }

  /**
   * @description The HVAC Controller device (single instance).
   * @returns {Object} Device
   * @throws when it has not been added
   */
  getController() {
    const [controller] = this.homey.drivers.getDriver('hvac').getDevices();
    if (!controller) throw new Error(this.homey.__('error.no_controller'));
    return controller;
  }

  /**
   * @description The HVAC Controller, or null when it has not been added.
   */
  findController() {
    try {
      return this.getController();
    } catch (error) {
      return null;
    }
  }

  /**
   * @description Show temperatures in °F (reason texts). Homey's getUnits() can stay metric while Homey shows °F, but
   * the Web API labels member temperatures °F then: either one means °F.
   */
  isImperial() {
    let system;
    try {
      system = this.homey.i18n.getUnits();
    } catch (error) {
      system = 'metric';
    }
    return isImperial(system, this.members.fahrenheit());
  }

  /**
   * @description Shared state on the controller changed: let devices re-evaluate now instead of on the next slot.
   */
  async onSharedStateChanged() {
    await forEachDevice(this, async (device) => {
      if (typeof device.onSharedStateChanged === 'function') await device.onSharedStateChanged();
    });
  }
};
