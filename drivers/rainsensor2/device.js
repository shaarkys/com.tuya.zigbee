'use strict';

const { Cluster, CLUSTER } = require('zigbee-clusters');

const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { getDataValue, convertMultiByteNumberPayloadToSingleDecimalNumber } = require('../../lib/TuyaHelpers');

Cluster.addCluster(TuyaSpecificCluster);

const DP = {
  BATTERY_PCT: 0x04,
  ILLUMINANCE: 0x65,
  ILLUMINANCE_AVERAGE_20MIN: 0x66,
  ILLUMINANCE_MAX_TODAY: 0x67,
  CLEANING_REMINDER: 0x68,
  RAIN_INTENSITY: 0x69,
};

class RainSensor2 extends TuyaSpecificClusterDevice {

  _lastRain = null;
  _deviceLabel = null;

  _composeDeviceLabel() {
    try {
      const name = typeof this.getName === 'function' ? this.getName() : null;
      const data = typeof this.getData === 'function' ? this.getData() : null;
      const token = data && (data.token || data.id);
      if (name && token) return `${name} (${token})`;
      return name || token || 'unknown device';
    } catch (err) {
      this.debug('Failed to compose device label', err);
      return 'unknown device';
    }
  }

  _getDeviceLabel() {
    if (!this._deviceLabel) {
      this._deviceLabel = this._composeDeviceLabel();
    }
    return this._deviceLabel;
  }

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });
    this.printNode();
    this._deviceLabel = this._composeDeviceLabel();

    try {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        get: 'batteryPercentageRemaining',
        report: 'batteryPercentageRemaining',
        reportParser: v => Math.max(0, Math.min(100, Math.round((v || 0) / 2))),
        getOpts: { getOnStart: true, getOnOnline: true },
      });
    } catch (e) {
      this.log('Battery % not available:', e?.message || e);
    }

    const illuminanceCluster = zclNode.endpoints[1]?.clusters?.illuminanceMeasurement;
    if (illuminanceCluster) {
      try {
        this.registerCapability('measure_luminance', CLUSTER.ILLUMINANCE_MEASUREMENT, {
          get: 'measuredValue',
          report: 'measuredValue',
          reportParser: value => {
            if (typeof value !== 'number') return null;
            const lux = Math.round(Math.pow(10, (value - 1) / 10000));
            return this._applyLuxCalibration(lux);
          },
          getOpts: { getOnStart: true, getOnOnline: true },
        });
      } catch (e) {
        this.log('IlluminanceMeasurement not usable, will rely on Tuya EF00:', e?.message || e);
      }
    } else {
      this.log('IlluminanceMeasurement cluster missing; using Tuya EF00 illuminance datapoint.');
    }

    try {
      const tuya = zclNode.endpoints[1].clusters.tuya;
      tuya.on('reporting', frame => this._handleTuyaDp(frame));
      tuya.on('response', frame => this._handleTuyaDp(frame));
      try {
        await tuya.dataQuery();
      } catch (err) {
        this.log('Tuya dataQuery failed (device may not support it):', err?.message || err);
      }
    } catch (e) {
      this.log('Tuya EF00 cluster not available:', e?.message || e);
    }

    try {
      const firstInit = typeof this.isFirstInit === 'function' ? this.isFirstInit() : this.isFirstInit;
      if (firstInit) {
        await this.configureAttributeReporting([
          {
            endpointId: 1,
            cluster: CLUSTER.IAS_ZONE,
            attributeName: 'zoneStatus',
            minInterval: 0,
            maxInterval: 3600,
            minChange: 0,
          },
        ]);
      }
    } catch (err) {
      this.log('configureAttributeReporting for IAS zone failed:', err?.message || err);
    }

    try {
      const ias = zclNode.endpoints[1]?.clusters?.iasZone;
      if (ias && ias.on) {
        ias.on('zoneStatusChangeNotification', payload => {
          try {
            const isRaining = this._extractRainFromZoneStatus(payload?.zoneStatus);
            if (isRaining !== null) this._updateRainCapability(isRaining, 'iasZoneCommand');
          } catch (err) {
            this.error('IAS zoneStatusChangeNotification parse error:', err);
          }
        });
        ias.on('attr.zoneStatus', status => {
          try {
            const isRaining = this._extractRainFromZoneStatus(status);
            if (isRaining !== null) this._updateRainCapability(isRaining, 'iasZoneAttr');
          } catch (err) {
            this.error('IAS attr.zoneStatus parse error:', err);
          }
        });
      }
    } catch (e) {
      this.log('IAS Zone hook failed:', e?.message || e);
    }

    this.homey.flow.getConditionCard('is_raining_2')
      .registerRunListener(async () => !!this.getCapabilityValue('alarm_water'));

    this.log('🌧️ Rain sensor 2 initialised');
  }

  async _handleTuyaDp(dpFrame) {
    const dp = dpFrame?.dp;
    const parsed = getDataValue(dpFrame);
    const deviceLbl = this._getDeviceLabel();
    const txn = typeof dpFrame?.transid === 'number' ? dpFrame.transid : null;
    const txnInfo = txn === null ? '' : `, transid ${txn}`;

    switch (dp) {
      case DP.BATTERY_PCT: {
        const pct = this._normalizeBattery(parsed, dpFrame);
        if (pct !== null) {
          this.log(`[TuyaDP] ${deviceLbl} battery ${pct}% (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_battery', pct).catch(this.error);
        }
        break;
      }

      case DP.ILLUMINANCE: {
        const lux = this._normalizeLuxValue(parsed);
        if (lux !== null) {
          this.log(`[TuyaDP] ${deviceLbl} illuminance ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_luminance', lux).catch(this.error);
        }
        break;
      }

      case DP.ILLUMINANCE_AVERAGE_20MIN: {
        const lux = this._normalizeLuxValue(parsed);
        if (lux !== null) {
          this.log(`[TuyaDP] ${deviceLbl} illuminance avg 20 min ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_luminance_average_20min', lux).catch(this.error);
        }
        break;
      }

      case DP.ILLUMINANCE_MAX_TODAY: {
        const lux = this._normalizeLuxValue(parsed);
        if (lux !== null) {
          this.log(`[TuyaDP] ${deviceLbl} illuminance max today ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_luminance_maximum_today', lux).catch(this.error);
        }
        break;
      }

      case DP.CLEANING_REMINDER: {
        const cleaningReminder = parsed === true || parsed === 1;
        this.log(`[TuyaDP] ${deviceLbl} cleaning reminder ${cleaningReminder ? 'active' : 'clear'} (dp 0x${dp.toString(16)}${txnInfo})`);
        await this.setCapabilityValue('cleaning_reminder', cleaningReminder).catch(this.error);
        break;
      }

      case DP.RAIN_INTENSITY: {
        const intensity = this._normalizeRainIntensity(parsed, dpFrame);
        if (intensity !== null) {
          this.log(`[TuyaDP] ${deviceLbl} rain intensity ${intensity} mV (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_rain_intensity', intensity).catch(this.error);
          await this.setCapabilityValue('rain_intensity_level', this._getRainIntensityLevel(intensity)).catch(this.error);
          this._updateRainCapability(intensity > 100, 'tuyaDp105');
        }
        break;
      }

      default:
        if (dp !== 0x6D) {
          this.log(`[TuyaDP] ${deviceLbl} unhandled dp 0x${dp?.toString(16)}${txnInfo}:`, parsed);
        }
    }
  }

  _updateRainCapability(isRaining, source) {
    const rainState = !!isRaining;
    if (source && this._lastRain !== rainState) {
      this.log(`Rain status update (${source}) ${this._getDeviceLabel()}:`, rainState);
    }
    this.setCapabilityValue('alarm_water', rainState).catch(this.error);
    this._fireRainTriggers(rainState);
  }

  _extractRainFromZoneStatus(zoneStatus) {
    if (zoneStatus == null) return null;
    if (typeof zoneStatus === 'number') return (zoneStatus & 0x0001) === 0x0001;
    if (typeof zoneStatus === 'object') return this._normalizeRainValue(zoneStatus.alarm1);
    return null;
  }

  _normalizeRainValue(value) {
    if (value == null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value >= 1;
    if (typeof value === 'string') return value.toLowerCase() === 'raining';
    return null;
  }

  _normalizeBattery(raw, dpFrame) {
    let value = Number(raw);
    if (!Number.isFinite(value)) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.isBuffer(dpFrame?.data) ? dpFrame.data : null;
      const arr = buf ? [...buf] : Array.isArray(raw) ? raw : Array.isArray(dpFrame?.data) ? dpFrame.data : null;
      if (Array.isArray(arr)) {
        value = convertMultiByteNumberPayloadToSingleDecimalNumber(arr);
      }
    }
    if (!Number.isFinite(value)) return null;
    if (value > 100 && value <= 1000) value = value / 10;
    return Math.max(0, Math.min(100, value));
  }

  _applyLuxCalibration(lux) {
    const offset = Number(this.getSetting('illuminance_calibration')) || 0;
    return Math.max(0, Math.round(lux * (1 + offset / 100)));
  }

  _normalizeLuxValue(raw) {
    const luxRaw = Number(raw);
    if (!Number.isFinite(luxRaw)) return null;
    return this._applyLuxCalibration(Math.max(0, Math.round(luxRaw)));
  }

  _normalizeRainIntensity(raw, dpFrame) {
    let value = Number(raw);
    if (!Number.isFinite(value)) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.isBuffer(dpFrame?.data) ? dpFrame.data : null;
      const arr = buf ? [...buf] : Array.isArray(raw) ? raw : Array.isArray(dpFrame?.data) ? dpFrame.data : null;
      if (Array.isArray(arr)) {
        value = convertMultiByteNumberPayloadToSingleDecimalNumber(arr);
      }
    }
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.round(value));
  }

  _getRainIntensityLevel(intensity) {
    if (intensity < 700) return 'no_rain';
    if (intensity <= 2000) return 'light_rain';
    if (intensity <= 3000) return 'moderate_rain';
    return 'violent_rain';
  }

  _fireRainTriggers(isRaining) {
    const prev = this._lastRain;
    this._lastRain = isRaining;
    if (prev === null || prev === isRaining) return;
    const cardId = isRaining ? 'rain_started_2' : 'rain_stopped_2';
    this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, {}, {}).catch(this.error);
  }

  onDeleted() {
    this.log('Rain sensor 2 removed');
  }
}

module.exports = RainSensor2;
