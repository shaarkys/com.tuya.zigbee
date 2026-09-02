'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

// Datapoints for TUYA TS0601 Human Presence Sensor (Type H)
const dataPoints = {
  occupancy: 1,              // bool
  sensitivity: 2,            // value (1..19)
  humidity: 101,             // value (%)
  fadingTime: 102,           // value (s)
  humidityOffset: 104,       // value
  temperatureOffset: 105,    // value (x10)
  illuminance: 106,          // value (lux)
  illuminanceInterval: 107,  // value (minutes)
  indicator: 108,            // bool (LED on device)
  temperatureUnit: 109,      // enum | 0: Celsius, 1: Fahrenheit
  battery: 110,              // value (%)
  temperature: 111,          // value (°C x10)
};

const dataTypes = {
  raw: 0,
  bool: 1,
  value: 2,
  string: 3,
  enum: 4,
  bitmap: 5,
};

const convertMultiByteNumberPayloadToSingleDecimalNumber = (chunks) => {
  let value = 0;
  for (let i = 0; i < chunks.length; i++) {
    value = (value << 8) + chunks[i];
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
    case dataTypes.string: {
      let s = '';
      for (let i = 0; i < dpValue.data.length; ++i) s += String.fromCharCode(dpValue.data[i]);
      return s;
    }
    case dataTypes.enum:
      return dpValue.data[0];
    case dataTypes.bitmap:
      return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    default:
      return null;
  }
};

class motion_sensor_3 extends TuyaSpecificClusterDevice {
  async onNodeInit({ zclNode }) {
    this._onTuyaResponse = resp => this.updateFromTuya(resp).catch(err => this.error('Failed to handle Tuya response:', err));
    this._onTuyaReporting = resp => this.updateFromTuya(resp).catch(err => this.error('Failed to handle Tuya report:', err));
    zclNode.endpoints[1].clusters.tuya.on('response', this._onTuyaResponse);
    zclNode.endpoints[1].clusters.tuya.on('reporting', this._onTuyaReporting);
  }

  async updateFromTuya(data) {
    const dp = data.dp;
    const value = getDataValue(data);

    switch (dp) {
      case dataPoints.occupancy:
        this.log('occupancy:', value);
        await this.setCapabilityValue('alarm_motion', Boolean(value)).catch(this.error);
        break;
      case dataPoints.temperature: {
        const decimals2 = this.getSetting('temperature_decimals') === '2';
        const rawC = (value / 10);
        const parsed = decimals2 ? Math.round(rawC * 100) / 100 : Math.round(rawC * 10) / 10;
        this.log('measure_temperature:', parsed);
        await this.setCapabilityValue('measure_temperature', parsed).catch(this.error);
        break;
      }
      case dataPoints.humidity: {
        const humidity = Math.max(0, Math.min(100, Number(value)));
        if (!Number.isFinite(humidity)) return;
        this.log('measure_humidity:', humidity);
        await this.setCapabilityValue('measure_humidity', humidity).catch(this.error);
        break;
      }
      case dataPoints.illuminance: {
        const lux = value;
        this.log('measure_luminance (lux):', lux);
        await this.setCapabilityValue('measure_luminance', lux).catch(this.error);
        break;
      }
      case dataPoints.battery: {
        const percent = Math.max(0, Math.min(100, Number(value)));
        if (!Number.isFinite(percent)) return;
        const batteryThreshold = this.getSetting('batteryThreshold') || 20;
        this.log('measure_battery (%):', percent);
        await this.setCapabilityValue('measure_battery', percent).catch(this.error);
        await this.setCapabilityValue('alarm_battery', percent < batteryThreshold).catch(this.error);
        break;
      }
      case dataPoints.sensitivity: {
        const reported = Number(value);
        if (Number.isFinite(reported)) await this._syncSettingIfChanged('radar_sensitivity', reported);
        break;
      }
      case dataPoints.fadingTime: {
        const reported = Number(value);
        if (Number.isFinite(reported)) await this._syncSettingIfChanged('fading_time', reported);
        break;
      }
      case dataPoints.temperatureOffset: {
        const reported = this._toSignedData32(value) / 10;
        const cur = Number(this.getSetting('temperature_offset') || 0);
        if (!Number.isNaN(reported) && reported !== cur) {
          this.log('temperature_offset reported (°C):', reported);
          try { await this.setSettings({ temperature_offset: reported }); } catch (e) { this.error(e); }
        }
        break;
      }
      case dataPoints.humidityOffset: {
        const reported = this._toSignedData32(value);
        const cur = Number(this.getSetting('humidity_offset') || 0);
        if (!Number.isNaN(reported) && reported !== cur) {
          this.log('humidity_offset reported (%):', reported);
          try { await this.setSettings({ humidity_offset: reported }); } catch (e) { this.error(e); }
        }
        break;
      }
      case dataPoints.indicator: {
        const reported = Boolean(value);
        const cur = !!this.getSetting('indicator');
        if (reported !== cur) {
          this.log('indicator state reported:', reported);
          try { await this.setSettings({ indicator: reported }); } catch (e) { this.error(e); }
        }
        break;
      }
      case dataPoints.illuminanceInterval: {
        const reported = Number(value);
        const current = Number(this.getSetting('illuminance_interval'));
        if (Number.isFinite(reported) && reported !== current) {
          await this._syncSettingIfChanged('illuminance_interval', reported);
        }
        break;
      }
      case dataPoints.temperatureUnit:
        await this._syncSettingIfChanged('temperature_unit', Number(value) === 1 ? 'fahrenheit' : 'celsius');
        break;
      default:
        this.log('Unhandled dp', dp, 'value', value);
    }
  }

