'use strict';

const { localTime, strToMins } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const prices = require('../../lib/prices');

const OCCUPANCY = ['present', 'coming_home', 'away'];
const SEASONS = ['heating', 'cooling', 'off'];
// Season is shown with the standard thermostat_mode capability.
const SEASON_MODE = { heating: 'heat', cooling: 'cool', off: 'off' };
const MODE_SEASON = { heat: 'heating', cool: 'cooling', off: 'off' };
const MASTER_MODES = ['auto', 'long_absence', 'off'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

module.exports = class hvacDevice extends mainDevice {
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    if (!TIME_RE.test(newSettings.tomorrow_check_time)) throw new Error(this.homey.__('error.invalid_time'));
    if (newSettings.absence_until !== '' && !isDate(newSettings.absence_until)) throw new Error(this.homey.__('error.invalid_date'));

    if (changedKeys.includes('absence_until')) {
      if (newSettings.absence_until !== '') await this.changeEnum('master_mode', 'long_absence');
      else if (this.getCapabilityValue('enum_master_mode') === 'long_absence') await this.changeEnum('master_mode', 'auto');
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

  async setCapabilityListeners() {
    this.registerCapabilityListener('enum_occupancy', this.onCapability_OCCUPANCY.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapability_THERMOSTAT_MODE.bind(this));
    this.registerCapabilityListener('enum_master_mode', this.onCapability_MASTER_MODE.bind(this));
  }

  async setCapabilityValues(check = false) {
    try {
      if (!OCCUPANCY.includes(this.getCapabilityValue('enum_occupancy'))) await this.setValue('enum_occupancy', 'present', check);
      if (!MODE_SEASON[this.getCapabilityValue('thermostat_mode')]) await this.setValue('thermostat_mode', 'heat', check);
      if (!MASTER_MODES.includes(this.getCapabilityValue('enum_master_mode'))) await this.setValue('enum_master_mode', 'auto', check);
      await this.evaluatePrices(this.getSettings(), check);
    } catch (error) {
      this.setUnavailable(error).catch(this.error);
      this.error(`${this.getName()} - setCapabilityValues - ${error}`);
    }
  }

  async onInterval(now) {
    const local = localTime(this, now);
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
      masterMode: this.getCapabilityValue('enum_master_mode'),
      expensive: this.getCapabilityValue('is_expensive') === true,
      price: this.getCapabilityValue('measure_monetary'),
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

  async onCapability_MASTER_MODE(value) {
    this.log(`${this.getName()} - onCapability_MASTER_MODE - ${value}`);
    try {
      // Leaving long absence by hand also ends a dated one.
      if (value !== 'long_absence' && this.getSetting('absence_until') !== '') await this.setSettings({ absence_until: '' });
      return Promise.resolve(await this.changeEnum('master_mode', value));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description Set occupancy, season or master mode, fire its changed trigger and let the zones re-evaluate.
   * @returns {Promise<boolean>} true when changed
   */
  async changeEnum(key, value) {
    const values = { occupancy: OCCUPANCY, season: SEASONS, master_mode: MASTER_MODES }[key];
    if (!values.includes(value)) throw new Error(this.homey.__('error.invalid_value', { value }));
    const capability = { occupancy: 'enum_occupancy', season: 'thermostat_mode', master_mode: 'enum_master_mode' }[key];
    const capabilityValue = key === 'season' ? SEASON_MODE[value] : value;
    if (capabilityValue === this.getCapabilityValue(capability)) return false;
    await this.setValue(capability, capabilityValue);
    await this.triggerFlow(`${capability}_changed`, { [capability]: this.homey.__(`${key}.${value}`) });
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
   * @description Set season as thermostat mode heat / cool / off (flow action).
   */
  async onAction_SET_THERMOSTAT_MODE(value) {
    return this.onCapability_THERMOSTAT_MODE(value);
  }

  /**
   * @description Set master mode (flow action).
   */
  async onAction_SET_ENUM_MASTER_MODE(value) {
    return this.onCapability_MASTER_MODE(value);
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
    await this.changeEnum('master_mode', 'long_absence');
  }

  /**
   * @description Set the price model, and the above average percentage when given (flow action).
   */
  async onAction_SET_PRICE_MODEL(model, pct) {
    this.log(`${this.getName()} - onAction_SET_PRICE_MODEL - ${model} ${pct}`);
    if (!prices.MODELS.includes(model)) throw new Error(this.homey.__('error.invalid_value', { value: model }));
    const changes = { price_model: model };
    if (typeof pct === 'number' && Number.isFinite(pct)) changes.price_above_average_pct = Math.min(500, Math.max(0, pct));
    await this.setSettings(changes);
    await this.evaluatePrices();
  }

  /**
   * @description Import one day of prices from a flow token.
   * @param {string} day - 'today' or 'tomorrow'
   * @param {string} input - JSON array of prices from local midnight
   */
  async onAction_IMPORT_PRICES(day, input) {
    const settings = this.getSettings();
    const resolution = Number(settings.price_resolution);
    const timeZone = this.homey.clock.getTimezone();
    const now = Date.now();
    const today = prices.localDate(timeZone, now);
    const date = day === 'tomorrow' ? prices.addDays(today, 1) : today;

    const parsed = prices.parsePrices(input);
    if (parsed.error) return this.rejectImport(day, parsed.error, {});
    if (parsed.values.length === 0 && day === 'tomorrow') {
      this.log(`${this.getName()} - onAction_IMPORT_PRICES - tomorrow empty, not published yet`);
      return false;
    }

    const { slots } = prices.dayInfo(timeZone, date, resolution);
    const check = prices.checkDay(parsed.values, slots, resolution, day);
    if (!check.ok) return this.rejectImport(day, check.error, check.args);

    const days = this.getStoreValue('prices') || {};
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
      resolution: Number(settings.price_resolution),
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
      if (this.getCapabilityValue('enum_master_mode') === 'long_absence') await this.changeEnum('master_mode', 'auto');
    }
  }

  /**
   * @description Daily check: fire "Prices missing for tomorrow" when tomorrow is still empty or partial.
   */
  async checkTomorrow(now) {
    const settings = this.getSettings();
    const resolution = Number(settings.price_resolution);
    const timeZone = this.homey.clock.getTimezone();
    const tomorrow = prices.addDays(prices.localDate(timeZone, now), 1);
    const entry = (this.getStoreValue('prices') || {})[tomorrow];
    const count = entry && entry.resolution === resolution ? entry.values.length : 0;
    const { slots } = prices.dayInfo(timeZone, tomorrow, resolution);
    if (count < slots) {
      this.log(`${this.getName()} - checkTomorrow - ${tomorrow}: ${count}/${slots}`);
      await this.triggerFlow('prices_missing_tomorrow', { count });
    }
  }
};
