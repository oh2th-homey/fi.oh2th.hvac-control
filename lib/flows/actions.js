'use strict';

exports.init = async function (ctx) {
  /**
   * HVAC Controller actions
   */
  const onAction_SET_ENUM_OCCUPANCY = ctx.homey.flow.getActionCard('set_enum_occupancy');
  onAction_SET_ENUM_OCCUPANCY.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_OCCUPANCY(args.occupancy));

  const onAction_SET_ENUM_MASTER_MODE = ctx.homey.flow.getActionCard('set_enum_master_mode');
  onAction_SET_ENUM_MASTER_MODE.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_MASTER_MODE(args.mode));

  const onAction_SET_ABSENCE_UNTIL = ctx.homey.flow.getActionCard('set_absence_until');
  onAction_SET_ABSENCE_UNTIL.registerRunListener(async (args, state) => args.device.onAction_SET_ABSENCE_UNTIL(args.date));

  const onAction_SET_MEASURE_TEMPERATURE_OUTDOOR = ctx.homey.flow.getActionCard('set_measure_temperature_outdoor');
  onAction_SET_MEASURE_TEMPERATURE_OUTDOOR.registerRunListener(async (args, state) => args.device.onAction_SET_MEASURE_TEMPERATURE_OUTDOOR(args.temperature));

  const onAction_IMPORT_PRICES = ctx.homey.flow.getActionCard('import_prices');
  onAction_IMPORT_PRICES.registerRunListener(async (args, state) => args.device.onAction_IMPORT_PRICES(args.day, args.prices));

  const onAction_SET_PRICE_MODEL = ctx.homey.flow.getActionCard('set_price_model');
  onAction_SET_PRICE_MODEL.registerRunListener(async (args, state) => args.device.onAction_SET_PRICE_MODEL(args.model, args.pct));

  /**
   * Heating Zone actions
   */
  const onAction_SET_ENUM_ZONE_MODE = ctx.homey.flow.getActionCard('set_enum_zone_mode');
  onAction_SET_ENUM_ZONE_MODE.registerRunListener(async (args, state) => args.device.onAction_SET_ENUM_ZONE_MODE(args.mode));

  const onAction_SET_POWER_BOOST = ctx.homey.flow.getActionCard('set_power_boost');
  onAction_SET_POWER_BOOST.registerRunListener(async (args, state) => args.device.onAction_SET_POWER_BOOST(args.minutes));

  const onAction_SET_TARGET_TEMPERATURE_COOL = ctx.homey.flow.getActionCard('set_target_temperature_cool');
  onAction_SET_TARGET_TEMPERATURE_COOL.registerRunListener(async (args, state) => args.device.onAction_SET_TARGET_TEMPERATURE_COOL(args.temperature));

  const onAction_SET_OCCUPANCY_RULE = ctx.homey.flow.getActionCard('set_occupancy_rule');
  onAction_SET_OCCUPANCY_RULE.registerRunListener(async (args, state) => args.device.onAction_SET_OCCUPANCY_RULE(args.rule));

  const onAction_SET_NUM_SETBACK = ctx.homey.flow.getActionCard('set_num_setback');
  onAction_SET_NUM_SETBACK.registerRunListener(async (args, state) => args.device.onAction_SET_NUM_SETBACK(args.setback));
};
