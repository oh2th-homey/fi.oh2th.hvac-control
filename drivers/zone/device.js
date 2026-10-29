'use strict';

const { localTime, updateCapabilities, serialize, formatTemperature, formatDifference } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const zone = require('../../lib/zone');
const pipeline = require('../../lib/pipeline');

const VERIFY_MS = 60 * 1000;
const RETRY_BACKOFF_MIN = [15, 30, 60];
const HEAT = 'target_temperature';
const ECO = 'target_temperature.eco';
const COOL = 'target_temperature.cool';
const ECO_COOL = 'target_temperature.eco_cool';
const COOL_OPTIONS = { title: { en: 'Comfort cool' }, min: 16, max: 32, step: 0.5, decimals: 1 };
const ECO_COOL_OPTIONS = { title: { en: 'Eco cool' }, min: 16, max: 32, step: 0.5, decimals: 1 };
const FOLLOW_STEP_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = { [HEAT]: 21, [ECO]: 19, [COOL]: 24, [ECO_COOL]: 26, enum_zone_mode: 'auto', power_boost: false };
// Comfort and eco stay in order: eco heat never above comfort heat, eco cool never below comfort cool.
// Changing one moves its partner along when they would cross.
const SETPOINTS = {
  [HEAT]: { min: 5, max: 30, partner: ECO, partnerBelow: true },
  [ECO]: { min: 5, max: 30, partner: HEAT, partnerBelow: false },
  [COOL]: { min: 16, max: 32, partner: ECO_COOL, partnerBelow: false },
  [ECO_COOL]: { min: 16, max: 32, partner: COOL, partnerBelow: true }
};
// Values in reason texts that are temperature differences, not temperatures.
const DIFFERENCE_ARGS = ['step'];

