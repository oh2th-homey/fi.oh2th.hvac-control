'use strict';

exports.init = async function (ctx) {
  /**
   * HVAC Controller actions
   */
  const onAction_SET_ENUM_OCCUPANCY = ctx.homey.flow.getActionCard('set_enum_occupancy');
  onAction_SET_ENUM_OCCUPANCY.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_OCCUPANCY(args.occupancy));

  const onAction_END_LONG_ABSENCE = ctx.homey.flow.getActionCard('end_long_absence');
  onAction_END_LONG_ABSENCE.registerRunListener(async (args, state) => args.device.onAction_END_LONG_ABSENCE());

  const onAction_SET_ABSENCE_UNTIL = ctx.homey.flow.getActionCard('set_absence_until');
  onAction_SET_ABSENCE_UNTIL.registerRunListener(async (args, state) => args.device.onAction_SET_ABSENCE_UNTIL(args.date));

  const onAction_IMPORT_PRICES = ctx.homey.flow.getActionCard('import_prices');
  onAction_IMPORT_PRICES.registerRunListener(async (args, state) => args.device.onAction_IMPORT_PRICES(args.day, args.prices));

  /**
   * Heating Zone actions
   */
  const onAction_SET_ENUM_ZONE_MODE = ctx.homey.flow.getActionCard('set_enum_zone_mode');
  onAction_SET_ENUM_ZONE_MODE.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_ZONE_MODE(args.mode));

  const onAction_SET_POWER_BOOST = ctx.homey.flow.getActionCard('set_power_boost');
  onAction_SET_POWER_BOOST.registerRunListener(async (args, state) => args.device.onAction_SET_POWER_BOOST(args.minutes));

  const onAction_SET_TARGET_TEMPERATURE_COOL = ctx.homey.flow.getActionCard('set_target_temperature_cool');
  onAction_SET_TARGET_TEMPERATURE_COOL.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_COOL(args.temperature));

  const onAction_ADD_NUM_FOLLOW_HOME_HOURS = ctx.homey.flow.getActionCard('add_num_follow_home_hours');
  onAction_ADD_NUM_FOLLOW_HOME_HOURS.registerRunListener(async (args, state) => args.device.onAction_ADD_NUM_FOLLOW_HOME_HOURS());

  const onAction_RESET_NUM_FOLLOW_HOME_HOURS = ctx.homey.flow.getActionCard('reset_num_follow_home_hours');
  onAction_RESET_NUM_FOLLOW_HOME_HOURS.registerRunListener(async (args, state) => args.device.onAction_RESET_NUM_FOLLOW_HOME_HOURS());

  const onAction_SET_TARGET_TEMPERATURE_COMFORT = ctx.homey.flow.getActionCard('set_target_temperature_comfort');
  onAction_SET_TARGET_TEMPERATURE_COMFORT.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_COMFORT(args.temperature));

  const onAction_SET_TARGET_TEMPERATURE_ECO = ctx.homey.flow.getActionCard('set_target_temperature_eco');
  onAction_SET_TARGET_TEMPERATURE_ECO.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_ECO(args.temperature));

  const onAction_SET_TARGET_TEMPERATURE_ECO_COOL = ctx.homey.flow.getActionCard('set_target_temperature_eco_cool');
  onAction_SET_TARGET_TEMPERATURE_ECO_COOL.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_ECO_COOL(args.temperature));
};
