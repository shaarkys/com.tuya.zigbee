/* drivers/fingerbot/device.js */
"use strict";

/* ──────────────────────────────────────────────────────────── */
/*  Imports                                                    */
/* ──────────────────────────────────────────────────────────── */
const { Cluster, CLUSTER } = require("zigbee-clusters");

const TuyaSpecificCluster = require("../../lib/TuyaSpecificCluster");
const TuyaOnOffCluster = require("../../lib/TuyaOnOffCluster");
const TuyaSpecificClusterDevice = require("../../lib/TuyaSpecificClusterDevice");
const { getDataValue, convertMultiByteNumberPayloadToSingleDecimalNumber } = require("../../lib/TuyaHelpers");
const { V1_FINGER_BOT_DATA_POINTS } = require("../../lib/TuyaDataPoints");

/*  Register extra Tuya clusters with zigbee-clusters            */
Cluster.addCluster(TuyaSpecificCluster);
Cluster.addCluster(TuyaOnOffCluster);

/* ──────────────────────────────────────────────────────────── */
/*  Device class                                               */
/* ──────────────────────────────────────────────────────────── */
class FingerBotTuya extends TuyaSpecificClusterDevice {
  static _flowCardRegistered = false;
  static _clickResetMinMs = 500;
  static _clickWatchdogIntervalMs = 1500;

  /* ───────────────  Initialise  ─────────────── */
  async onNodeInit({ zclNode }) {
    /* always call super first */
    await super.onNodeInit({ zclNode });

    this.printNode();

    /* --------------------------------------------------------- */
    /*  ON / OFF – use the standard Zigbee genOnOff cluster      */
    /*  (same trick as Johan Bendz’ “simple-plug” driver)        */
    /* --------------------------------------------------------- */
    this.registerCapability("onoff", CLUSTER.ON_OFF, {
      getOpts: {
        getOnStart: true, // read state right after inclusion
      },
    });
    this._clickResetTimer = null;
    this._clickWatchdog = this.homey.setInterval(() => this._runClickWatchdog(), FingerBotTuya._clickWatchdogIntervalMs);

    const onOffCluster = zclNode.endpoints[1].clusters.onOff;
    if (onOffCluster && typeof onOffCluster.on === "function") {
      onOffCluster.on("attr.onOff", (value) => this._handleObservedOnOffState(!!value));
    }

    /* --------------------------------------------------------- */
    /*  Read a few basic attributes – purely diagnostic          */
    /* --------------------------------------------------------- */
    const basicCluster = zclNode.endpoints[1].clusters.basic;
    let basicAttrs = {};
    let swBuildAttrs = {};
    try {
      basicAttrs = await basicCluster.readAttributes(["manufacturerName", "zclVersion", "appVersion", "modelId", "powerSource", "attributeReportingStatus"]);
    } catch (err) {
      this.error("Error when reading basic attributes:", err);
    }
    try {
      swBuildAttrs = await basicCluster.readAttributes(["swBuildId"]);
      if (swBuildAttrs?.swBuildId) {
        this.log("Finger Bot swBuildId:", swBuildAttrs.swBuildId);
      }
    } catch {
      // Not all variants expose swBuildId.
    }
    await this._storeFirmwareVersion({ ...basicAttrs, ...swBuildAttrs });

    /* --------------------------------------------------------- */
    /*  MODE capability (click / switch / program)               */
    /* --------------------------------------------------------- */
    this.registerCapabilityListener("finger_bot_mode", async (mode) => {
      const map = { click: 0, switch: 1, program: 2 };
      try {
        await this.writeEnum(V1_FINGER_BOT_DATA_POINTS.mode, map[mode]);
        this._handleObservedMode(mode);
        this.log("Finger Bot mode set to", mode);
      } catch (e) {
        this.error("Failed to set mode:", e);
      }
    });

    /* Flow card “Set mode”                                      */
    if (!FingerBotTuya._flowCardRegistered) {
      this.homey.flow.getActionCard("set_finger_bot_mode").registerRunListener(async (args) => {
        const map = { click: 0, switch: 1, program: 2 };
        const targetDevice = (args && args.device && typeof args.device.writeEnum === "function") ? args.device : this;
        await targetDevice.writeEnum(V1_FINGER_BOT_DATA_POINTS.mode, map[args.mode]);
        targetDevice.log("Finger Bot mode set via flow to", args.mode);
        return true;
      });
      FingerBotTuya._flowCardRegistered = true;
    }

    /* --------------------------------------------------------- */
    /*  Apply stored settings to the device                      */
    /* --------------------------------------------------------- */
    await this._sendSettingsToDevice();

    /* --------------------------------------------------------- */
    /*  Listen for Tuya DP reports/responses                     */
    /* --------------------------------------------------------- */
    const tuyaCluster = zclNode.endpoints[1].clusters.tuya;
    tuyaCluster.on("reporting", (value) => this._handleTuyaDp(value));
    tuyaCluster.on("response", (value) => this._handleTuyaDp(value));
    try {
      await tuyaCluster.dataQuery();
    } catch (err) {
      this.log("Tuya dataQuery failed (device may not support it):", err?.message || err);
    }

    this.log("🚀 Finger Bot initialised!");
  }