function round1(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

module.exports = class zoneDevice extends mainDevice {
  async onInitDevice() {
    this.setpointListeners = {};
    this.runEvaluate = serialize((opts) => this.evaluateNow(opts), (a, b) => ({ urgent: !!(a.urgent || b.urgent) }));
    // When each linked door or window opened (ms), and whether the last evaluation saw one open past the delay.
    this.openSince = {};
    this.windowWasOpen = false;
    this.members = this.homey.app.members;
    this.subscriptions = [];
    this.decision = null;
    this.issues = [];
    this.lastShared = this.getStoreValue('lastShared') || null;
    this.memberState = this.getStoreValue('memberState') || {};
  }

  async onDeleted() {
    await super.onDeleted();
    this.unsubscribeMembers();
  }

  async onUninit() {
    await super.onUninit();
    this.unsubscribeMembers();
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`${this.getName()} - onSettings - changed: ${changedKeys}`);
    if (newSettings.outdoor_off_above <= newSettings.outdoor_on_below) throw new Error(this.homey.__('error.outdoor_limit'));
    // Settings are saved after this returns.
    this.setTimer('settings', async () => {
      if (changedKeys.includes('has_cooling')) {
        await this.checkCapabilities();
        await this.setCapabilityValues(true);
      }
      await this.evaluate({ urgent: true });
    }, 1000);
  }

  /**
   * @description Comfort cool and eco cool are shown only when the zone has cooling. Zones from before the eco
   * setpoints get them from their old setback (comfort heat minus it, comfort cool plus it).
   */
  async checkCapabilities() {
    const capabilities = [...(this.driver.manifest.capabilities || [])];
    if (this.getSetting('has_cooling')) capabilities.push(COOL, ECO_COOL);
    const setback = this.hasCapability('num_setback') ? this.getCapabilityValue('num_setback') : null;
    if (typeof setback === 'number') await this.setStoreValue('setback', setback).catch(this.error);
    const result = await updateCapabilities(this, capabilities, this.getCapabilities());
    if (result.added.includes(COOL)) await this.setCapabilityOptions(COOL, COOL_OPTIONS).catch(this.error);
    if (result.added.includes(ECO_COOL)) await this.setCapabilityOptions(ECO_COOL, ECO_COOL_OPTIONS).catch(this.error);
    const oldSetback = this.getStoreValue('setback');
    if (typeof oldSetback === 'number') {
      const heat = this.getCapabilityValue(HEAT);
      const cool = this.getCapabilityValue(COOL);
      if (result.added.includes(ECO) && typeof heat === 'number') await this.setValue(ECO, Math.max(SETPOINTS[ECO].min, heat - oldSetback), true);
      if (result.added.includes(ECO_COOL) && typeof cool === 'number') await this.setValue(ECO_COOL, Math.min(SETPOINTS[ECO_COOL].max, cool + oldSetback), true);
    }
    for (const key of [COOL, ECO_COOL]) {
      if (this.hasCapability(key) && !this.setpointListeners[key]) {
        this.registerCapabilityListener(key, (value) => this.changeSetpoint(key, value));
        this.setpointListeners[key] = true;
      }
    }
    return result;
  }

  async setCapabilityListeners() {
    this.registerCapabilityListener(HEAT, this.onCapability_TARGET_TEMPERATURE.bind(this));
    this.registerCapabilityListener(ECO, this.onCapability_ECO_HEAT.bind(this));
    this.registerCapabilityListener('enum_zone_mode', this.onCapability_ZONE_MODE.bind(this));
    this.registerCapabilityListener('power_boost', this.onCapability_POWER_BOOST.bind(this));
  }

  async setCapabilityValues(check = false) {
    try {
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (this.hasCapability(key) && this.getCapabilityValue(key) === null) await this.setValue(key, value, check);
      }
      await this.updateFollowHours(Date.now());
      await this.subscribeMembers();
      this.updateClimate(Date.now());
      await this.evaluate({ urgent: true, firstRun: check });
    } catch (error) {
      this.setUnavailable(error).catch(this.error);
      this.error(`${this.getName()} - setCapabilityValues - ${error}`);
    }
  }

  async onInterval(now) {
    const ms = now.getTime();
    const boostUntil = this.getStoreValue('boostUntil');
    if (this.getCapabilityValue('power_boost') === true && (!boostUntil || ms >= boostUntil)) {
      this.log(`${this.getName()} - onInterval - boost ended`);
      await this.setValue('power_boost', false);
      await this.evaluate({ urgent: true });
      return;
    }
    this.updateClimate(ms);
    if (await this.updateFollowHours(ms)) {
      this.log(`${this.getName()} - onInterval - Follow home ended`);
      await this.evaluate({ urgent: true });
    } else if (localTime(this, now).minutes % 15 === 0) {
      await this.evaluate();
    } else if (this.windowOpen(ms) !== this.windowWasOpen) {
      // A door or window passed its delay, or closed: act now, not at the next quarter.
      await this.evaluate({ urgent: true });
    } else {
      await this.applyRelays(ms, false);
      await this.retryDue(ms);
    }
  }

  async onSharedStateChanged() {
    // Init ends with its own evaluation; not started yet is undefined.
    if (this.initializing !== false) return;
    await this.evaluate();
  }

  /**
   * Capabilities
   */
  /**
   * @description Comfort heat setpoint (the main dial).
   */
  async onCapability_TARGET_TEMPERATURE(value) {
    return this.changeSetpoint(HEAT, value);
  }

  /**
   * @description Eco heat setpoint: away and when expensive.
   */
  async onCapability_ECO_HEAT(value) {
    return this.changeSetpoint(ECO, value);
  }

  async onCapability_ZONE_MODE(value) {
    this.log(`${this.getName()} - onCapability_ZONE_MODE - ${value}`);
    try {
      if (!zone.ZONE_MODES.includes(value)) throw new Error(this.homey.__('error.invalid_value', { value }));
      if (value === this.getCapabilityValue('enum_zone_mode')) return Promise.resolve(false);
      await this.setValue('enum_zone_mode', value);
      // Manual and off end a boost.
      if (value !== 'auto') await this.setValue('power_boost', false);
      await this.evaluate({ urgent: true });
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async changeSetpoint(key, value) {
    this.log(`${this.getName()} - changeSetpoint - ${key}: ${value}`);
    try {
      const { min, max, partner, partnerBelow } = SETPOINTS[key];
      if (!this.hasCapability(key)) throw new Error(this.homey.__('error.no_cooling'));
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(this.homey.__('error.invalid_value', { value }));
      if (value === this.getCapabilityValue(key)) return Promise.resolve(false);
      await this.setValue(key, value);
      const other = this.getCapabilityValue(partner);
      if (this.hasCapability(partner) && typeof other === 'number' && (partnerBelow ? other > value : other < value)) await this.setValue(partner, value);
      await this.evaluate({ urgent: true });
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async onCapability_POWER_BOOST(value) {
    this.log(`${this.getName()} - onCapability_POWER_BOOST - ${value}`);
    try {
      if (value) return Promise.resolve(await this.startBoost(this.getSetting('boost_minutes')));
      if (this.getCapabilityValue('power_boost') !== true) return Promise.resolve(false);
      await this.setValue('power_boost', false);
      await this.evaluate({ urgent: true });
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * @description Boost for the given minutes; a boost also returns the zone to auto.
   */
  async startBoost(minutes) {
    const until = Date.now() + Math.max(1, Number(minutes) || this.getSetting('boost_minutes')) * 60000;
    await this.setStoreValue('boostUntil', until);
    await this.setValue('power_boost', true);
    await this.setValue('enum_zone_mode', 'auto');
    await this.evaluate({ urgent: true });
    return true;
  }

  /**
   * Flow actions
   */

  /**
   * @description Set zone mode auto / manual / off.
   */
  async onAction_SET_ENUM_ZONE_MODE(mode) {
    return this.onCapability_ZONE_MODE(mode);
  }

  /**
   * @description Boost for the given minutes, or the boost time setting when empty.
   */
  async onAction_SET_POWER_BOOST(minutes) {
    this.log(`${this.getName()} - onAction_SET_POWER_BOOST - ${minutes}`);
    return this.startBoost(minutes);
  }

  /**
   * @description Set the comfort cool setpoint.
   */
  async onAction_SET_TARGET_TEMPERATURE_COOL(value) {
    return this.changeSetpoint(COOL, value);
  }

  /**
   * @description Set the eco heat setpoint.
   */
  async onAction_SET_TARGET_TEMPERATURE_ECO(value) {
    return this.onCapability_ECO_HEAT(value);
  }

  /**
   * @description Set the eco cool setpoint (zones with cooling).
   */
  async onAction_SET_TARGET_TEMPERATURE_ECO_COOL(value) {
    return this.changeSetpoint(ECO_COOL, value);
  }

  /**
   * @description Set the occupancy rule: follows home, always eco or always comfort (flow action).
   */
  async onAction_SET_OCCUPANCY_RULE(rule) {
    this.log(`${this.getName()} - onAction_SET_OCCUPANCY_RULE - ${rule}`);
    if (!['follows', 'always_eco', 'always_comfort'].includes(rule)) throw new Error(this.homey.__('error.invalid_value', { value: rule }));
    if (rule === this.getSetting('occupancy_rule')) return false;
    await this.setSettings({ occupancy_rule: rule });
    await this.evaluate({ urgent: true });
    return true;
  }

  /**
   * @description Follow home for 24 hours more (from now, or from the current end when already following).
   */
  async onAction_ADD_NUM_FOLLOW_HOME_HOURS() {
    const now = Date.now();
    const until = Math.max(now, this.followUntil(now) || 0) + FOLLOW_STEP_MS;
    this.log(`${this.getName()} - onAction_ADD_NUM_FOLLOW_HOME_HOURS - until ${new Date(until).toISOString()}`);
    await this.setStoreValue('followUntil', until);
    await this.updateFollowHours(now);
    await this.evaluate({ urgent: true });
    return true;
  }

  /**
   * @description End Follow home: back to the zone's own Occupancy setting.
   */
  async onAction_RESET_NUM_FOLLOW_HOME_HOURS() {
    this.log(`${this.getName()} - onAction_RESET_NUM_FOLLOW_HOME_HOURS`);
    if (!this.getStoreValue('followUntil')) return false;
    await this.unsetStoreValue('followUntil');
    await this.updateFollowHours(Date.now());
    await this.evaluate({ urgent: true });
    return true;
  }

  /**
   * @description End of Follow home (ms), or null when off or run out.
   */
  followUntil(ms) {
    const until = this.getStoreValue('followUntil');
    return typeof until === 'number' && ms < until ? until : null;
  }

  /**
   * @description Hours left, rounded up; clears Follow home when it has run out.
   * @returns {boolean} true when Follow home just ran out
   */
  async updateFollowHours(ms) {
    const stored = this.getStoreValue('followUntil');
    const until = this.followUntil(ms);
    const ended = typeof stored === 'number' && until === null;
    if (ended) await this.unsetStoreValue('followUntil');
    await this.setValue('num_follow_home_hours', until ? Math.ceil((until - ms) / 3600000) : 0);
    return ended;
  }

  /**
   * Members
   */
  getMembers() {
    return this.getStoreValue('members') || [];
  }

  async onRepairMembers(members) {
    this.log(`${this.getName()} - onRepairMembers - ${members.length} members`);
    this.unsubscribeMembers();
    await this.setStoreValue('members', members);
    const ids = members.map((member) => member.id);
    this.memberState = Object.fromEntries(Object.entries(this.memberState).filter(([id]) => ids.includes(id)));
    await this.saveMemberState();
    await this.subscribeMembers();
    this.updateClimate(Date.now());
    await this.evaluate({ urgent: true });
    return true;
  }

  async subscribeMembers() {
    for (const member of this.getMembers()) {
      const caps = [];
      if (member.control === 'thermostat' || member.control === 'ac') caps.push('target_temperature');
      if (member.control === 'thermostat' && member.hasOnoff !== false) caps.push('onoff');
      if (member.control === 'ac') caps.push('thermostat_mode');
      if (member.control === 'relay') caps.push('onoff');
      if (member.sensor && member.temperature) caps.push('measure_temperature');
      if (member.sensor && member.humidity) caps.push('measure_humidity');
      if (member.contact) caps.push('alarm_contact');
      for (const cap of caps) {
        const listener = (value) => this.onMemberReport(member, cap, value);
        try {
          await this.members.subscribe(member.id, cap, listener);
          this.subscriptions.push({ id: member.id, cap, listener });
        } catch (error) {
          // onoff is optional on thermostats; only report other missing capabilities.
          if (!(cap === 'onoff' && member.control === 'thermostat')) this.error(`${this.getName()} - subscribeMembers - ${member.name} ${cap}: ${error}`);
        }
      }
    }
  }

  unsubscribeMembers() {
    for (const { id, cap, listener } of this.subscriptions || []) this.members.unsubscribe(id, cap, listener);
    this.subscriptions = [];
  }

  async saveMemberState() {
    await this.setStoreValue('memberState', this.memberState).catch(this.error);
  }

  state(member) {
    if (!this.memberState[member.id]) this.memberState[member.id] = {};
    return this.memberState[member.id];
  }

  /**
   * @description Realtime report from a member: sensors update the zone climate, a fault value is restored at once,
   * but only once per verify window: a device that keeps reporting the fault is left to verifySetpoint and its backoff.
   */
  onMemberReport(member, cap, value) {
    if (cap === 'measure_temperature' || cap === 'measure_humidity') {
      // One device can report through several subscriptions (e.g. an A/C that is also the sensor): update once.
      if (!this.climateQueued) {
        this.climateQueued = true;
        Promise.resolve().then(() => {
          this.climateQueued = false;
          this.updateClimate(Date.now());
        });
      }
      return;
    }
    if (cap === 'alarm_contact') {
      // Closed: back at once. Open: eco once open longer than the zone's delay, checked on every minute tick.
      this.log(`${this.getName()} - onMemberReport - ${member.name} ${value ? 'open' : 'closed'}`);
      if (value) this.openSince[member.id] = this.openSince[member.id] || Date.now();
      else delete this.openSince[member.id];
      this.evaluate({ urgent: true }).catch(this.error);
      return;
    }
    if (cap !== 'target_temperature') return;
    const st = this.state(member);
    if (typeof st.written !== 'number' || this.getCapabilityValue('enum_zone_mode') === 'manual') return;
    const kind = pipeline.classifyReport(value, st.written, member);
    if (kind === 'fault') {
      if (st.retryAt && Date.now() < st.retryAt) return;
      if (st.writtenAt && Date.now() - st.writtenAt < VERIFY_MS) return;
      this.log(`${this.getName()} - onMemberReport - ${member.name} reported fault value ${value}, restoring ${st.written}`);
      this.writeSetpoint(member, st.written, Date.now()).catch(this.error);
    } else if (kind === 'hand') {
      this.log(`${this.getName()} - onMemberReport - ${member.name} changed by hand to ${value}, restored at the next write window`);
    }
  }

  /**
   * @description True when a linked door or window has been open longer than the zone's delay, and after that
   * until all of them are closed.
   */
  windowOpen(ms) {
    const delayMs = this.getSetting('window_delay_minutes') * 60000;
    let open = false;
    let anyOpen = false;
    for (const member of this.getMembers().filter((m) => m.contact)) {
      const reading = this.members.read(member.id, 'alarm_contact');
      if (!reading || reading.value !== true) {
        delete this.openSince[member.id];
        continue;
      }
      // Our own open time; one already open at start counts from its last update, or from now.
      if (!this.openSince[member.id]) this.openSince[member.id] = reading.lastUpdated ? Math.min(reading.lastUpdated.getTime(), ms) : ms;
      anyOpen = true;
      if (ms - this.openSince[member.id] >= delayMs) open = true;
    }
    // The delay only applies to entering eco: once in eco, it lasts until all are closed (no flip on a handover).
    return open || (this.windowWasOpen && anyOpen);
  }

  /**
   * @description Zone temperature and humidity: average of the available sensors' readings.
   */
  updateClimate(ms) {
    // A reading is used while the sensor is available; the optional timeout (0 = off) also drops old values.
    const staleMs = this.getSetting('sensor_stale_minutes') * 60000;
    const average = (cap) => {
      const values = [];
      for (const member of this.getMembers().filter((m) => m.sensor)) {
        const reading = this.members.read(member.id, cap);
        if (!reading || typeof reading.value !== 'number' || !reading.available) continue;
        if (staleMs > 0 && reading.lastUpdated && ms - reading.lastUpdated.getTime() > staleMs) continue;
        values.push(reading.value);
      }
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    // A repeated sensor event must not set the same value twice while the first set is still in flight.
    this.climate = this.climate || {};
    for (const cap of ['measure_temperature', 'measure_humidity']) {
      const value = round1(average(cap));
      if (this.climate[cap] === value) continue;
      this.climate[cap] = value;
      this.setValue(cap, value, false, 0).catch(this.error);
    }
  }

  /**
   * Evaluation
   */

  /**
   * @description Decide the zone's aim from the shared facts and write it to the members.
   * @param {Object} opts
   * @param {boolean} opts.urgent - User change: write now, no hold time
   * @param {boolean} opts.firstRun - Init: no triggers
   */
  /**
   * @description Evaluations run one at a time: a request while one runs is merged into a single rerun after it, so
   * members are never written twice or triggers fired twice for the same change.
   */
  async evaluate(opts = {}) {
    return this.runEvaluate(opts);
  }

  async evaluateNow({ urgent = false, firstRun = false } = {}) {
    const ms = Date.now();
    const controller = this.homey.app.findController();
    // A controller still initializing after an app restart is present: its capability values persist.
    const live = controller && (controller.getAvailable() || controller.initializing) ? controller.getSharedState() : null;
    if (live) {
      this.lastShared = live;
      await this.setStoreValue('lastShared', live).catch(this.error);
    }
    const { shared, source } = zone.sharedState(live, this.lastShared, ms);

    const windowOpen = this.windowOpen(ms);
    if (windowOpen !== this.windowWasOpen) this.log(`${this.getName()} - evaluate - door or window open past the delay: ${windowOpen}`);
    this.windowWasOpen = windowOpen;
    const decision = zone.decide({
      shared,
      source,
      zone: {
        mode: this.getCapabilityValue('enum_zone_mode'),
        boostUntil: this.getCapabilityValue('power_boost') === true ? this.getStoreValue('boostUntil') : null,
        heat: this.getCapabilityValue(HEAT),
        eco: this.getCapabilityValue(ECO),
        cool: this.getCapabilityValue(COOL),
        ecoCool: this.getCapabilityValue(ECO_COOL),
        hasCooling: this.hasCapability(COOL),
        lowAlarm: this.getSetting('low_temp_alarm'),
        boostDelta: this.getSetting('boost_delta'),
        occupancyRule: this.getSetting('occupancy_rule'),
        followUntil: this.followUntil(ms),
        windowOpen,
        heatAllYear: this.getSetting('heat_all_year') === true,
        priceUse: this.getSetting('price_use'),
        priceAction: this.getSetting('price_action'),
        outdoorLimit: { enabled: this.getSetting('outdoor_limit') === true, onBelow: this.getSetting('outdoor_on_below'), offAbove: this.getSetting('outdoor_off_above') },
        outdoorAllowed: this.getStoreValue('outdoorAllowed')
      },
      temperature: this.getCapabilityValue('measure_temperature'),
      now: ms
    });
    this.decision = decision;
    if (decision.outdoorAllowed !== this.getStoreValue('outdoorAllowed')) await this.setStoreValue('outdoorAllowed', decision.outdoorAllowed).catch(this.error);

    this.issues = [];
    await this.applyThermostats(ms);
    await this.applyRelays(ms);
    await this.saveMemberState();

    const target = round1(decision.target);
    const reason = this.reasonText();
    const changed = target !== null && target !== this.getCapabilityValue('measure_temperature.set_target');
    // No target in manual or when members are off: show none instead of the last one.
    await this.setValue('measure_temperature.set_target', target, firstRun);
    await this.setValue('is_eco', decision.eco, firstRun);
    await this.setValue('text_reason', reason, firstRun);
    // Only real problems: member write failed, relays without temperature, low temperature, controller missing for over an hour.
    await this.setValue('alarm_problem', source === 'fallback' || decision.lowTemperature || this.issues.some((issue) => issue.alarm), firstRun);
    if (changed && !firstRun) await this.triggerFlow('measure_temperature_set_target_changed', { measure_temperature_set_target: target, text_reason: reason });
  }

  reasonText() {
    const imperial = this.homey.app.isImperial();
    const format = (args) => Object.fromEntries(
      Object.entries(args).map(([key, value]) => {
        if (key === 'until') {
          // Today: the time only; another day: the date too.
          const at = localTime(this, new Date(value));
          return [key, at.date === localTime(this).date ? at.time : `${at.day}.${at.month}. ${at.time}`];
        }
        if (typeof value !== 'number') return [key, value];
        return [key, DIFFERENCE_ARGS.includes(key) ? formatDifference(value, imperial) : formatTemperature(value, imperial)];
      })
    );
    const parts = this.decision.reasons.map(({ code, args }) => this.homey.__(`zone.${code}`, format(args)));
    const issues = this.issues.map(({ code, args, member }) => `${member}: ${this.homey.__(`member.${code}`, format(args))}`);
    return [...parts, ...issues].join('; ');
  }

  issue(member, code, args = {}, alarm = false) {
    this.issues.push({ member: member.name, code, args, alarm });
  }

  /**
   * @description Thermostat and A/C members: mode, setpoint through the pipeline, hold time, hand change and fault restore.
   */
  async applyThermostats(ms) {
    const holdMs = this.getSetting('hold_minutes') * 60000;
    for (const member of this.getMembers().filter((m) => m.control === 'thermostat' || m.control === 'ac')) {
      try {
        // A thermostat with onoff (e.g. a heater with its own thermostat) is switched on and off too.
        const hasOnoff = member.control === 'thermostat' && this.members.read(member.id, 'onoff') !== null;
        const st = this.state(member);
        const plan = pipeline.memberPlan(this.decision, { ...member, hasOnoff }, { temperature: this.getCapabilityValue('measure_temperature'), lastMode: st.mode });
        if (plan.skip) continue;
        for (const reason of plan.reasons) this.issue(member, reason.code, reason.args);

        if (plan.mode) await this.applyMode(member, plan.mode);
        if (plan.power !== null && plan.power !== undefined) await this.applyPower(member, plan.power);
        if (!plan.decision) continue;

        if (st.retryAt && ms < st.retryAt) {
          this.issue(member, 'fault_wait', { until: st.retryAt }, true);
          continue;
        }

        const sp = pipeline.setpoint(plan.decision, member);
        for (const reason of sp.reasons) this.issue(member, reason.code, reason.args, reason.code === 'invalid');
        if (sp.value === null) continue;
        let { value } = sp;
        if (pipeline.keepWritten(sp.raw, value, st.written, member.step, this.getSetting('hysteresis'))) value = st.written;

        const reading = this.members.read(member.id, 'target_temperature');
        const kind = typeof st.written === 'number' && reading ? pipeline.classifyReport(reading.value, st.written, member) : 'unknown';
        if (value === st.written && kind !== 'fault' && kind !== 'hand') continue;
        // The device already shows the new value (after a restart, or changed by hand to it): adopt it, no write.
        if (reading && pipeline.classifyReport(reading.value, value, member) === 'ok') {
          st.written = value;
          continue;
        }

        // A fault right after our write is left to the pending verify, never rewritten in a loop.
        if (kind === 'fault' && value === st.written && st.writtenAt && ms - st.writtenAt < VERIFY_MS) continue;
        // Changes are written at once; only a setpoint changed by hand is left alone for the hold time.
        if (kind === 'hand' && st.writtenAt && ms - st.writtenAt < holdMs) {
          this.issue(member, 'hand_wait', { value });
          continue;
        }
        if (kind === 'hand') this.issue(member, 'hand_restored', { value: reading.value, written: value });
        await this.writeSetpoint(member, value, ms);
      } catch (error) {
        this.error(`${this.getName()} - applyThermostats - ${member.name}: ${error}`);
        this.issue(member, 'error', { error: error.message || String(error) }, true);
      }
    }
  }

  async applyMode(member, mode) {
    const st = this.state(member);
    const reading = this.members.read(member.id, 'thermostat_mode');
    // Skip only when both our last write and the report agree: a stale realtime value alone must not block a change.
    if (st.mode === mode && reading && reading.value === mode) return;
    if (!(member.modes || []).includes(mode)) {
      this.issue(member, 'mode_missing', { mode }, true);
      return;
    }
    this.log(`${this.getName()} - applyMode - ${member.name}: ${reading ? reading.value : '?'} (last written ${st.mode || '-'}) => ${mode}`);
    await this.members.write(member.id, 'thermostat_mode', mode);
    st.mode = mode;
  }

  /**
   * @description Switch a thermostat member with onoff on or off. Like the A/C mode, skip only when both the last write
   * and the report agree, so a stale value or a hand switch-off is corrected.
   */
  async applyPower(member, on) {
    const st = this.state(member);
    const reading = this.members.read(member.id, 'onoff');
    if (st.power === on && reading && reading.value === on) return;
    this.log(`${this.getName()} - applyPower - ${member.name}: ${reading ? reading.value : '?'} (last written ${st.power === undefined ? '-' : st.power}) => ${on}`);
    await this.members.write(member.id, 'onoff', on);
    st.power = on;
  }

  /**
   * @description Write one setpoint and verify the report after VERIFY_MS.
   */
  async writeSetpoint(member, value, ms, retry = false) {
    if (!pipeline.valid(value, member)) throw new Error(`invalid setpoint ${value}`);
    this.log(`${this.getName()} - writeSetpoint - ${member.name}: ${value}${retry ? ' (retry)' : ''}`);
    // Recorded before sending: the device's report can arrive before the write call returns.
    const st = this.state(member);
    const previous = { written: st.written, writtenAt: st.writtenAt };
    st.written = value;
    st.writtenAt = ms;
    try {
      await this.members.write(member.id, 'target_temperature', value);
    } catch (error) {
      Object.assign(st, previous);
      throw error;
    }
    await this.saveMemberState();
    this.setTimer(`verify-${member.id}`, () => this.verifySetpoint(member, value, retry), VERIFY_MS);
  }

  /**
   * @description Report after a write: ok or rounding accepts (and learns step 1), a bad report retries once
   * with an integer, then marks the member faulted with backoff.
   */
  async verifySetpoint(member, value, retry) {
    const reading = this.members.read(member.id, 'target_temperature');
    const kind = reading ? pipeline.classifyReport(reading.value, value, member) : 'unknown';
    const st = this.state(member);
    if (kind === 'ok' || kind === 'unknown') {
      if (st.fault) this.log(`${this.getName()} - verifySetpoint - ${member.name}: fault cleared`);
      Object.assign(st, { fault: false, faults: 0, retryAt: null });
      await this.saveMemberState();
      return;
    }
    if (kind === 'whole_degree') {
      if (member.step < 1) await this.learnStep(member, reading.value, value);
      return;
    }
    if (kind === 'rounding') return;
    if (!retry && Number.isInteger(Math.round(value)) && pipeline.valid(Math.round(value), member)) {
      await this.writeSetpoint(member, Math.round(value), Date.now(), true);
      return;
    }
    st.fault = true;
    st.faults = (st.faults || 0) + 1;
    st.retryAt = Date.now() + RETRY_BACKOFF_MIN[Math.min(st.faults, RETRY_BACKOFF_MIN.length) - 1] * 60000;
    await this.saveMemberState();
    const imperial = this.homey.app.isImperial();
    const reason = this.homey.__('member.write_failed', { written: formatTemperature(value, imperial), reported: formatTemperature(reading.value, imperial) });
    this.log(`${this.getName()} - verifySetpoint - ${member.name}: ${reason}`);
    await this.triggerFlow('member_write_failed', { member: member.name, reason });
    await this.evaluate();
  }

  async learnStep(member, reported, written) {
    this.log(`${this.getName()} - learnStep - ${member.name}: wrote ${written}, reported ${reported}, switching to step 1`);
    const members = this.getMembers().map((m) => (m.id === member.id ? { ...m, step: 1 } : m));
    await this.setStoreValue('members', members);
  }

  async retryDue(ms) {
    const due = this.getMembers().some((member) => {
      const st = this.memberState[member.id];
      return st && st.retryAt && ms >= st.retryAt;
    });
    if (due) await this.evaluate();
  }

  /**
   * @description On/off relays: hysteresis around the zone target with minimum on/off times, every minute.
   */
  async applyRelays(ms, report = true) {
    if (!this.decision) return;
    const issue = (...args) => report && this.issue(...args);
    const settings = this.getSettings();
    const minMs = settings.relay_min_minutes * 60000;
    let saved = false;
    for (const member of this.getMembers().filter((m) => m.control === 'relay')) {
      try {
        if (this.decision.action === 'none') continue;
        const reading = this.members.read(member.id, 'onoff');
        const raw = reading ? reading.value === true : false;
        const st = this.state(member);
        // A switch sent in the last minute counts until the device reports it, so two callers can't switch twice.
        const pending = typeof st.relayOn === 'boolean' && ms - (st.switchedAt || 0) < 60000;
        const reported = member.invert ? !raw : raw;
        const on = pending ? st.relayOn : reported;
        // Relays heat: on/off around the target only while heating, off otherwise.
        const target = this.decision.action === 'heat' ? this.decision.target : null;
        const result = pipeline.relay({
          on,
          temperature: this.getCapabilityValue('measure_temperature'),
          target,
          eco: this.decision.eco === true,
          heating: true,
          mode: member.relayMode === 'enable' ? 'enable' : 'thermostat',
          onBelow: typeof member.relayOnBelow === 'number' ? member.relayOnBelow : pipeline.RELAY_ON_BELOW,
          offAt: typeof member.relayOffAt === 'number' ? member.relayOffAt : pipeline.RELAY_OFF_AT,
          minOnMs: minMs,
          minOffMs: minMs,
          lastSwitchAt: st.switchedAt || 0,
          now: ms
        });
        if (result.reason.code === 'relay_no_temperature') issue(member, 'no_temperature', {}, true);
        if (result.on !== on) {
          this.log(`${this.getName()} - applyRelays - ${member.name}: ${on} => ${result.on}`);
          const previous = { relayOn: st.relayOn, switchedAt: st.switchedAt };
          st.relayOn = result.on;
          st.switchedAt = ms;
          try {
            await this.members.write(member.id, 'onoff', member.invert ? !result.on : result.on);
          } catch (error) {
            Object.assign(st, previous);
            throw error;
          }
          saved = true;
        }
      } catch (error) {
        this.error(`${this.getName()} - applyRelays - ${member.name}: ${error}`);
        issue(member, 'error', { error: error.message || String(error) }, true);
      }
    }
    if (saved) await this.saveMemberState();
  }
};
