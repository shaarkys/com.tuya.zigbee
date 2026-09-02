'use strict';

const { Cluster } = require('zigbee-clusters');

const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { getDataValue } = require('../../lib/TuyaHelpers');
const { V2_SOIL_SENSOR_DATA_POINTS: DP } = require('../../lib/TuyaDataPoints');

Cluster.addCluster(TuyaSpecificCluster);

const DISPLAY_UNIT_MAP = {
  0: 'celsius',
  1: 'fahrenheit',
};

const DISPLAY_UNIT_VALUE = {
  celsius: 0,
  fahrenheit: 1,
};

const CAP_MEASURE_MOISTURE = 'measure_moisture';
const CAP_ALARM_MOISTURE = 'alarm_moisture';

class SoilSensorC3007Device extends TuyaSpecificClusterDevice {

  _displayUnit = 'celsius';
  _displayUnitDp = DP.displayUnit;
  _lastDryFromDevice = null;
  _lastSoilMoisture = undefined;
  _lastTemperatureRaw = undefined;
  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this._displayUnit = this.getSetting('display_unit') || 'celsius';

    this.printNode();

    const endpoint = zclNode.endpoints?.[1];
    if (!endpoint) {
      this.error('Missing endpoint 1 on node');
      return;
    }

    const tuyaCluster = endpoint.clusters?.tuya;
    if (tuyaCluster) {
      this._onTuyaReporting = dpValue => this._handleTuyaDatapoint(dpValue);
      this._onTuyaResponse = dpValue => this._handleTuyaDatapoint(dpValue);
      tuyaCluster.on('reporting', this._onTuyaReporting);
      tuyaCluster.on('response', this._onTuyaResponse);

      try {
        await tuyaCluster.dataQuery();
      } catch (err) {
        this.log('Tuya dataQuery failed (device may not support it):', err?.message || err);
      }
    } else {
      this.error('Tuya cluster not available on endpoint 1');
    }

