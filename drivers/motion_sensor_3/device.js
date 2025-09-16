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
  illuminance: 106,          // value (lux or interval config)
  indicator: 108,            // bool (LED on device)
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
    // Listen for Tuya responses (reports come via response on many devices)
    zclNode.endpoints[1].clusters.tuya.on('response', (resp) => this.updateFromTuya(resp));
    zclNode.endpoints[1].clusters.tuya.on('reporting', (resp) => this.updateFromTuya(resp));
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
        const temperatureOffset = this.getSetting('temperature_offset') || 0;
        const decimals2 = this.getSetting('temperature_decimals') === '2';
        const rawC = (value / 10);
        const parsed = decimals2 ? Math.round(rawC * 100) / 100 : Math.round(rawC * 10) / 10;
        this.log('measure_temperature:', parsed, '+ offset', temperatureOffset);
        await this.setCapabilityValue('measure_temperature', parsed + temperatureOffset).catch(this.error);
        break;
      }
      case dataPoints.humidity: {
        const humidity = value; // reported as %
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
        const percent = value;
        const batteryThreshold = this.getSetting('batteryThreshold') || 20;
        this.log('measure_battery (%):', percent);
        await this.setCapabilityValue('measure_battery', percent).catch(this.error);
        await this.setCapabilityValue('alarm_battery', percent < batteryThreshold).catch(this.error);
        break;
      }
      case dataPoints.sensitivity:
        this.log('sensitivity:', value);
        break;
      case dataPoints.fadingTime:
        this.log('fadingTime (s):', value);
        break;
      case dataPoints.temperatureOffset: {
        // Device reports offset in 0.1°C steps
        const reported = Number(value) / 10;
        const cur = Number(this.getSetting('temperature_offset') || 0);
        if (!Number.isNaN(reported) && reported !== cur) {
          this.log('temperature_offset reported (°C):', reported);
          try { await this.setSettings({ temperature_offset: reported }); } catch (e) { this.error(e); }
        }
        break;
      }
      case dataPoints.humidityOffset: {
        const reported = Number(value);
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
      case 107: // observed on some firmwares; purpose unknown (enum/value)
        this.log('dp107 (vendor-specific):', value);
        break;
      case 109: // observed heartbeat/unused on this firmware
        // too chatty in logs; keep at debug
        this.debug ? this.debug('dp109 (vendor-specific):', value) : this.log('dp109 (vendor-specific):', value);
        break;
      default:
        this.log('Unhandled dp', dp, 'value', value);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('radar_sensitivity')) {
      // If scaling is needed, adjust here (e.g., value * 10)
      await this.writeData32(dataPoints.sensitivity, newSettings['radar_sensitivity']);
    }

    if (changedKeys.includes('fading_time')) {
      await this.writeData32(dataPoints.fadingTime, newSettings['fading_time']);
    }

    if (changedKeys.includes('illuminance_interval')) {
      // Z2M docs: interval in minutes (1..720)
      await this.writeData32(dataPoints.illuminance, newSettings['illuminance_interval']);
    }

    if (changedKeys.includes('temperature_offset')) {
      // Device expects offset in 0.1°C steps
      const val = Math.round((newSettings['temperature_offset'] || 0) * 10);
      await this.writeData32(dataPoints.temperatureOffset, val);
    }

    if (changedKeys.includes('humidity_offset')) {
      const val = Number(newSettings['humidity_offset']) || 0;
      await this.writeData32(dataPoints.humidityOffset, val);
    }

    if (changedKeys.includes('indicator')) {
      await this.writeBool(dataPoints.indicator, Boolean(newSettings['indicator']));
    }
  }

  onDeleted() {
    this.log('Motion Sensor 3 removed');
  }
}

module.exports = motion_sensor_3;
