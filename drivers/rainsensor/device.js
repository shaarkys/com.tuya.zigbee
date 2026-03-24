'use strict';

const { Cluster, CLUSTER } = require('zigbee-clusters');

const TuyaSpecificCluster       = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { getDataValue, convertMultiByteNumberPayloadToSingleDecimalNumber } = require('../../lib/TuyaHelpers');

/* Register Tuya EF00 cluster */
Cluster.addCluster(TuyaSpecificCluster);

/* Datapoint maps:
   - Legacy firmware (e.g. _TZE200_jsaqgakf): rain 0x01, illuminance 0x66, sensitivity 0x67,
     illuminance_sampling 0x68, battery 0x69, keepalive 0x6d.
   - Hobeian ZG-223Z (_TZE200_u6x1zyv2): rain 0x01, illuminance 0x66, sensitivity 0x02,
     illuminance_sampling 0x65, battery 0x68, keepalive 0x6d.
   - TS0207 rain sensors (_TZ3210_tgvtvdoc, _TZ3210_p68kms0l): rain via IAS Zone,
     battery 0x04, illuminance 0x65, 20 min average 0x66, daily max 0x67,
     cleaning reminder 0x68, rain intensity 0x69. */
const DP_SETS = {
  legacy: {
    RAIN_ENUM:             0x01,
    ILLUMINANCE:           0x66,
    SENSITIVITY:           0x67,
    ILLUMINANCE_SAMPLING:  0x68,
    BATTERY_PCT:           0x69,
    KEEPALIVE:             0x6D,
  },
  hobeian: {
    RAIN_ENUM:             0x01,
    ILLUMINANCE:           0x66, // decimal 102
    SENSITIVITY:           0x02,
    ILLUMINANCE_SAMPLING:  0x65, // decimal 101
    BATTERY_PCT:           0x68, // decimal 104
    KEEPALIVE:             0x6D,
  },
  ts0207: {
    BATTERY_PCT:                0x04,
    ILLUMINANCE:                0x65, // decimal 101
    ILLUMINANCE_AVERAGE_20MIN:  0x66, // decimal 102
    ILLUMINANCE_MAX_TODAY:      0x67, // decimal 103
    CLEANING_REMINDER:          0x68, // decimal 104
    RAIN_INTENSITY:             0x69, // decimal 105
  },
};

const TS0207_RAIN_MANUFACTURERS = new Set([
  '_TZ3210_tgvtvdoc',
  '_TZ3210_p68kms0l',
]);

const TS0207_ONLY_CAPABILITIES = [
  'cleaning_reminder',
  'measure_luminance_average_20min',
  'measure_luminance_maximum_today',
  'measure_rain_intensity',
];

/* Some firmware variants never echo these DPs back after a write. */
const OPTIONAL_ACK_DP_KEYS = new Set([
  'SENSITIVITY',
  'ILLUMINANCE_SAMPLING',
]);

/* Only for "repeat when saving data" */
const SETTINGS_WRITE_RETRIES     = 5;     // how many attempts
const SETTINGS_ACK_TIMEOUT_MS    = 2500;  // wait this long for EF00 ack each attempt
const SETTINGS_RETRY_DELAY_MS    = 800;   // backoff between attempts (linear)

class RainSensorTuya extends TuyaSpecificClusterDevice {

  _lastRain = null;
  _deviceLabel = null;
  _dp = DP_SETS.legacy;
  _dpSchemaName = 'legacy';
  _optionalAck = new Set();
  _settingsPushedOnce = false;

  /* Ack waiters: Map<dp, Array<{value, resolve, reject, timer}>> */
  _ackWaiters = new Map();

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

