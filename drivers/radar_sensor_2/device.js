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

  _roundToSingleDecimal(value) {
    return Math.round(value * 10) / 10;
  }

  _roundToTwoDecimals(value) {
    return Math.round(value * 100) / 100;
  }

  async _syncSettingIfChanged(key, value) {
    const current = this.getSetting(key);
    if (current === value) return;

    try {
      await this.setSettings({ [key]: value });
    } catch (err) {
      this.error(`Failed to sync setting '${key}' from device report:`, err);
    }
  }

  async onNodeInit({ zclNode }) {

    this._onTuyaResponse = (response) => {
      this.updatePosition(response).catch(err => this.error('Failed to handle Tuya response:', err));
    };
    this._onTuyaReporting = (report) => {
      this.updatePosition(report).catch(err => this.error('Failed to handle Tuya report:', err));
    };
    zclNode.endpoints[1].clusters.tuya.on("response", this._onTuyaResponse);
    zclNode.endpoints[1].clusters.tuya.on("reporting", this._onTuyaReporting);

  }

  async updatePosition(data) {
    const dp = data.dp;
    const value = getDataValue(data);
    const distanceUpdateInterval = this.getSetting('distance_update_interval') ?? 10;

    switch (dp) {
      case dataPoints.tshpsPresenceState:
        this.log("presence state: " + value)
        await this.setCapabilityValue('alarm_motion', Boolean(value));
        break;
      case dataPoints.tshpscSensitivity:
        this.log("sensitivity state: " + value)
        await this._syncSettingIfChanged('radar_sensitivity', value);
        break;
      case dataPoints.tshpsIlluminanceLux:
        this.log("lux value: " + value)
        await this.onIlluminanceMeasuredAttributeReport(value);
        break;
      case dataPoints.tshpsMinimumRange: {
        const minimumRange = this._roundToTwoDecimals(value / 100);
        this.log("minimum range: " + minimumRange)
        await this._syncSettingIfChanged('minimum_range', minimumRange);
        break;
      }
      case dataPoints.tshpsMaximumRange: {
        const maximumRange = this._roundToTwoDecimals(value / 100);
        this.log("maximum range: " + maximumRange)
        await this._syncSettingIfChanged('maximum_range', maximumRange);
        break;
      }
      case dataPoints.tshpsTargetDistance:
        const currentTime = new Date().getTime();
        if (currentTime - this.lastDistanceUpdateTime >= distanceUpdateInterval * 1000) {
          const targetDistance = value / 100;
          await this.setCapabilityValue('target_distance', targetDistance);
          this.lastDistanceUpdateTime = currentTime;
        }
        break;
      case dataPoints.tshpsFadingTime: {
        const fadingTime = this._roundToSingleDecimal(value / 10);
        this.log("fading time: " + fadingTime)
        await this._syncSettingIfChanged('fading_time', fadingTime);
        break;
      }
      case dataPoints.tshpsDetectionDelay: {
        const detectionDelay = this._roundToSingleDecimal(value / 10);
        this.log("detection delay: " + detectionDelay)
        await this._syncSettingIfChanged('detection_delay', detectionDelay);
        break;
      }
      default:
        this.log('dp value', dp, value)
    }
  }

  onDeleted() {
    if (this.zclNode && this.zclNode.endpoints[1].clusters.tuya && this._onTuyaResponse) {
      this.zclNode.endpoints[1].clusters.tuya.removeListener("response", this._onTuyaResponse);
      this._onTuyaResponse = null;
    }
    if (this.zclNode && this.zclNode.endpoints[1].clusters.tuya && this._onTuyaReporting) {
      this.zclNode.endpoints[1].clusters.tuya.removeListener("reporting", this._onTuyaReporting);
      this._onTuyaReporting = null;
    }
    this.log("Radar sensor removed");
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('radar_sensitivity')) {
      await this.writeData32(dataPoints.tshpscSensitivity, newSettings.radar_sensitivity, { throwOnError: true });
    }

    if (changedKeys.includes('minimum_range')) {
      await this.writeData32(dataPoints.tshpsMinimumRange, Math.round(newSettings.minimum_range * 100), { throwOnError: true });
    }

    if (changedKeys.includes('maximum_range')) {
      await this.writeData32(dataPoints.tshpsMaximumRange, Math.round(newSettings.maximum_range * 100), { throwOnError: true });
    }

    if (changedKeys.includes('detection_delay')) {
      await this.writeData32(dataPoints.tshpsDetectionDelay, Math.round(newSettings.detection_delay * 10), { throwOnError: true });
    }

    if (changedKeys.includes('fading_time')) {
      await this.writeData32(dataPoints.tshpsFadingTime, Math.round(newSettings.fading_time * 10), { throwOnError: true });
    }
  }

  async onIlluminanceMeasuredAttributeReport(measuredValue) {
    this.log('measure_luminance | Luminance - measuredValue (lux):', measuredValue);
    await this.setCapabilityValue('measure_luminance', measuredValue);
  }

  onIASZoneStatusChangeNotification({ zoneStatus, extendedStatus, zoneId, delay, }) {
    this.log('IASZoneStatusChangeNotification received:', zoneStatus, extendedStatus, zoneId, delay);
    this.setCapabilityValue('alarm_motion', zoneStatus.alarm1);
  }

}

module.exports = radarSensor2;
