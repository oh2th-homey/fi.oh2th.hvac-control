'use strict';

exports.init = async function (ctx) {
  /**
   * HVAC Controller conditions
   */
  const onCondition_ENUM_OCCUPANCY_IS = ctx.homey.flow.getConditionCard('enum_occupancy_is');
  onCondition_ENUM_OCCUPANCY_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('enum_occupancy') === args.occupancy);

  const onCondition_THERMOSTAT_MODE_IS = ctx.homey.flow.getConditionCard('thermostat_mode_is');
  onCondition_THERMOSTAT_MODE_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('thermostat_mode') === args.season);

  const onCondition_IS_EXPENSIVE = ctx.homey.flow.getConditionCard('is_expensive');
  onCondition_IS_EXPENSIVE.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_expensive') === true);

  /**
   * Heating Zone conditions
   */
  const onCondition_ENUM_ZONE_MODE_IS = ctx.homey.flow.getConditionCard('enum_zone_mode_is');
  onCondition_ENUM_ZONE_MODE_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('enum_zone_mode') === args.mode);

  const onCondition_IS_ECO = ctx.homey.flow.getConditionCard('is_eco');
  onCondition_IS_ECO.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_eco') === true);
};
