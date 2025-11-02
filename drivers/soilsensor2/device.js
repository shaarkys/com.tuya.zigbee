'use strict';

const { Cluster, CLUSTER } = require('zigbee-clusters');

const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { getDataValue } = require('../../lib/TuyaHelpers');
const {
  V1_SOIL_SENSOR_DATA_POINTS: DP_V1,
  V2_SOIL_SENSOR_DATA_POINTS: DP_V2,
} = require('../../lib/TuyaDataPoints');

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
const CAP_OLD_SOIL_MOISTURE = 'soil_moisture';
const CAP_OLD_ALARM_MOISTURE = 'alarm_water';

class SoilSensorC3007Device extends TuyaSpecificClusterDevice {

  _displayUnit = 'celsius';
  _displayUnitDp = DP_V2.displayUnit;
  _lastDryFromDevice = null;
  _lastSoilMoisture = undefined;
  _lastTemperatureRaw = undefined;
  _supportsV1 = false;
  _supportsV2 = false;
  _hasZclTemperature = false;
  _hasZclHumidity = false;
  _hasZclBattery = false;

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    await this._migrateCapabilities();

    this._displayUnit = this.getSetting('display_unit') || 'celsius';

    this.printNode();

    const endpoint = zclNode.endpoints?.[1];
    if (!endpoint) {
      this.error('Missing endpoint 1 on node');
      return;
    }

    this._registerZclCapabilities(endpoint);

