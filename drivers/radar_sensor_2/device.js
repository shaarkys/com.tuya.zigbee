'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

const dataPoints = {
  tshpsPresenceState: 105,
  tshpscSensitivity: 106,
  tshpsMinimumRange: 108,
  tshpsMaximumRange: 107,
  tshpsTargetDistance: 109,
  tshpsDetectionDelay: 111,
  tshpsFadingTime: 110,
  tshpsIlluminanceLux: 104,
}

const dataTypes = {
  raw: 0, // [ bytes ]
  bool: 1, // [0/1]
  value: 2, // [ 4 byte value ]
  string: 3, // [ N byte string ]
  enum: 4, // [ 0-255 ]
  bitmap: 5, // [ 1,2,4 bytes ] as bits
};

const convertMultiByteNumberPayloadToSingleDecimalNumber = (chunks) => {
  let value = 0;

  for (let i = 0; i < chunks.length; i++) {
    value = value << 8;
    value += chunks[i];
  }

  return value;
};

const getDataValue = (dpValue) => {
  switch (dpValue.datatype) {
    case dataTypes.raw:
      return dpValue.data;
    case dataTypes.bool:
      return dpValue.data[0] === 1;
    case dataTypes.value:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    case dataTypes.string:
      let dataString = '';
      for (let i = 0; i < dpValue.data.length; ++i) {
        dataString += String.fromCharCode(dpValue.data[i]);
      }
      return dataString;
    case dataTypes.enum:
      return dpValue.data[0];
    case dataTypes.bitmap:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
  }
}

class radarSensor2 extends TuyaSpecificClusterDevice {
  constructor(...args) {
    super(...args);
    this.lastDistanceUpdateTime = 0;
  }
  async onNodeInit({ zclNode }) {

    zclNode.endpoints[1].clusters.tuya.on("response", (response) => {
      //this.log('Response event received:', response); // Added for debugging
      this.updatePosition(response);
    });

    // Register the flow trigger card for target distance
    this.targetDistanceTrigger = this.homey.flow.getDeviceTriggerCard('target_distance_changed');
    this.targetDistanceTrigger
      .registerRunListener((args, state) => {
        // Custom logic when the flow is triggered
        // For example, compare args with state or other conditions
        // Return true if the conditions are met, false otherwise
        return Promise.resolve(args.target_distance === state.target_distance);
      });

  }

  async updatePosition(data) {
    const dp = data.dp;
    const value = getDataValue(data);
    const distanceUpdateInterval = this.getSetting('distance_update_interval') ?? 10;

    switch (dp) {
      case dataPoints.tshpsPresenceState:
        this.log("presence state: " + value)
        this.setCapabilityValue('alarm_motion', Boolean(value))
        break;
      case dataPoints.tshpscSensitivity:
        this.log("sensitivity state: " + value)
        break;
      case dataPoints.tshpsIlluminanceLux:
        this.log("lux value: " + value)
        this.onIlluminanceMeasuredAttributeReport(value)
        break;
      case dataPoints.tshpsTargetDistance:
        const currentTime = new Date().getTime();
        if (currentTime - this.lastDistanceUpdateTime >= distanceUpdateInterval * 1000) {
          const targetDistance = value / 100;
          this.setCapabilityValue('target_distance', targetDistance);
          this.lastDistanceUpdateTime = currentTime;

          // Check if targetDistanceTrigger is defined before calling trigger
          if (this.targetDistanceTrigger) {
            this.targetDistanceTrigger.trigger(this, { target_distance: targetDistance }, { target_distance: targetDistance })
              .catch(this.error);
          } else {
            this.log('targetDistanceTrigger is not defined');
          }
        }
        break;
      default:
        this.log('dp value', dp, value)
    }
  }

  onDeleted() {
    if (this.zclNode && this.zclNode.endpoints[1].clusters.tuya) {
      this.zclNode.endpoints[1].clusters.tuya.removeListener("response", this.updatePosition);
    }
    this.log("Radar sensor removed");
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('radar_sensitivity')) {
      this.writeData32(dataPoints.tshpscSensitivity, newSettings['radar_sensitivity'])
    }

    if (changedKeys.includes('minimum_range')) {
      this.writeData32(dataPoints.tshpsMinimumRange, newSettings['minimum_range'] * 100)
    }

    if (changedKeys.includes('maximum_range')) {
      this.writeData32(dataPoints.tshpsMaximumRange, newSettings['maximum_range'] * 100)
    }

    if (changedKeys.includes('detection_delay')) {
      this.writeData32(dataPoints.tshpsDetectionDelay, newSettings['detection_delay'])
    }

    if (changedKeys.includes('fading_time')) {
      this.writeData32(dataPoints.tshpsFadingTime, newSettings['fading_time'])
    }
  }

  onIlluminanceMeasuredAttributeReport(measuredValue) {
    this.log('measure_luminance | Luminance - measuredValue (lux):', measuredValue);
    this.setCapabilityValue('measure_luminance', measuredValue);
  }

  onIASZoneStatusChangeNotification({ zoneStatus, extendedStatus, zoneId, delay, }) {
    this.log('IASZoneStatusChangeNotification received:', zoneStatus, extendedStatus, zoneId, delay);
    this.setCapabilityValue('alarm_motion', zoneStatus.alarm1);
  }

}

module.exports = radarSensor2;
