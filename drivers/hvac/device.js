'use strict';

const { localTime, strToMins, localDate, addDays, isDate, isTime, updateCapabilities } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const prices = require('../../lib/prices');
const daily = require('../../lib/daily');

const OCCUPANCY = ['present', 'coming_home', 'away'];
const SEASONS = ['heating', 'cooling', 'off'];
// Season is shown with the standard thermostat_mode capability.
const SEASON_MODE = { heating: 'heat', cooling: 'cool', off: 'off' };
const MODE_SEASON = { heat: 'heating', cool: 'cooling', off: 'off' };

// An outdoor sensor not updated for this long counts as unknown.
const OUTDOOR_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// The zones' heating power summed, as the controller's own power; it can be excluded in Homey Energy.
const POWER = 'measure_power';
const ZONE_POWER = 'measure_power.heating';
const POWER_OPTIONS = { title: { en: 'Heating power' }, units: { en: 'W' }, decimals: 0 };
// The zones' energy and cost today, and today's average price (lib/daily.js); shown with POWER.
const ENERGY_TODAY = 'meter_power.today';
const COST_TODAY = 'measure_monetary.cost_today';
const PRICE_PAID = 'measure_monetary.price_paid';
const PRICE_AVERAGE = 'measure_monetary.price_average';
const DAY_CAPS = [ENERGY_TODAY, COST_TODAY, PRICE_PAID, PRICE_AVERAGE];