    try {
      await endpoint.clusters.basic.readAttributes([
        'manufacturerName',
        'zclVersion',
        'appVersion',
        'modelId',
        'powerSource',
        'attributeReportingStatus',
      ]);
    } catch (err) {
      this.log('Device attribute read failed (probably sleeping):', err?.message || err);
    }
  }

  _handleTuyaDatapoint(dpValue) {
    const dp = dpValue?.dp;
    if (typeof dp !== 'number') return;

    const value = getDataValue(dpValue);
    this.debug('Tuya DP', dp, 'value', value);

    switch (dp) {
      case DP.dryAlarm:
        this._updateDryAlarm(value);
        break;
      case DP.soilMoisture:
        this._updateSoilMoisture(value);
        break;
      case DP.temperature:
        this._updateTemperature(value);
        break;
      case DP.humidity:
        this._updateAmbientHumidity(value);
        break;
      case DP.batteryPercentage:
        this._updateBattery(value);
        break;
      case DP.soilMoistureCalibration:
        this._updateSettingFromDevice('soil_moisture_calibration', this._toSigned(value));
        break;
      case DP.temperatureCalibration:
        this._updateSettingFromDevice('temperature_calibration', this._toSigned(value) / 10);
        break;
      case DP.humidityCalibration:
        this._updateSettingFromDevice('humidity_calibration', this._toSigned(value));
        break;
      case DP.displayUnit:
        this._updateDisplayUnit(value, DP.displayUnit);
        break;
      case DP.alarmSoilMoistureMin:
        this._updateSettingFromDevice('alarm_soil_moisture_min', Number(value));
        if (this._lastDryFromDevice === null) {
          this._maybeUpdateDryAlarm();
        }
        break;
      case DP.temperatureSampling:
        this._updateSettingFromDevice('temperature_sampling', Number(value));
        break;
      case DP.soilMoistureSampling:
        this._updateSettingFromDevice('soil_moisture_sampling', Number(value));
        break;
      default:
        this.log('Unhandled Tuya datapoint', dp, value);
    }
  }

  _updateDryAlarm(raw) {
    const dry = !!raw;
    this._lastDryFromDevice = dry;

    if (this.hasCapability(CAP_ALARM_MOISTURE)) {
      this.setCapabilityValue(CAP_ALARM_MOISTURE, dry).catch(this.error);
    }
  }

  _updateSoilMoisture(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    this._lastSoilMoisture = value;

    if (this.hasCapability(CAP_MEASURE_MOISTURE)) {
      const clamped = Math.max(0, Math.min(100, value));
      this.setCapabilityValue(CAP_MEASURE_MOISTURE, clamped).catch(this.error);
    }

    if (this._lastDryFromDevice === null) {
      this._maybeUpdateDryAlarm(value);
    }
  }

  _updateTemperature(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    this._lastTemperatureRaw = value;

    const celsius = value / 10;

    if (this.hasCapability('measure_temperature')) {
      this.setCapabilityValue('measure_temperature', Number(celsius.toFixed(2))).catch(this.error);
    }
  }

  _updateAmbientHumidity(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    if (this.hasCapability('measure_humidity')) {
      const clamped = Math.max(0, Math.min(100, value));
      this.setCapabilityValue('measure_humidity', clamped).catch(this.error);
    }
  }

  _updateBattery(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    if (this.hasCapability('measure_battery')) {
      const clamped = Math.max(0, Math.min(100, value));
      this.setCapabilityValue('measure_battery', clamped).catch(this.error);

      if (this.hasCapability('alarm_battery')) {
        const low = clamped <= 20;
        this.setCapabilityValue('alarm_battery', low).catch(this.error);
      }
    }
  }

  _updateDisplayUnit(raw, dpId) {
    if (typeof dpId === 'number') {
      this._displayUnitDp = dpId;
    }
    const unit = DISPLAY_UNIT_MAP[Number(raw)] || 'celsius';
    this._displayUnit = unit;
    this._updateSettingFromDevice('display_unit', unit);

    if (typeof this._lastTemperatureRaw === 'number') {
      this._updateTemperature(this._lastTemperatureRaw);
    }
  }

  _updateSettingFromDevice(key, value) {
    if (value === undefined || value === null || Number.isNaN(value)) return;
    const current = this.getSetting(key);
    if (current === value) return;

    this.setSettings({ [key]: value }).catch(err => {
      this.log(`Failed to sync setting ${key} from device:`, err?.message || err);
    });
  }

  _maybeUpdateDryAlarm(currentMoisture = this._lastSoilMoisture) {
    if (!this.hasCapability(CAP_ALARM_MOISTURE)) return;

    const threshold = Number(this.getSetting('alarm_soil_moisture_min')) || 0;
    if (threshold <= 0) {
      this.setCapabilityValue(CAP_ALARM_MOISTURE, false).catch(this.error);
      return;
    }
    if (!Number.isFinite(currentMoisture)) return;

    const dry = currentMoisture <= threshold;
    this.setCapabilityValue(CAP_ALARM_MOISTURE, dry).catch(this.error);
  }

  _toSigned(value) {
    const int = Number(value);
    if (!Number.isFinite(int)) return int;
    const normalized = int >>> 0;
    return normalized >= 0x80000000 ? normalized - 0x100000000 : normalized;
  }

  async onSettings({ newSettings, changedKeys }) {
    const tasks = [];

    for (const key of changedKeys) {
      switch (key) {
        case 'soil_moisture_calibration':
          tasks.push(this.writeData32(DP.soilMoistureCalibration, Math.round(Number(newSettings[key])), { throwOnError: true }));
          break;
        case 'temperature_calibration':
          tasks.push(this.writeData32(DP.temperatureCalibration, Math.round(Number(newSettings[key]) * 10), { throwOnError: true }));
          break;
        case 'humidity_calibration':
          tasks.push(this.writeData32(DP.humidityCalibration, Math.round(Number(newSettings[key])), { throwOnError: true }));
          break;
        case 'display_unit': {
          const enumValue = DISPLAY_UNIT_VALUE[newSettings[key]] ?? 0;
          const targetDp = this._displayUnitDp || DP.displayUnit;
          tasks.push(
            this.writeEnum(targetDp, enumValue, { throwOnError: true })
              .then(() => {
                this._displayUnit = newSettings[key];
                if (typeof this._lastTemperatureRaw === 'number') {
                  this._updateTemperature(this._lastTemperatureRaw);
                }
              })
          );
          break;
        }
        case 'alarm_soil_moisture_min':
          tasks.push(this.writeData32(DP.alarmSoilMoistureMin, Math.round(Number(newSettings[key])), { throwOnError: true }));
          tasks.push(Promise.resolve().then(() => {
            if (Number(newSettings[key]) <= 0 || this._lastDryFromDevice === null) {
              this._maybeUpdateDryAlarm();
            }
          }));
          break;
        case 'temperature_sampling':
          tasks.push(this.writeData32(DP.temperatureSampling, Math.round(Number(newSettings[key])), { throwOnError: true }));
          break;
        case 'soil_moisture_sampling':
          tasks.push(this.writeData32(DP.soilMoistureSampling, Math.round(Number(newSettings[key])), { throwOnError: true }));
          break;
        default:
          break;
      }
    }

    await Promise.all(tasks);
  }

  onDeleted() {
    const tuyaCluster = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuyaCluster && this._onTuyaReporting) tuyaCluster.removeListener('reporting', this._onTuyaReporting);
    if (tuyaCluster && this._onTuyaResponse) tuyaCluster.removeListener('response', this._onTuyaResponse);
    this._onTuyaReporting = null;
    this._onTuyaResponse = null;
    this.log('Soil sensor removed');
  }
}

module.exports = SoilSensorC3007Device;