  _setDpSchema(name = 'legacy') {
    const prevSchema = this._dpSchemaName;
    const schemaName = Object.prototype.hasOwnProperty.call(DP_SETS, name) ? name : 'legacy';
    const map = DP_SETS[schemaName];
    this._dp = map;
    this._dpSchemaName = schemaName;
    this._optionalAck = new Set(
      [...OPTIONAL_ACK_DP_KEYS]
        .map(key => map[key])
        .filter(v => Number.isInteger(v))
    );
    this.log(`Using DP schema: ${this._dpSchemaName}`);
    if (prevSchema && prevSchema !== this._dpSchemaName && this._settingsPushedOnce) {
      this._sendSettingsToDevice().catch(err => this.log('Resending settings after DP schema change failed:', err?.message || err));
    }
  }

  async _detectDpSchema(zclNode) {
    let mf = this.getData?.().manufacturerName || null;
    try {
      const basic = zclNode?.endpoints?.[1]?.clusters?.basic;
      if (basic?.readAttributes) {
        const attrs = await basic.readAttributes(['manufacturerName', 'modelId']);
        mf = attrs?.manufacturerName || mf;
      }
    } catch (err) {
      this.debug('Basic attribute read failed while detecting DP schema:', err?.message || err);
    }
    const schema = TS0207_RAIN_MANUFACTURERS.has(mf)
      ? 'ts0207'
      : mf === '_TZE200_u6x1zyv2'
        ? 'hobeian'
        : 'legacy';
    this._setDpSchema(schema);
  }

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });
    this.printNode();
    this._deviceLabel = this._composeDeviceLabel();
    await this._detectDpSchema(zclNode);
    await this._syncSchemaCapabilities();

    /* Request IAS zone status reports so we catch rain events promptly */
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

    /* Battery % */
    try {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        get: 'batteryPercentageRemaining',
        report: 'batteryPercentageRemaining',
        reportParser: v => Math.max(0, Math.min(100, Math.round((v || 0) / 2))),
        getOpts: { getOnStart: true, getOnOnline: true },
      });
    } catch (e) { this.log('Battery % not available:', e?.message || e); }

    if (this._dpSchemaName !== 'ts0207') {
      /* Battery voltage (V) */
      try {
        this.registerCapability('measure_voltage', CLUSTER.POWER_CONFIGURATION, {
          get: 'batteryVoltage',
          report: 'batteryVoltage',
          reportParser: v => (typeof v === 'number' ? v / 10 : null),
          getOpts: { getOnStart: true, getOnOnline: true },
        });
      } catch (e) { this.log('Battery voltage not available:', e?.message || e); }
    } else {
      this.log('Battery voltage cluster value is not used for TS0207 rain sensors.');
    }

    /* Illuminance — prefer ZCL cluster if present, else Tuya EF00 datapoints */
    const ill = zclNode.endpoints[1]?.clusters?.illuminanceMeasurement;
    if (ill) {
      try {
        this.registerCapability('measure_luminance', CLUSTER.ILLUMINANCE_MEASUREMENT, {
          get: 'measuredValue',
          report: 'measuredValue',
          // ZCL measuredValue is logarithmic; approximate lux:
          reportParser: v => {
            if (typeof v !== 'number') return null;
            const lux = Math.round(Math.pow(10, (v - 1) / 10000));
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

    /* Listen for Tuya EF00 reports/responses (also used to resolve acks) */
    try {
      const tuya = zclNode.endpoints[1].clusters.tuya;
      tuya.on('reporting', v => this._handleTuyaDp(v));
      tuya.on('response',  v => this._handleTuyaDp(v));
      tuya.on('defaultResponse', v => {
        // Not strictly needed for DP acks; still indicates device is awake.
        // this.log('tuya.defaultResponse', v?.status);
      });
      try {
        await tuya.dataQuery();
      } catch (err) {
        this.log('Tuya dataQuery failed (device may not support it):', err?.message || err);
      }
    } catch (e) {
      this.log('Tuya EF00 cluster not available:', e?.message || e);
    }

    /* Also listen for IAS Zone notifications (command, not attribute) */
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
      this.log('IAS Zone hook failed (will still use Tuya DP 0x01):', e?.message || e);
    }

    /* Send stored Tuya settings on init (with ack+retry) */
    if (this._supportsConfigWrites()) {
      await this._sendSettingsToDevice();
    } else {
      this.log(`Skipping settings sync for ${this._dpSchemaName} rain sensor; no writable config DPs are known.`);
    }

    /* Flow cards */
    this.homey.flow.getActionCard('set_rain_sensitivity')
      .registerRunListener(async ({ value }) => {
        if (!this._supportsConfigWrites()) throw new Error('Sensitivity is not supported on this rain sensor model');
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error('Sensitivity must be 0..9');
        // keep flow simple: single write (no repeat), users can retry the flow if needed
        await this.writeData32(this._dp.SENSITIVITY, n);
        return true;
      });

    this.homey.flow.getActionCard('set_illuminance_sampling')
      .registerRunListener(async ({ minutes }) => {
        if (!this._supportsConfigWrites()) throw new Error('Illuminance sampling is not supported on this rain sensor model');
        const n = Number(minutes);
        if (!Number.isInteger(n) || n < 1 || n > 480) throw new Error('Sampling must be 1..480 minutes');
        await this.writeData32(this._dp.ILLUMINANCE_SAMPLING, n);
        return true;
      });

    this.homey.flow.getConditionCard('is_raining')
      .registerRunListener(async () => !!this.getCapabilityValue('alarm_water'));

    this.log('🌧️ Rain sensor initialised');
  }

  /* ===== ack & retry helpers (used only for settings writes) ===== */

  _waitForAck(dp, value, timeoutMs = SETTINGS_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const entry = { value: Number(value), resolve, reject, timer: null };
      const arr = this._ackWaiters.get(dp) || [];
      arr.push(entry);
      this._ackWaiters.set(dp, arr);

      entry.timer = this.homey.setTimeout(() => {
        // remove this waiter on timeout
        const list = this._ackWaiters.get(dp) || [];
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
        if (!list.length) this._ackWaiters.delete(dp);
        reject(new Error(`Ack timeout for DP 0x${dp.toString(16)}`));
      }, timeoutMs);
    });
  }

  _resolveAck(dp, value) {
    const arr = this._ackWaiters.get(dp);
    if (!arr || !arr.length) return;
    const idx = arr.findIndex(w => w.value === undefined || Number(value) === Number(w.value));
    if (idx < 0) return;
    const w = arr.splice(idx, 1)[0];
    try { this.homey.clearTimeout(w.timer); } catch {}
    try { w.resolve(true); } catch {}
    if (!arr.length) this._ackWaiters.delete(dp);
  }

  async _writeWithAckAndRetry(dp, value, tries = SETTINGS_WRITE_RETRIES) {
    if (this._optionalAck.has(dp)) {
      this.log(`[WRITE DATA32] DP: 0x${dp.toString(16)} Value: ${value} (no ack expected)`);
      await this.writeData32(dp, value);
      return;
    }

    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        this.log(`[WRITE DATA32] DP: 0x${dp.toString(16)} Value: ${value} (attempt ${attempt}/${tries})`);
        const waitAck = this._waitForAck(dp, value);
        await this.writeData32(dp, value);
        await waitAck; // resolve when EF00 echoes the DP+value
        return;        // success
      } catch (err) {
        lastErr = err;
        this.log(`write dp 0x${dp.toString(16)} attempt ${attempt} failed: ${err?.message || err}`);
        if (attempt < tries) await this._sleep(SETTINGS_RETRY_DELAY_MS * attempt);
      }
    }
    throw lastErr;
  }

  _sleep(ms) { return new Promise(res => this.homey.setTimeout(res, ms)); }

  /* ===== main Tuya DP handler (also resolves acks) ===== */

  async _handleTuyaDp(dpFrame) {
    const dp        = dpFrame?.dp;
    const parsed    = getDataValue(dpFrame);
    if (this._dpSchemaName === 'legacy' && dp === DP_SETS.ts0207.BATTERY_PCT) {
      this._setDpSchema('ts0207');
    }
    if (this._dpSchemaName === 'legacy' && (dp === DP_SETS.hobeian.SENSITIVITY || dp === DP_SETS.hobeian.ILLUMINANCE_SAMPLING || dp === DP_SETS.hobeian.BATTERY_PCT)) {
      this._setDpSchema('hobeian');
    }
    const map       = this._dp;
    const deviceLbl = this._getDeviceLabel();
    const txn       = typeof dpFrame?.transid === 'number' ? dpFrame.transid : null;
    const txnInfo   = txn === null ? '' : `, transid ${txn}`;

    switch (dp) {
      case map.RAIN_ENUM: {
        // enum 0 (none), 1 (raining)
        const isRaining = this._normalizeRainValue(parsed);
        if (isRaining !== null) {
          this.log(`[TuyaDP] ${deviceLbl} rain ${isRaining ? 'active' : 'clear'} (dp 0x01${txnInfo})`);
          this._updateRainCapability(isRaining, 'tuyaDp');
        } else {
          this.log('DP 0x01 unexpected payload:', parsed);
        }
        break;
      }

      case map.ILLUMINANCE: {
        const luxRaw = Number(parsed);
        if (Number.isFinite(luxRaw)) {
          const lux = this._applyLuxCalibration(Math.max(0, Math.round(luxRaw)));
          this.log(`[TuyaDP] ${deviceLbl} illuminance ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
          await this.setCapabilityValue('measure_luminance', lux).catch(this.error);
        }
        break;
      }

      case map.BATTERY_PCT: {
        const pct = this._normalizeBattery(parsed, dpFrame);
        if (pct === null) {
          this.log(`[TuyaDP] ${deviceLbl} battery unparsed (dp 0x${dp?.toString(16)}${txnInfo}):`, parsed);
          break;
        }
        this.log(`[TuyaDP] ${deviceLbl} battery ${pct}% (dp 0x${dp?.toString(16)}${txnInfo})`);
        await this.setCapabilityValue('measure_battery', pct).catch(this.error);
        break;
      }

      default:
        if (Number.isInteger(map.KEEPALIVE) && dp === map.KEEPALIVE) {
          // very chatty 0x00000000 frames - ignore but keep traceable
          this.debug(`[TuyaDP] ${deviceLbl} keepalive (dp 0x${dp.toString(16)}${txnInfo})`);
          break;
        }

        if (Number.isInteger(map.ILLUMINANCE_AVERAGE_20MIN) && dp === map.ILLUMINANCE_AVERAGE_20MIN) {
          const lux = this._normalizeLuxValue(parsed);
          if (lux !== null) {
            this.log(`[TuyaDP] ${deviceLbl} illuminance avg 20 min ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
            await this._setCapabilityIfPresent('measure_luminance_average_20min', lux);
          }
          break;
        }

        if (Number.isInteger(map.ILLUMINANCE_MAX_TODAY) && dp === map.ILLUMINANCE_MAX_TODAY) {
          const lux = this._normalizeLuxValue(parsed);
          if (lux !== null) {
            this.log(`[TuyaDP] ${deviceLbl} illuminance max today ${lux} lx (dp 0x${dp.toString(16)}${txnInfo})`);
            await this._setCapabilityIfPresent('measure_luminance_maximum_today', lux);
          }
          break;
        }

        if (Number.isInteger(map.CLEANING_REMINDER) && dp === map.CLEANING_REMINDER) {
          const cleaningReminder = parsed === true || parsed === 1;
          this.log(`[TuyaDP] ${deviceLbl} cleaning reminder ${cleaningReminder ? 'active' : 'clear'} (dp 0x${dp.toString(16)}${txnInfo})`);
          await this._setCapabilityIfPresent('cleaning_reminder', cleaningReminder);
          break;
        }

        if (Number.isInteger(map.RAIN_INTENSITY) && dp === map.RAIN_INTENSITY) {
          const intensity = this._normalizeRainIntensity(parsed, dpFrame);
          if (intensity !== null) {
            this.log(`[TuyaDP] ${deviceLbl} rain intensity ${intensity} mV (dp 0x${dp.toString(16)}${txnInfo})`);
            await this._setCapabilityIfPresent('measure_rain_intensity', intensity);
            this._updateRainCapability(intensity > 100, 'tuyaDp105');
          }
          break;
        }

        if (
          Number.isInteger(map.SENSITIVITY)
          && (dp === map.SENSITIVITY || dp === map.ILLUMINANCE_SAMPLING)
        ) {
          this.log(`[TuyaDP] ${deviceLbl} dp 0x${dp.toString(16)}${txnInfo}:`, parsed);
          break;
        }

        this.log(`[TuyaDP] ${deviceLbl} unhandled dp 0x${dp?.toString(16)}${txnInfo}:`, parsed);
    }

    // Resolve any pending ack waiters for this DP
    if (Number.isInteger(dp)) this._resolveAck(dp, parsed);
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

    if (value > 100 && value <= 1000) {
      value = value / 10;
    }

    return Math.max(0, Math.min(100, value));
  }

  _applyLuxCalibration(lux) {
    const offset = Number(this.getSetting('illuminance_calibration')) || 0; // -100..100 %
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

  async _setCapabilityIfPresent(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    await this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

  _supportsConfigWrites() {
    return Number.isInteger(this._dp?.SENSITIVITY) && Number.isInteger(this._dp?.ILLUMINANCE_SAMPLING);
  }

  async _syncSchemaCapabilities() {
    const isTs0207 = this._dpSchemaName === 'ts0207';

    for (const capabilityId of TS0207_ONLY_CAPABILITIES) {
      if (isTs0207 && !this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch(this.error);
      }

      if (!isTs0207 && this.hasCapability(capabilityId) && typeof this.removeCapability === 'function') {
        await this.removeCapability(capabilityId).catch(this.error);
      }
    }

    if (isTs0207 && this.hasCapability('measure_voltage') && typeof this.removeCapability === 'function') {
      await this.removeCapability('measure_voltage').catch(this.error);
    }

    if (!isTs0207 && !this.hasCapability('measure_voltage')) {
      await this.addCapability('measure_voltage').catch(this.error);
    }
  }

  _fireRainTriggers(isRaining) {
    const prev = this._lastRain;
    this._lastRain = isRaining;
    if (prev === null || prev === isRaining) return;
    const cardId = isRaining ? 'rain_started' : 'rain_stopped';
    this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, {}, {}).catch(this.error);
  }

  /* ===== settings → use repeat-with-ack ONLY here ===== */

  async _sendSettingsToDevice() {
    if (!this._supportsConfigWrites()) {
      this._settingsPushedOnce = true;
      return;
    }
    const sens = this.getSetting('sensitivity');           // 0..9
    const samp = this.getSetting('illuminance_sampling');  // 1..480
    try {
      if (Number.isInteger(sens)) await this._writeWithAckAndRetry(this._dp.SENSITIVITY, sens);
      if (Number.isInteger(samp)) await this._writeWithAckAndRetry(this._dp.ILLUMINANCE_SAMPLING, samp);
    } catch (e) {
      this.error('Error while sending settings:', e?.message || e);
    } finally {
      this._settingsPushedOnce = true;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // only repeat/ack on settings writes (per your request)
    if (!this._supportsConfigWrites()) return;
    try {
      if (changedKeys.includes('sensitivity')) {
        const n = Number(newSettings.sensitivity);
        if (Number.isInteger(n) && n >= 0 && n <= 9) {
          await this._writeWithAckAndRetry(this._dp.SENSITIVITY, n);
        }
      }
      if (changedKeys.includes('illuminance_sampling')) {
        const m = Number(newSettings.illuminance_sampling);
        if (Number.isInteger(m) && m >= 1 && m <= 480) {
          await this._writeWithAckAndRetry(this._dp.ILLUMINANCE_SAMPLING, m);
        }
      }
    } catch (e) {
      this.error('onSettings failed:', e?.message || e);
      throw e;
    }
  }

  onDeleted() {
    this.log('Rain sensor removed');
  }
}

module.exports = RainSensorTuya;
