'use strict';

const { localTime } = require('oh2th-homey-helpers');
const mainDevice = require('../main-device');
const zone = require('../../lib/zone');
const pipeline = require('../../lib/pipeline');

const VERIFY_MS = 60 * 1000;
const RETRY_BACKOFF_MIN = [15, 30, 60];
const DEFAULTS = { 'target_temperature.heat': 21, 'target_temperature.cool': 24, 'num_setback': 2, 'enum_zone_mode': 'auto', 'power_boost': false };

function round1(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

module.exports = class zoneDevice extends mainDevice {
  async onInitDevice() {
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
    // Settings are saved after this returns.
    this.setTimer('settings', () => this.evaluate({ urgent: true }), 1000);
  }

  async setCapabilityListeners() {
    this.registerCapabilityListener('target_temperature', this.onCapability_TARGET_TEMPERATURE.bind(this));
    this.registerCapabilityListener('target_temperature.heat', this.onCapability_COMFORT_HEAT.bind(this));
    this.registerCapabilityListener('target_temperature.cool', this.onCapability_COMFORT_COOL.bind(this));
    this.registerCapabilityListener('num_setback', this.onCapability_SETBACK.bind(this));
    this.registerCapabilityListener('enum_zone_mode', this.onCapability_ZONE_MODE.bind(this));
    this.registerCapabilityListener('power_boost', this.onCapability_POWER_BOOST.bind(this));
  }

  async setCapabilityValues(check = false) {
    try {
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (this.getCapabilityValue(key) === null) await this.setValue(key, value, check);
      }
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
    if (localTime(this, now).minutes % 15 === 0) {
      await this.evaluate();
    } else {
      await this.applyRelays(ms, false);
      await this.retryDue(ms);
    }
  }

  async onSharedStateChanged() {
    await this.evaluate();
  }

  /**
   * Capabilities
   */
  /**
   * @description The tile dial is the comfort setpoint of the current season: comfort cool when cooling, else comfort heat.
   */
  async onCapability_TARGET_TEMPERATURE(value) {
    if (this.season() === 'cooling') return this.onCapability_COMFORT_COOL(value);
    return this.onCapability_COMFORT_HEAT(value);
  }

  season() {
    return this.lastShared && this.lastShared.season ? this.lastShared.season : 'heating';
  }

  async onCapability_COMFORT_HEAT(value) {
    return this.changeSetpoint('target_temperature.heat', value, 5, 30);
  }

  async onCapability_COMFORT_COOL(value) {
    return this.changeSetpoint('target_temperature.cool', value, 16, 32);
  }

  async onCapability_SETBACK(value) {
    return this.changeSetpoint('num_setback', Math.round(value), 0, 5);
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

  async changeSetpoint(key, value, min, max) {
    this.log(`${this.getName()} - changeSetpoint - ${key}: ${value}`);
    try {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(this.homey.__('error.invalid_value', { value }));
      if (value === this.getCapabilityValue(key)) return Promise.resolve(false);
      await this.setValue(key, value);
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
   * @description Set the comfort heat setpoint.
   */
  async onAction_SET_TARGET_TEMPERATURE_HEAT(value) {
    return this.onCapability_COMFORT_HEAT(value);
  }

  /**
   * @description Set the comfort cool setpoint.
   */
  async onAction_SET_TARGET_TEMPERATURE_COOL(value) {
    return this.onCapability_COMFORT_COOL(value);
  }

  /**
   * @description Set the setback (eco drop).
   */
  async onAction_SET_NUM_SETBACK(value) {
    return this.onCapability_SETBACK(value);
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
      if (member.control === 'ac') caps.push('thermostat_mode');
      if (member.control === 'relay') caps.push('onoff');
      if (member.sensor && member.temperature) caps.push('measure_temperature');
      if (member.sensor && member.humidity) caps.push('measure_humidity');
      for (const cap of caps) {
        const listener = (value) => this.onMemberReport(member, cap, value);
        try {
          await this.members.subscribe(member.id, cap, listener);
          this.subscriptions.push({ id: member.id, cap, listener });
        } catch (error) {
          this.error(`${this.getName()} - subscribeMembers - ${member.name} ${cap}: ${error}`);
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
   * @description Realtime report from a member: sensors update the zone climate, a fault value is restored at once.
   */
  onMemberReport(member, cap, value) {
    if (cap === 'measure_temperature' || cap === 'measure_humidity') {
      this.updateClimate(Date.now());
      return;
    }
    if (cap !== 'target_temperature') return;
    const st = this.state(member);
    if (typeof st.written !== 'number' || this.getCapabilityValue('enum_zone_mode') === 'manual') return;
    const kind = pipeline.classifyReport(value, st.written, member);
    if (kind === 'fault') {
      if (st.retryAt && Date.now() < st.retryAt) return;
      this.log(`${this.getName()} - onMemberReport - ${member.name} reported fault value ${value}, restoring ${st.written}`);
      this.writeSetpoint(member, st.written, Date.now()).catch(this.error);
    } else if (kind === 'hand') {
      this.log(`${this.getName()} - onMemberReport - ${member.name} changed by hand to ${value}, restored at the next write window`);
    }
  }

  /**
   * @description Zone temperature and humidity: average of fresh sensor readings (+ offset).
   */
  updateClimate(ms) {
    const staleMs = this.getSetting('sensor_stale_minutes') * 60000;
    const average = (cap) => {
      const values = [];
      for (const member of this.getMembers().filter((m) => m.sensor)) {
        const reading = this.members.read(member.id, cap);
        if (!reading || typeof reading.value !== 'number') continue;
        if (reading.lastUpdated && ms - reading.lastUpdated.getTime() > staleMs) continue;
        values.push(reading.value);
      }
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    this.setValue('measure_temperature', round1(average('measure_temperature')), false, 0).catch(this.error);
    this.setValue('measure_humidity', round1(average('measure_humidity')), false, 0).catch(this.error);
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
  async evaluate({ urgent = false, firstRun = false } = {}) {
    const ms = Date.now();
    const controller = this.homey.app.findController();
    const live = controller && controller.getAvailable() ? controller.getSharedState() : null;
    if (live) {
      this.lastShared = live;
      await this.setStoreValue('lastShared', live).catch(this.error);
    }
    const { shared, source } = zone.sharedState(live, this.lastShared, ms);

    const decision = zone.decide({
      shared,
      source,
      zone: {
        mode: this.getCapabilityValue('enum_zone_mode'),
        boostUntil: this.getCapabilityValue('power_boost') === true ? this.getStoreValue('boostUntil') : null,
        heat: this.getCapabilityValue('target_temperature.heat'),
        cool: this.getCapabilityValue('target_temperature.cool'),
        setback: this.getCapabilityValue('num_setback'),
        frostFloor: this.getSetting('frost_floor'),
        boostDelta: this.getSetting('boost_delta'),
        occupancyRule: this.getSetting('occupancy_rule')
      },
      temperature: this.getCapabilityValue('measure_temperature'),
      now: ms
    });
    const holdPrice = !urgent && !!this.decision && this.decision.priceDriven && decision.priceDriven;
    this.decision = decision;

    this.issues = [];
    await this.applyThermostats(ms, holdPrice);
    await this.applyRelays(ms);
    await this.saveMemberState();

    const target = round1(decision.target);
    const reason = this.reasonText();
    const changed = target !== null && target !== this.getCapabilityValue('measure_temperature.set_target');
    if (target !== null) await this.setValue('measure_temperature.set_target', target, firstRun);
    // The dial follows the comfort setpoint of the season.
    const comfort = shared.season === 'cooling' ? 'target_temperature.cool' : 'target_temperature.heat';
    await this.setValue('target_temperature', this.getCapabilityValue(comfort), firstRun);
    await this.setValue('is_eco', decision.eco, firstRun);
    await this.setValue('text_reason', reason, firstRun);
    // Only real problems: member write failed, relays without temperature, controller missing for over an hour.
    await this.setValue('alarm_problem', source === 'fallback' || this.issues.some((issue) => issue.alarm), firstRun);
    if (changed && !firstRun) await this.triggerFlow('measure_temperature_set_target_changed', { measure_temperature_set_target: target, text_reason: reason });
  }

  reasonText() {
    const format = (args) => Object.fromEntries(
      Object.entries(args).map(([key, value]) => {
        if (key === 'until') return [key, localTime(this, new Date(value)).time];
        return [key, typeof value === 'number' ? round1(value) : value];
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
  async applyThermostats(ms, holdPrice) {
    const holdMs = this.getSetting('hold_minutes') * 60000;
    for (const member of this.getMembers().filter((m) => m.control === 'thermostat' || m.control === 'ac')) {
      try {
        const plan = pipeline.memberPlan(this.decision, member, { temperature: this.getCapabilityValue('measure_temperature'), frostFloor: this.getSetting('frost_floor') });
        if (plan.skip) continue;
        for (const reason of plan.reasons) this.issue(member, reason.code, reason.args);
        const st = this.state(member);

        if (plan.mode) await this.applyMode(member, plan.mode);
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

        const held = st.writtenAt && ms - st.writtenAt < holdMs;
        if (held && kind !== 'fault' && (holdPrice || kind === 'hand')) {
          this.issue(member, kind === 'hand' ? 'hand_wait' : 'hold', { value });
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
    const reading = this.members.read(member.id, 'thermostat_mode');
    if (reading && reading.value === mode) return;
    if (!(member.modes || []).includes(mode)) {
      this.issue(member, 'mode_missing', { mode }, true);
      return;
    }
    this.log(`${this.getName()} - applyMode - ${member.name}: ${reading ? reading.value : '?'} => ${mode}`);
    await this.members.write(member.id, 'thermostat_mode', mode);
  }

  /**
   * @description Write one setpoint and verify the report after VERIFY_MS.
   */
  async writeSetpoint(member, value, ms, retry = false) {
    if (!pipeline.valid(value, member)) throw new Error(`invalid setpoint ${value}`);
    this.log(`${this.getName()} - writeSetpoint - ${member.name}: ${value}${retry ? ' (retry)' : ''}`);
    await this.members.write(member.id, 'target_temperature', value);
    const st = this.state(member);
    st.written = value;
    st.writtenAt = ms;
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
    if (kind === 'rounding') {
      if (member.step < 1 && Number.isInteger(reading.value)) await this.learnStep(member, reading.value, value);
      return;
    }
    if (!retry && Number.isInteger(Math.round(value)) && pipeline.valid(Math.round(value), member)) {
      await this.writeSetpoint(member, Math.round(value), Date.now(), true);
      return;
    }
    st.fault = true;
    st.faults = (st.faults || 0) + 1;
    st.retryAt = Date.now() + RETRY_BACKOFF_MIN[Math.min(st.faults, RETRY_BACKOFF_MIN.length) - 1] * 60000;
    await this.saveMemberState();
    const reason = this.homey.__('member.write_failed', { written: value, reported: reading.value });
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
        const on = member.invert ? !raw : raw;
        const st = this.state(member);
        const target = this.decision.action === 'cool' ? null : this.decision.target;
        const result = pipeline.relay({
          on,
          temperature: this.getCapabilityValue('measure_temperature'),
          target,
          heating: true,
          hysteresis: settings.relay_hysteresis,
          minOnMs: minMs,
          minOffMs: minMs,
          lastSwitchAt: st.switchedAt || 0,
          now: ms
        });
        if (result.reason.code === 'relay_no_temperature') issue(member, 'no_temperature', {}, true);
        if (result.on !== on) {
          this.log(`${this.getName()} - applyRelays - ${member.name}: ${on} => ${result.on}`);
          await this.members.write(member.id, 'onoff', member.invert ? !result.on : result.on);
          st.switchedAt = ms;
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