    const tuyaCluster = endpoint.clusters?.tuya;
    if (tuyaCluster) {
      tuyaCluster.on('reporting', dpValue => this._handleTuyaDatapoint(dpValue));
      tuyaCluster.on('response', dpValue => this._handleTuyaDatapoint(dpValue));

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
      this.error('Error when reading device attributes', err);
    }
  }

  _registerZclCapabilities(endpoint) {
    if (endpoint.clusters?.temperatureMeasurement) {
      try {
        this.registerCapability('measure_temperature', CLUSTER.TEMPERATURE_MEASUREMENT, {
          get: 'measuredValue',
          report: 'measuredValue',
          reportParser: value => (typeof value === 'number' ? value / 100 : null),
          getOpts: { getOnStart: true, getOnOnline: true },
        });
        this._hasZclTemperature = true;
      } catch (err) {
        this.log('TemperatureMeasurement registration failed:', err?.message || err);
        this._hasZclTemperature = false;
      }
    }

    if (endpoint.clusters?.relativeHumidity) {
      try {
        this.registerCapability('measure_humidity', CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT, {
          get: 'measuredValue',
          report: 'measuredValue',
          reportParser: value => {
            if (typeof value !== 'number') return null;
            return Math.max(0, Math.min(100, value / 100));
          },
          getOpts: { getOnStart: true, getOnOnline: true },
        });
        this._hasZclHumidity = true;
      } catch (err) {
        this.log('RelativeHumidity registration failed:', err?.message || err);
        this._hasZclHumidity = false;
      }
    }

    if (endpoint.clusters?.powerConfiguration) {
      try {
        this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
          get: 'batteryPercentageRemaining',
          report: 'batteryPercentageRemaining',
          reportParser: value => (typeof value === 'number' ? Math.round(value / 2) : null),
          getOpts: { getOnStart: true, getOnOnline: true },
        });
        this._hasZclBattery = true;
      } catch (err) {
        this.log('PowerConfiguration registration failed:', err?.message || err);
        this._hasZclBattery = false;
      }
    }
  }

  _handleTuyaDatapoint(dpValue) {
    const dp = dpValue?.dp;
    if (typeof dp !== 'number') return;

    const value = getDataValue(dpValue);
    this.debug('Tuya DP', dp, 'value', value);

    switch (dp) {
      case DP_V2.dryAlarm:
        this._supportsV2 = true;
        this._updateDryAlarm(value);
        break;
      case DP_V2.soilMoisture:
        this._supportsV2 = true;
        this._updateSoilMoisture(value);
        break;
      case DP_V2.temperature:
        this._supportsV2 = true;
        this._updateTemperature(value);
        break;
      case DP_V2.humidity:
        this._supportsV2 = true;
        this._updateAmbientHumidity(value);
        break;
      case DP_V2.batteryPercentage:
        this._supportsV2 = true;
        this._updateBattery(value);
        break;
      case DP_V2.soilMoistureCalibration:
        this._supportsV2 = true;
        this._updateSettingFromDevice('soil_moisture_calibration', this._toSigned(value));
        break;
      case DP_V2.temperatureCalibration:
        this._supportsV2 = true;
        this._updateSettingFromDevice('temperature_calibration', this._toSigned(value) / 10);
        break;
      case DP_V2.humidityCalibration:
        this._supportsV2 = true;
        this._updateSettingFromDevice('humidity_calibration', this._toSigned(value));
        break;
      case DP_V2.displayUnit:
        this._supportsV2 = true;
        this._updateDisplayUnit(value, DP_V2.displayUnit);
        break;
      case DP_V2.alarmSoilMoistureMin:
        this._supportsV2 = true;
        this._updateSettingFromDevice('alarm_soil_moisture_min', Number(value));
        if (this._lastDryFromDevice === null) {
          this._maybeUpdateDryAlarm();
        }
        break;
      case DP_V2.temperatureSampling:
        this._supportsV2 = true;
        this._updateSettingFromDevice('temperature_sampling', Number(value));
        break;
      case DP_V2.soilMoistureSampling:
        this._supportsV2 = true;
        this._updateSettingFromDevice('soil_moisture_sampling', Number(value));
        break;
      case DP_V1.humidity:
        this._supportsV1 = true;
        this._updateSoilMoisture(value);
        if (!this._supportsV2 && !this._hasZclHumidity) {
          this._updateAmbientHumidity(value, true);
        }
        break;
      case DP_V1.temperature:
        this._supportsV1 = true;
        this._updateTemperature(value);
        break;
      case DP_V1.temperatureUnit:
        this._supportsV1 = true;
        this._updateDisplayUnit(value, DP_V1.temperatureUnit);
        break;
      case DP_V1.batteryState:
        this._supportsV1 = true;
        this._updateBatteryState(value);
        break;
      case DP_V1.batteryPercentage:
        this._supportsV1 = true;
        this._updateBattery(value);
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

  _updateAmbientHumidity(raw, force = false) {
    if (this._hasZclHumidity && !force) return;

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

  _updateBatteryState(raw) {
    if (!this.hasCapability('alarm_battery')) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const low = value <= 1;
    this.setCapabilityValue('alarm_battery', low).catch(this.error);
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
    if (!Number.isFinite(currentMoisture)) return;

    const threshold = Number(this.getSetting('alarm_soil_moisture_min')) || 0;
    if (threshold <= 0) {
      return;
    }

    const dry = currentMoisture <= threshold;
    this.setCapabilityValue(CAP_ALARM_MOISTURE, dry).catch(this.error);
  }

  _toSigned(value) {
    const int = Number(value);
    if (!Number.isFinite(int)) return int;
    const normalized = int & 0xFFFF;
    return normalized >= 0x8000 ? normalized - 0x10000 : normalized;
  }

  _toUnsigned16(value) {
    const int = Math.round(Number(value));
    if (!Number.isFinite(int)) return 0;
    return int < 0 ? (0x10000 + int) & 0xFFFF : int & 0xFFFF;
  }

  async onSettings({ newSettings, changedKeys }) {
    const tasks = [];

    for (const key of changedKeys) {
      switch (key) {
        case 'soil_moisture_calibration':
          if (this._supportsV1 && !this._supportsV2) {
            this.log('Skipping soil_moisture_calibration write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.soilMoistureCalibration, this._toUnsigned16(newSettings[key])));
          break;
        case 'temperature_calibration':
          if (this._supportsV1 && !this._supportsV2) {
            this.log('Skipping temperature_calibration write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.temperatureCalibration, this._toUnsigned16(newSettings[key] * 10)));
          break;
        case 'humidity_calibration':
          if (this._supportsV1 && !this._supportsV2) {
            this.log('Skipping humidity_calibration write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.humidityCalibration, this._toUnsigned16(newSettings[key])));
          break;
        case 'display_unit': {
          const enumValue = DISPLAY_UNIT_VALUE[newSettings[key]] ?? 0;
          const targetDp = (this._supportsV1 && !this._supportsV2)
            ? DP_V1.temperatureUnit
            : (this._displayUnitDp || DP_V2.displayUnit);
          tasks.push(
            this.writeEnum(targetDp, enumValue)
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
          if (this._supportsV1 && !this._supportsV2) {
            if (this._lastDryFromDevice === null) {
              this._maybeUpdateDryAlarm();
            }
            this.log('Skipping alarm_soil_moisture_min write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.alarmSoilMoistureMin, Number(newSettings[key])));
          tasks.push(Promise.resolve().then(() => {
            if (this._lastDryFromDevice === null) {
              this._maybeUpdateDryAlarm();
            }
          }));
          break;
        case 'temperature_sampling':
          if (this._supportsV1 && !this._supportsV2) {
            this.log('Skipping temperature_sampling write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.temperatureSampling, Number(newSettings[key])));
          break;
        case 'soil_moisture_sampling':
          if (this._supportsV1 && !this._supportsV2) {
            this.log('Skipping soil_moisture_sampling write: device reports legacy datapoints only.');
            break;
          }
          tasks.push(this.writeData32(DP_V2.soilMoistureSampling, Number(newSettings[key])));
          break;
        default:
          break;
      }
    }

    await Promise.all(tasks);
  }

  onDeleted() {
    this.log('Soil sensor removed');
  }

  async _migrateCapabilities() {
    await this._ensureCapability(CAP_MEASURE_MOISTURE);
    await this._ensureCapability(CAP_ALARM_MOISTURE);

    const oldMoisture = this.getCapabilityValue(CAP_OLD_SOIL_MOISTURE);
    if (this.hasCapability(CAP_MEASURE_MOISTURE) && oldMoisture !== null && oldMoisture !== undefined) {
      try {
        await this.setCapabilityValue(CAP_MEASURE_MOISTURE, oldMoisture);
      } catch (err) {
        this.error('Failed to copy soil moisture value:', err);
      }
    }

    const oldAlarm = this.getCapabilityValue(CAP_OLD_ALARM_MOISTURE);
    if (this.hasCapability(CAP_ALARM_MOISTURE) && oldAlarm !== null && oldAlarm !== undefined) {
      try {
        await this.setCapabilityValue(CAP_ALARM_MOISTURE, oldAlarm);
      } catch (err) {
        this.error('Failed to copy soil moisture alarm value:', err);
      }
    }

    if (this.hasCapability(CAP_OLD_SOIL_MOISTURE)) {
      try {
        await this.removeCapability(CAP_OLD_SOIL_MOISTURE);
      } catch (err) {
        this.error('Failed to remove legacy soil_moisture capability:', err);
      }
    }

    if (this.hasCapability(CAP_OLD_ALARM_MOISTURE)) {
      try {
        await this.removeCapability(CAP_OLD_ALARM_MOISTURE);
      } catch (err) {
        this.error('Failed to remove legacy alarm_water capability:', err);
      }
    }
  }

  async _ensureCapability(capabilityId) {
    if (this.hasCapability(capabilityId)) return;
    try {
      await this.addCapability(capabilityId);
    } catch (err) {
      this.error(`Failed to add capability ${capabilityId}:`, err);
    }
  }
}

module.exports = SoilSensorC3007Device;