  _toSignedData32(value) {
    const integer = Number(value);
    if (!Number.isFinite(integer)) return integer;
    const normalized = integer >>> 0;
    return normalized >= 0x80000000 ? normalized - 0x100000000 : normalized;
  }

  async _syncSettingIfChanged(key, value) {
    if (this.getSetting(key) === value) return;
    try {
      await this.setSettings({ [key]: value });
    } catch (err) {
      this.error(`Failed to sync setting '${key}' from device report:`, err);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('radar_sensitivity')) {
      await this.writeData32(dataPoints.sensitivity, newSettings.radar_sensitivity, { throwOnError: true });
    }

    if (changedKeys.includes('fading_time')) {
      await this.writeData32(dataPoints.fadingTime, newSettings.fading_time, { throwOnError: true });
    }

    if (changedKeys.includes('illuminance_interval')) {
      await this.writeData32(dataPoints.illuminanceInterval, newSettings.illuminance_interval, { throwOnError: true });
    }

    if (changedKeys.includes('temperature_offset')) {
      const val = Math.round((newSettings['temperature_offset'] || 0) * 10);
      await this.writeData32(dataPoints.temperatureOffset, val, { throwOnError: true });
    }

    if (changedKeys.includes('humidity_offset')) {
      const val = Number(newSettings['humidity_offset']) || 0;
      await this.writeData32(dataPoints.humidityOffset, val, { throwOnError: true });
    }

    if (changedKeys.includes('indicator')) {
      await this.writeBool(dataPoints.indicator, Boolean(newSettings.indicator), { throwOnError: true });
    }

    if (changedKeys.includes('temperature_unit')) {
      const unit = newSettings.temperature_unit === 'fahrenheit' ? 1 : 0;
      await this.writeEnum(dataPoints.temperatureUnit, unit, { throwOnError: true });
    }
  }

  onDeleted() {
    const tuyaCluster = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuyaCluster && this._onTuyaResponse) tuyaCluster.removeListener('response', this._onTuyaResponse);
    if (tuyaCluster && this._onTuyaReporting) tuyaCluster.removeListener('reporting', this._onTuyaReporting);
    this._onTuyaResponse = null;
    this._onTuyaReporting = null;
    this.log('Motion Sensor 3 removed');
  }
}

module.exports = motion_sensor_3;