  /* ───────────────  Settings → Device  ─────────────── */
  async _sendSettingsToDevice() {
    const { reverse, lower_limit, upper_limit, delay, touch } = await this._normalizeSettings();
    const lowerLimit = lower_limit;
    const upperLimit = upper_limit;

    try {
      await this.writeBool(V1_FINGER_BOT_DATA_POINTS.reverse, reverse);
      await this.writeData32(V1_FINGER_BOT_DATA_POINTS.lowerLimit, lowerLimit);
      await this.writeData32(V1_FINGER_BOT_DATA_POINTS.upperLimit, upperLimit);
      await this.writeData32(V1_FINGER_BOT_DATA_POINTS.delay, delay);
      await this.writeBool(V1_FINGER_BOT_DATA_POINTS.touch, touch);

      this.log("Settings pushed to Finger Bot");
    } catch (e) {
      this.error("Error while sending settings:", e);
    }
  }

  _clamp(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  async _normalizeSettings() {
    const current = {
      reverse: this.getSetting("reverse") ?? false,
      lower_limit: this.getSetting("lower_limit"),
      upper_limit: this.getSetting("upper_limit"),
      delay: this.getSetting("delay"),
      touch: this.getSetting("touch") ?? false,
    };

    const normalized = {
      reverse: !!current.reverse,
      lower_limit: this._clamp(current.lower_limit ?? 100, 50, 100, 100), // DP 0x66 expected 50..100
      upper_limit: this._clamp(current.upper_limit ?? 0, 0, 50, 0),       // DP 0x6a expected 0..50
      delay: this._clamp(current.delay ?? 1, 0, 10, 1),                   // DP 0x67 expected 0..10 s
      touch: !!current.touch,
    };

    const changed = Object.keys(normalized).some((k) => normalized[k] !== current[k]);
    if (changed) {
      this.setSettings({
        reverse: normalized.reverse,
        lower_limit: normalized.lower_limit,
        upper_limit: normalized.upper_limit,
        delay: normalized.delay,
        touch: normalized.touch,
      }).catch(this.error);
    }

    return normalized;
  }

  /* ───────────────  Handle Tuya datapoints  ─────────────── */
  _expandTuyaDpFrames(dpFrame) {
    if (!dpFrame || typeof dpFrame.dp !== "number") return [];

    const toBuffer = (v) => {
      if (Buffer.isBuffer(v)) return v;
      if (Array.isArray(v)) return Buffer.from(v);
      if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      if (v && typeof v === "object" && Array.isArray(v.data)) return Buffer.from(v.data);
      return Buffer.alloc(0);
    };

    const firstLength = Number(dpFrame.length);
    const firstData = toBuffer(dpFrame.data);
    const length = Number.isFinite(firstLength) && firstLength >= 0 ? firstLength : firstData.length;
    const firstSliceLength = Math.min(length, firstData.length);
    const frames = [{ ...dpFrame, length: firstSliceLength, data: firstData.slice(0, firstSliceLength) }];

    let rest = firstData.slice(firstSliceLength);

    while (rest.length >= 4) {
      const dp = rest.readUInt8(0);
      const datatype = rest.readUInt8(1);
      const dpLength = rest.readUInt16BE(2);
      const total = 4 + dpLength;

      if (rest.length < total) {
        break;
      }

      frames.push({
        status: dpFrame.status,
        transid: dpFrame.transid,
        dp,
        datatype,
        length: dpLength,
        data: rest.slice(4, total),
      });

      rest = rest.slice(total);
    }

    return frames;
  }

  _extractTuyaNumber(parsed, dpFrame) {
    const direct = Number(parsed);
    if (Number.isFinite(direct)) return direct;

    const toArray = (v) => {
      if (Buffer.isBuffer(v)) return [...v];
      if (Array.isArray(v)) return v;
      if (ArrayBuffer.isView(v)) return Array.from(v);
      if (v && typeof v === "object" && Array.isArray(v.data)) return v.data;
      return null;
    };

    const parsedArr = toArray(parsed);
    if (Array.isArray(parsedArr)) {
      return convertMultiByteNumberPayloadToSingleDecimalNumber(parsedArr);
    }

    const frameArr = toArray(dpFrame?.data);
    if (Array.isArray(frameArr)) {
      return convertMultiByteNumberPayloadToSingleDecimalNumber(frameArr);
    }

    return NaN;
  }

  _deriveFirmwareVersion(attrs = {}) {
    const swBuildId = attrs?.swBuildId;
    if (swBuildId !== undefined && swBuildId !== null && `${swBuildId}`.trim() !== "") {
      return `${swBuildId}`.trim();
    }

    const appVersion = attrs?.appVersion;
    if (appVersion !== undefined && appVersion !== null && `${appVersion}`.trim() !== "") {
      return `appVersion:${appVersion}`;
    }

    return null;
  }

  async _storeFirmwareVersion(attrs = {}) {
    const firmwareVersion = this._deriveFirmwareVersion(attrs);
    if (!firmwareVersion) return;

    const current = this.getSetting("firmware_version");
    if (current === firmwareVersion) return;

    await this.setSettings({ firmware_version: firmwareVersion }).catch((err) => {
      this.error("Failed to store firmware version:", err);
    });
  }

  _isClickMode() {
    return this.getCapabilityValue("finger_bot_mode") === "click";
  }

  _getClickResetDelayMs() {
    const configuredDelaySeconds = Number(this.getSetting("delay"));
    const configuredDelayMs = Number.isFinite(configuredDelaySeconds) && configuredDelaySeconds >= 0
      ? configuredDelaySeconds * 1000
      : 0;
    return Math.max(FingerBotTuya._clickResetMinMs, configuredDelayMs);
  }

  _clearClickResetTimer() {
    if (!this._clickResetTimer) return;
    try {
      this.homey.clearTimeout(this._clickResetTimer);
    } catch {}
    this._clickResetTimer = null;
  }

  _scheduleClickAutoReset() {
    if (!this._isClickMode()) return;
    if (this.getCapabilityValue("onoff") !== true) return;
    if (this._clickResetTimer) return;

    const delayMs = this._getClickResetDelayMs();
    this._clickResetTimer = this.homey.setTimeout(() => {
      this._clickResetTimer = null;

      if (!this._isClickMode()) return;
      if (this.getCapabilityValue("onoff") !== true) return;

      this.setCapabilityValue("onoff", false).catch(this.error);
    }, delayMs);
  }

  _handleObservedMode(mode) {
    if (mode === "click") {
      this._scheduleClickAutoReset();
      return;
    }
    this._clearClickResetTimer();
  }

  _handleObservedOnOffState(isOn) {
    if (isOn) {
      this._scheduleClickAutoReset();
      return;
    }
    this._clearClickResetTimer();
  }

  _runClickWatchdog() {
    if (!this._isClickMode()) return;
    if (this.getCapabilityValue("onoff") !== true) return;
    this._scheduleClickAutoReset();
  }

  async _handleTuyaDp(dpFrame) {
    const parsedFrames = this._expandTuyaDpFrames(dpFrame);
    for (const frame of parsedFrames) {
      await this._handleSingleTuyaDp(frame);
    }
  }

  async _handleSingleTuyaDp(dpFrame) {
    const dp = dpFrame.dp;
    const parsed = getDataValue(dpFrame);

    switch (dp) {
      case V1_FINGER_BOT_DATA_POINTS.onOff:
        /* Homey already updates “onoff” through CLUSTER.ON_OFF,
           but we keep this in case the device reports through DP as well.  */
        await this.setCapabilityValue("onoff", !!parsed).catch(this.error);
        this._handleObservedOnOffState(!!parsed);
        break;

      case V1_FINGER_BOT_DATA_POINTS.mode:
        if ([0, 1, 2].includes(parsed)) {
          const mode = ["click", "switch", "program"][parsed];
          await this.setCapabilityValue("finger_bot_mode", mode).catch(this.error);
          this._handleObservedMode(mode);
        }
        break;

      case V1_FINGER_BOT_DATA_POINTS.battery:
      case 0x04:
      case 0x69: {
        const rawPct = this._extractTuyaNumber(parsed, dpFrame);
        if (!Number.isFinite(rawPct)) {
          this.log(`Battery via Tuya DP 0x${dp.toString(16)} unparsed:`, parsed);
          break;
        }
        const pct = Math.max(0, Math.min(100, rawPct));
        this.log(`Battery via Tuya DP 0x${dp.toString(16)}:`, pct);
        await this.setCapabilityValue("measure_battery", pct).catch(this.error);
        break;
      }
      case 0x6d:
        // Program payload/status DP - noisy on some firmware variants.
        break;
      default:
        this.log(`Unhandled DP ${dp}:`, parsed);
    }
  }

  /* ───────────────  Homey settings changed  ─────────────── */
  async onSettings({ changedKeys } = {}) {
    if (Array.isArray(changedKeys) && changedKeys.length > 0 && changedKeys.every((key) => key === "firmware_version")) {
      return;
    }
    await this._sendSettingsToDevice();
  }

  /* ───────────────  Device removed  ─────────────── */
  onDeleted() {
    this._clearClickResetTimer();
    if (this._clickWatchdog) {
      try {
        this.homey.clearInterval(this._clickWatchdog);
      } catch {}
      this._clickWatchdog = null;
    }
    this.log("Finger Bot removed");
  }
}

module.exports = FingerBotTuya;