module.exports = class hvacDevice extends mainDevice {
  async onInitDevice() {
    await this.subscribeOutdoor();
  }

  async onDeleted() {
    await super.onDeleted();
    this.unsubscribeOutdoor();
  }

  async onUninit() {
    await super.onUninit();
    this.unsubscribeOutdoor();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    if (!isTime(newSettings.tomorrow_check_time)) throw new Error(this.homey.__('error.invalid_time'));
    const currency = String(newSettings.currency).trim();
    if (currency.length < 1 || currency.length > 5) throw new Error(this.homey.__('error.invalid_currency'));
    if (changedKeys.includes('currency')) await this.applyCurrency(currency);
    if (newSettings.absence_until !== '' && !isDate(newSettings.absence_until)) throw new Error(this.homey.__('error.invalid_date'));

    if (changedKeys.includes('absence_until')) {
      if (newSettings.absence_until !== '') await this.changeLongAbsence(true);
      else await this.changeLongAbsence(false);
    }
    // Settings are saved after this returns; evaluate with the new ones.
    await this.evaluatePrices(newSettings);
  }

  /**
   * @description Zones that started before the controller re-evaluate with its state now.
   */
  async onReady() {
    await this.homey.app.onSharedStateChanged();
  }

  /**
   * @description Heating power, energy and cost are shown only when a zone has a power meter.
   * @param {Object} [deleted] - Zone being deleted, left out
   */
  async checkCapabilities(deleted = null) {
    const zones = this.meteredZones(deleted);
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    // Zones not loaded yet (app start): keep what is shown.
    if (zones === null ? this.hasCapability(POWER) : zones.length) capabilities.push(POWER, ...DAY_CAPS);
    const result = await updateCapabilities(this, capabilities, this.getCapabilities());
    if (result.added.includes(POWER)) await this.setCapabilityOptions(POWER, POWER_OPTIONS).catch(this.error);
    if (result.added.includes(ENERGY_TODAY)) await this.setCapabilityOptions(ENERGY_TODAY, { title: { en: 'Energy today' }, units: { en: 'kWh' }, decimals: 2 }).catch(this.error);
    if (result.added.includes(COST_TODAY)) await this.applyCurrency();
    return result;
  }

  /**
   * @description Zones with a power meter, or null while the zone driver is not ready.
   */
  meteredZones(deleted = null) {
    try {
      return this.homey.drivers
        .getDriver('zone')
        .getDevices()
        .filter((zone) => zone !== deleted && typeof zone.hasPower === 'function' && zone.hasPower());
    } catch (error) {
      return null;
    }
  }

  /**
   * @description Heating power: sum of the zones' heating power. Zones call this when theirs changes, when their meters
   * change and when deleted.
   * @param {Object} [deleted] - Zone being deleted, left out
   */
  async updateHeatingPower(deleted = null) {
    const zones = this.meteredZones(deleted) || [];
    if (zones.length > 0 !== this.hasCapability(POWER)) await this.checkCapabilities(deleted);
    const watts = zones.map((zone) => zone.getCapabilityValue(ZONE_POWER)).filter((value) => typeof value === 'number');
    await this.setValue(POWER, watts.length ? Math.round(watts.reduce((sum, value) => sum + value, 0)) : null);
  }

  async setCapabilityListeners() {
    this.registerCapabilityListener('enum_occupancy', this.onCapability_OCCUPANCY.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapability_THERMOSTAT_MODE.bind(this));
    this.registerCapabilityListener('is_long_absence', this.onCapability_LONG_ABSENCE.bind(this));
  }

  /**
   * @description Price unit from the Currency setting, e.g. "€/kWh" or "kr/kWh".
   */
  async applyCurrency(currency = this.getSetting('currency')) {
    const symbol = String(currency || '€').trim() || '€';
    // setCapabilityOptions replaces the manifest's options for this capability: pass title and decimals too.
    const { title, decimals } = this.driver.manifest.capabilitiesOptions.measure_monetary;
    await this.setCapabilityOptions('measure_monetary', { title, decimals, units: { en: `${symbol}/kWh` } }).catch(this.error);
    const perKwh = { units: { en: `${symbol}/kWh` }, decimals: 4 };
    if (this.hasCapability(COST_TODAY)) await this.setCapabilityOptions(COST_TODAY, { title: { en: 'Cost today' }, units: { en: symbol }, decimals: 2 }).catch(this.error);
    if (this.hasCapability(PRICE_PAID)) await this.setCapabilityOptions(PRICE_PAID, { title: { en: 'Price paid today' }, ...perKwh }).catch(this.error);
    if (this.hasCapability(PRICE_AVERAGE)) await this.setCapabilityOptions(PRICE_AVERAGE, { title: { en: 'Average price today' }, ...perKwh }).catch(this.error);
    for (const zone of this.meteredZones() || []) await zone.applyCurrency(symbol);
  }

  /**
   * @description Add the quarter to today's totals (lib/daily.js): the zones' energy, its cost, the outdoor temperature and the
   * price. At the first quarter of a new day returns the finished day for the daily summary.
   * @param {string} date - Local date of the quarter
   * @param {Object} quarter - { energy (Wh, sum of the zones), price, outdoor, expensive }
   */
  async addToDay(date, { energy, price, outdoor, expensive }) {
    const { day, finished } = daily.addQuarter(this.getStoreValue('day'), date, { energy, price, temperature: outdoor, eco: expensive === true });
    await this.setStoreValue('day', day).catch(this.error);
    const today = daily.summary(day);
    const round = (value, digits) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);
    await this.setValue(ENERGY_TODAY, round(today.kWh, 3));
    await this.setValue(COST_TODAY, round(today.cost, 4));
    await this.setValue(PRICE_PAID, round(today.pricePaid, 4));
    await this.setValue(PRICE_AVERAGE, round(today.priceAverage, 4));
    return finished;
  }

  async setCapabilityValues(check = false) {
    try {
      if (check) await this.applyCurrency();
      if (!OCCUPANCY.includes(this.getCapabilityValue('enum_occupancy'))) await this.setValue('enum_occupancy', 'present', check);
      if (!MODE_SEASON[this.getCapabilityValue('thermostat_mode')]) await this.setValue('thermostat_mode', 'heat', check);
      if (typeof this.getCapabilityValue('is_long_absence') !== 'boolean') await this.setValue('is_long_absence', this.getSetting('absence_until') !== '', check);
      await this.evaluatePrices(this.getSettings(), check);
    } catch (error) {
      this.setUnavailable(error).catch(this.error);
      this.error(`${this.getName()} - setCapabilityValues - ${error}`);
    }
  }

  async onInterval(now) {
    const local = localTime(this, now);
    if (!this.outdoorListener && local.minutes % 5 === 0) await this.subscribeOutdoor();
    await this.checkAbsence(local);
    if (local.minutes % 15 === 0) await this.evaluatePrices();
    if (local.minutesOfDay === strToMins(this.getSettings().tomorrow_check_time)) await this.checkTomorrow(now.getTime());
  }

  /**
   * @description Shared state read by the zones.
   */
  getSharedState() {
    return {
      occupancy: this.getCapabilityValue('enum_occupancy'),
      season: this.getSeason(),
      longAbsence: this.getCapabilityValue('is_long_absence') === true,
      expensive: this.getCapabilityValue('is_expensive') === true,
      price: this.getCapabilityValue('measure_monetary'),
      outdoor: this.outdoorTemperature(),
      priceReason: this.getCapabilityValue('text_reason'),
      at: Date.now()
    };
  }

  async onCapability_OCCUPANCY(value) {
    this.log(`${this.getName()} - onCapability_OCCUPANCY - ${value}`);
    try {
      return Promise.resolve(await this.changeEnum('occupancy', value));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  getSeason() {
    return MODE_SEASON[this.getCapabilityValue('thermostat_mode')] || 'heating';
  }

  async onCapability_THERMOSTAT_MODE(value) {
    this.log(`${this.getName()} - onCapability_THERMOSTAT_MODE - ${value}`);
    try {
      if (!MODE_SEASON[value]) throw new Error(this.homey.__('error.invalid_value', { value }));
      return Promise.resolve(await this.changeEnum('season', MODE_SEASON[value]));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async onCapability_LONG_ABSENCE(value) {
    this.log(`${this.getName()} - onCapability_LONG_ABSENCE - ${value}`);
    try {
      // Ending long absence by hand also ends a dated one.
      if (value !== true && this.getSetting('absence_until') !== '') await this.setSettings({ absence_until: '' });
      return Promise.resolve(await this.changeLongAbsence(value === true));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description Start or end long absence; setValue fires "Long absence changed", the zones re-evaluate.
   * @returns {Promise<boolean>} true when changed
   */
  async changeLongAbsence(value) {
    if (value === (this.getCapabilityValue('is_long_absence') === true)) return false;
    await this.setValue('is_long_absence', value);
    await this.homey.app.onSharedStateChanged();
    return true;
  }

  /**
   * @description Set occupancy or season, fire its changed trigger and let the zones re-evaluate.
   * @returns {Promise<boolean>} true when changed
   */
  async changeEnum(key, value) {
    const values = { occupancy: OCCUPANCY, season: SEASONS }[key];
    if (!values.includes(value)) throw new Error(this.homey.__('error.invalid_value', { value }));
    const capability = { occupancy: 'enum_occupancy', season: 'thermostat_mode' }[key];
    const capabilityValue = key === 'season' ? SEASON_MODE[value] : value;
    if (capabilityValue === this.getCapabilityValue(capability)) return false;
    await this.setValue(capability, capabilityValue);
    // Standard capabilities (season = thermostat_mode) get Homey's own changed trigger.
    if (capability.startsWith('enum_')) await this.triggerFlow(`${capability}_changed`, { [capability]: this.homey.__(`${key}.${value}`) });
    await this.homey.app.onSharedStateChanged();
    return true;
  }

  /**
   * @description Set occupancy (flow action).
   */
  async onAction_SET_ENUM_OCCUPANCY(value) {
    return this.onCapability_OCCUPANCY(value);
  }

  /**
   * Outdoor temperature: follows the sensor chosen at pairing or repair.
   */
  async subscribeOutdoor() {
    const outdoor = this.getStoreValue('outdoor');
    if (!outdoor || this.outdoorListener) return;
    const listener = (value) => this.onOutdoor(value).catch(this.error);
    try {
      await this.homey.app.members.subscribe(outdoor.id, outdoor.cap, listener);
      this.outdoorListener = listener;
      const reading = this.homey.app.members.read(outdoor.id, outdoor.cap);
      await this.onOutdoor(reading ? reading.value : null);
    } catch (error) {
      // Retried from onInterval, e.g. when the sensor's app starts later.
      this.error(`${this.getName()} - subscribeOutdoor - ${error}`);
    }
  }

  unsubscribeOutdoor() {
    const outdoor = this.getStoreValue('outdoor');
    if (outdoor && this.outdoorListener) this.homey.app.members.unsubscribe(outdoor.id, outdoor.cap, this.outdoorListener);
    this.outdoorListener = null;
  }

  async onOutdoor(value) {
    const valid = typeof value === 'number' && Number.isFinite(value) && value >= -60 && value <= 60;
    const changed = await this.setValue('measure_temperature.outdoor', valid ? Math.round(value * 10) / 10 : null);
    if (changed && !this.initializing) await this.homey.app.onSharedStateChanged();
  }

  /**
   * @description Repair: a new outdoor sensor, or null for none.
   */
  async onRepairOutdoor(outdoor) {
    this.log(`${this.getName()} - onRepairOutdoor - ${outdoor ? `${outdoor.name} ${outdoor.cap}` : 'none'}`);
    this.unsubscribeOutdoor();
    await this.setStoreValue('outdoor', outdoor);
    await this.setValue('measure_temperature.outdoor', null);
    await this.subscribeOutdoor();
    await this.homey.app.onSharedStateChanged();
    return true;
  }

  /**
   * @description Outdoor temperature from the sensor, or null when none, unavailable or not updated for OUTDOOR_MAX_AGE_MS.
   */
  outdoorTemperature() {
    const outdoor = this.getStoreValue('outdoor');
    const reading = outdoor && this.outdoorListener ? this.homey.app.members.read(outdoor.id, outdoor.cap) : null;
    if (!reading || !reading.available || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return null;
    if (reading.lastUpdated && Date.now() - reading.lastUpdated.getTime() > OUTDOOR_MAX_AGE_MS) return null;
    return Math.round(reading.value * 10) / 10;
  }

  /**
   * @description End long absence now (flow action).
   */
  async onAction_END_LONG_ABSENCE() {
    return this.onCapability_LONG_ABSENCE(false);
  }

  /**
   * @description Start long absence now until the end of the given day (flow date argument dd-mm-yyyy).
   */
  async onAction_SET_ABSENCE_UNTIL(value) {
    this.log(`${this.getName()} - onAction_SET_ABSENCE_UNTIL - ${value}`);
    const [d, m, y] = String(value).split('-');
    const date = `${y}-${m}-${d}`;
    if (!isDate(date)) throw new Error(this.homey.__('error.invalid_date'));
    if (date < localTime(this).date) throw new Error(this.homey.__('error.date_in_past'));
    await this.setSettings({ absence_until: date });
    await this.changeLongAbsence(true);
  }

  /**
   * @description Import one day of prices from a flow token.
   * @param {string} day - 'today' or 'tomorrow'
   * @param {string} input - JSON array of prices from local midnight
   */
  async onAction_IMPORT_PRICES(day, input) {
    const timeZone = this.homey.clock.getTimezone();
    const now = Date.now();
    const today = localDate(timeZone, now);
    const date = day === 'tomorrow' ? addDays(today, 1) : today;

    const parsed = prices.parsePrices(input);
    if (parsed.error) return this.rejectImport(day, parsed.error, {});
    if (parsed.values.length === 0 && day === 'tomorrow') {
      this.log(`${this.getName()} - onAction_IMPORT_PRICES - tomorrow empty, not published yet`);
      return false;
    }

    // 15- or 60-minute prices, from the number of values; a partial tomorrow keeps today's resolution.
    const days = this.getStoreValue('prices') || {};
    const known = day === 'tomorrow' && days[today] ? days[today].resolution : null;
    const resolution = prices.detectResolution(parsed.values.length, timeZone, date, known);
    const { slots } = prices.dayInfo(timeZone, date, resolution);
    const check = prices.checkDay(parsed.values, slots, day);
    if (!check.ok) return this.rejectImport(day, check.error, check.args);

    const entry = prices.mergeDay(days[date], parsed.values, resolution, now);
    if (entry) {
      days[date] = entry;
      await this.setStoreValue('prices', prices.pruneDays(days, today));
      this.log(`${this.getName()} - onAction_IMPORT_PRICES - ${day} ${date}: ${parsed.values.length}/${slots}${check.partial ? ' partial' : ''}`);
    } else {
      this.log(`${this.getName()} - onAction_IMPORT_PRICES - ${day} ${date}: kept the longer stored day`);
    }
    await this.triggerFlow('prices_imported', { day, count: parsed.values.length });
    await this.evaluatePrices();
    return true;
  }

  async rejectImport(day, error, args) {
    const reason = this.homey.__('import.rejected', { day: this.homey.__(`import.${day}`), detail: this.homey.__(`import.${error}`, args) });
    this.log(`${this.getName()} - onAction_IMPORT_PRICES - ${reason}`);
    await this.setValue('text_reason', reason);
    throw new Error(reason);
  }

  /**
   * @description Evaluate the current price slot and update price capabilities and reason.
   */
  async evaluatePrices(settings = this.getSettings(), firstRun = false) {
    const timeZone = this.homey.clock.getTimezone();
    const now = Date.now();
    const result = prices.evaluate({
      days: this.getStoreValue('prices') || {},
      timeZone,
      now,
      resolution: this.priceResolution(),
      model: settings.price_model,
      pct: settings.price_above_average_pct,
      minDelta: settings.price_min_delta
    });
    const wasExpensive = this.getCapabilityValue('is_expensive') === true;

    await this.setValue('measure_monetary', result.price, firstRun);
    await this.setValue('is_expensive', result.expensive, firstRun);
    await this.setValue('text_prices_until', result.until ? this.formatLocal(result.until) : this.homey.__('price.none'), firstRun);
    await this.setValue('text_reason', this.reasonText(result.reasons), firstRun);

    if (!firstRun && wasExpensive !== result.expensive) await this.homey.app.onSharedStateChanged();
    return result;
  }

  /**
   * @description Resolution of today's imported prices (15 or 60 minutes), 15 when none.
   */
  priceResolution() {
    const timeZone = this.homey.clock.getTimezone();
    const entry = (this.getStoreValue('prices') || {})[localDate(timeZone, Date.now())];
    return entry ? entry.resolution : 15;
  }

  reasonText(reasons) {
    return reasons
      .map(({ code, args }) => {
        const formatted = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'number' && key !== 'pct' ? value.toFixed(4) : value]));
        return this.homey.__(`price.${code}`, formatted);
      })
      .join('; ');
  }

  formatLocal(ms) {
    const local = localTime(this, new Date(ms));
    return `${local.date} ${local.time}`;
  }

  /**
   * @description End a dated long absence after its last day.
   */
  async checkAbsence(local) {
    const until = this.getSetting('absence_until');
    if (until && local.date > until) {
      this.log(`${this.getName()} - checkAbsence - long absence until ${until} ended`);
      await this.setSettings({ absence_until: '' });
      await this.changeLongAbsence(false);
    }
  }

  /**
   * @description Daily check: fire "Prices missing for tomorrow" when tomorrow is still empty or partial.
   */
  async checkTomorrow(now) {
    const resolution = this.priceResolution();
    const timeZone = this.homey.clock.getTimezone();
    const tomorrow = addDays(localDate(timeZone, now), 1);
    const entry = (this.getStoreValue('prices') || {})[tomorrow];
    const count = entry && entry.resolution === resolution ? entry.values.length : 0;
    const { slots } = prices.dayInfo(timeZone, tomorrow, resolution);
    if (count < slots) {
      this.log(`${this.getName()} - checkTomorrow - ${tomorrow}: ${count}/${slots}`);
      await this.triggerFlow('prices_missing_tomorrow', { count });
    }
  }
};
