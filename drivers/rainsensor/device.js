'use strict';

const { Cluster, CLUSTER } = require('zigbee-clusters');

const TuyaSpecificCluster       = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { getDataValue }          = require('../../lib/TuyaHelpers');

/* Register Tuya EF00 cluster */
Cluster.addCluster(TuyaSpecificCluster);

/* Datapoints observed in your logs:
   - dp 0x01 (datatype 0x04 enum): 0=none, 1=raining
   - dp 0x66 (datatype 0x02 value): illuminance (matches ZCL lux reading)
   - dp 0x6D (datatype 0x02 value): keepalive/unused (always 0)
   - battery % is typically 0x69; leave handler in case the device reports it later. */
const DP = {
  RAIN_ENUM:             0x01, // enum 0/1
  ILLUMINANCE:           0x66, // value (lux)
  SENSITIVITY:           0x67, // value 0..9 (if supported)
  ILLUMINANCE_SAMPLING:  0x68, // value minutes 1..480 (if supported)
  BATTERY_PCT:           0x69, // value 0..100 (if reported)
  KEEPALIVE:             0x6D, // value 0 (ignore)
};

/* Only for "repeat when saving data" */
const SETTINGS_WRITE_RETRIES     = 5;     // how many attempts
const SETTINGS_ACK_TIMEOUT_MS    = 2500;  // wait this long for EF00 ack each attempt
const SETTINGS_RETRY_DELAY_MS    = 800;   // backoff between attempts (linear)

class RainSensorTuya extends TuyaSpecificClusterDevice {

  _lastRain = null;

  /* Ack waiters: Map<dp, Array<{value, resolve, reject, timer}>> */
  _ackWaiters = new Map();

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });
    this.printNode();

    /* Battery % */
    try {
      this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
        get: 'batteryPercentageRemaining',
        report: 'batteryPercentageRemaining',
        reportParser: v => Math.max(0, Math.min(100, Math.round((v || 0) / 2))),
        getOpts: { getOnStart: true, getOnOnline: true },
      });
    } catch (e) { this.log('Battery % not available:', e?.message || e); }

    /* Battery voltage (V) */
    try {
      this.registerCapability('measure_voltage', CLUSTER.POWER_CONFIGURATION, {
        get: 'batteryVoltage',
        report: 'batteryVoltage',
        reportParser: v => (typeof v === 'number' ? v / 10 : null),
        getOpts: { getOnStart: true, getOnOnline: true },
      });
    } catch (e) { this.log('Battery voltage not available:', e?.message || e); }

    /* Illuminance — prefer ZCL cluster if present, else Tuya DP 0x66 */
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
      this.log('IlluminanceMeasurement missing → using Tuya EF00 DP 0x66 for lux.');
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
    } catch (e) {
      this.log('Tuya EF00 cluster not available:', e?.message || e);
    }

    /* Also listen for IAS Zone notifications (command, not attribute) */
    try {
      const ias = zclNode.endpoints[1]?.clusters?.iasZone;
      if (ias && ias.on) {
        ias.on('zoneStatusChangeNotification', payload => {
          try {
            const zs = payload?.zoneStatus;
            const isAlarm = (typeof zs === 'number')
              ? ((zs & 0x0001) === 0x0001)
              : !!zs?.alarm1;
            this.setCapabilityValue('alarm_water', !!isAlarm).catch(this.error);
            this._fireRainTriggers(!!isAlarm);
          } catch (err) {
            this.error('IAS zoneStatusChangeNotification parse error:', err);
          }
        });
      }
    } catch (e) {
      this.log('IAS Zone hook failed (will still use Tuya DP 0x01):', e?.message || e);
    }

    /* Send stored Tuya settings on init (with ack+retry) */
    await this._sendSettingsToDevice();

    /* Flow cards */
    this.homey.flow.getActionCard('set_rain_sensitivity')
      .registerRunListener(async ({ value }) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error('Sensitivity must be 0..9');
        // keep flow simple: single write (no repeat), users can retry the flow if needed
        await this.writeData32(DP.SENSITIVITY, n);
        return true;
      });

    this.homey.flow.getActionCard('set_illuminance_sampling')
      .registerRunListener(async ({ minutes }) => {
        const n = Number(minutes);
        if (!Number.isInteger(n) || n < 1 || n > 480) throw new Error('Sampling must be 1..480 minutes');
        await this.writeData32(DP.ILLUMINANCE_SAMPLING, n);
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
    const dp     = dpFrame?.dp;
    const parsed = getDataValue(dpFrame);

    switch (dp) {
      case DP.RAIN_ENUM: {
        // enum 0 (none), 1 (raining)
        const isRaining = Number(parsed) === 1;
        await this.setCapabilityValue('alarm_water', isRaining).catch(this.error);
        this._fireRainTriggers(isRaining);
        break;
      }

      case DP.ILLUMINANCE: {
        const luxRaw = Number(parsed);
        if (Number.isFinite(luxRaw)) {
          const lux = this._applyLuxCalibration(Math.max(0, Math.round(luxRaw)));
          await this.setCapabilityValue('measure_luminance', lux).catch(this.error);
        }
        break;
      }

      case DP.BATTERY_PCT: {
        const pct = Math.max(0, Math.min(100, Number(parsed)));
        await this.setCapabilityValue('measure_battery', pct).catch(this.error);
        break;
      }

      case DP.KEEPALIVE:
        // very chatty 0x00000000 frames — ignore
        break;

      case DP.SENSITIVITY:
      case DP.ILLUMINANCE_SAMPLING:
        this.log(`DP 0x${dp.toString(16)}:`, parsed);
        break;

      default:
        this.log(`Unhandled DP 0x${dp?.toString(16)}:`, parsed);
    }

    // Resolve any pending ack waiters for this DP
    if (Number.isInteger(dp)) this._resolveAck(dp, parsed);
  }

  _applyLuxCalibration(lux) {
    const offset = Number(this.getSetting('illuminance_calibration')) || 0; // -100..100 %
    return Math.max(0, Math.round(lux * (1 + offset / 100)));
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
    const sens = this.getSetting('sensitivity');           // 0..9
    const samp = this.getSetting('illuminance_sampling');  // 1..480
    try {
      if (Number.isInteger(sens)) await this._writeWithAckAndRetry(DP.SENSITIVITY, sens);
      if (Number.isInteger(samp)) await this._writeWithAckAndRetry(DP.ILLUMINANCE_SAMPLING, samp);
    } catch (e) {
      this.error('Error while sending settings:', e?.message || e);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // only repeat/ack on settings writes (per your request)
    try {
      if (changedKeys.includes('sensitivity')) {
        const n = Number(newSettings.sensitivity);
        if (Number.isInteger(n) && n >= 0 && n <= 9) {
          await this._writeWithAckAndRetry(DP.SENSITIVITY, n);
        }
      }
      if (changedKeys.includes('illuminance_sampling')) {
        const m = Number(newSettings.illuminance_sampling);
        if (Number.isInteger(m) && m >= 1 && m <= 480) {
          await this._writeWithAckAndRetry(DP.ILLUMINANCE_SAMPLING, m);
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
