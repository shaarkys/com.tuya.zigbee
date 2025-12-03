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
        getOnOnline: true, // read again when device reconnects
        pollInterval: 15000, // keep UI in sync every 15 s
      },
    });

    /* --------------------------------------------------------- */
    /*  Optional battery via standard cluster (if present)       */
    /* --------------------------------------------------------- */
    try {
      this.registerCapability("measure_battery", CLUSTER.POWER_CONFIGURATION, {
        get: "batteryPercentageRemaining",
        report: "batteryPercentageRemaining",
        reportParser: (v) => Math.round((v || 0) / 2), // ZCL reports 0..200 → 0..100%
      });
    } catch (e) {
      this.log("Battery via PowerConfiguration not available:", e.message);
    }

    /* --------------------------------------------------------- */
    /*  Read a few basic attributes – purely diagnostic          */
    /* --------------------------------------------------------- */
    zclNode.endpoints[1].clusters.basic.readAttributes(["manufacturerName", "zclVersion", "appVersion", "modelId", "powerSource", "attributeReportingStatus"]).catch((err) => this.error("Error when reading device attributes:", err));

    /* --------------------------------------------------------- */
    /*  MODE capability (click / switch / program)               */
    /* --------------------------------------------------------- */
    this.registerCapabilityListener("finger_bot_mode", async (mode) => {
      const map = { click: 0, switch: 1, program: 2 };
      try {
        await this.writeEnum(V1_FINGER_BOT_DATA_POINTS.mode, map[mode]);
        this.log("Finger Bot mode set to", mode);
      } catch (e) {
        this.error("Failed to set mode:", e);
      }
    });

    /* Flow card “Set mode”                                      */
    this.homey.flow.getActionCard("set_finger_bot_mode").registerRunListener(async (args) => {
      const map = { click: 0, switch: 1, program: 2 };
      await this.writeEnum(V1_FINGER_BOT_DATA_POINTS.mode, map[args.mode]);
      this.log("Finger Bot mode set via flow to", args.mode);
      return true;
    });

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
    const reverse = this.getSetting("reverse") ?? false;
    const lowerLimit = this.getSetting("lower_limit") ?? 100; // down movement limit (0x66) expected 50..100%
    const upperLimit = this.getSetting("upper_limit") ?? 0;   // up movement limit (0x6a) expected 0..50%
    const delay = this.getSetting("delay") ?? 1;
    const touch = this.getSetting("touch") ?? false;

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

  /* ───────────────  Handle Tuya datapoints  ─────────────── */
  async _handleTuyaDp(dpFrame) {
    const dp = dpFrame.dp;
    const parsed = getDataValue(dpFrame);

    switch (dp) {
      case V1_FINGER_BOT_DATA_POINTS.onOff:
        /* Homey already updates “onoff” through CLUSTER.ON_OFF,
           but we keep this in case the device reports through DP as well.  */
        await this.setCapabilityValue("onoff", !!parsed).catch(this.error);
        break;

      case V1_FINGER_BOT_DATA_POINTS.mode:
        await this.setCapabilityValue("finger_bot_mode", ["click", "switch", "program"][parsed]).catch(this.error);
        break;

      case V1_FINGER_BOT_DATA_POINTS.battery:
      case 0x04:
      case 0x69: {
        let rawPct = Number(parsed);
        if (!Number.isFinite(rawPct)) {
          const buf = Buffer.isBuffer(parsed) ? parsed : Buffer.isBuffer(dpFrame?.data) ? dpFrame.data : null;
          const arr = buf ? [...buf] : Array.isArray(parsed) ? parsed : Array.isArray(dpFrame?.data) ? dpFrame.data : null;
          if (Array.isArray(arr)) {
            rawPct = convertMultiByteNumberPayloadToSingleDecimalNumber(arr);
          }
        }
        if (!Number.isFinite(rawPct)) {
          this.log(`Battery via Tuya DP 0x${dp.toString(16)} unparsed:`, parsed);
          break;
        }
        const pct = Math.max(0, Math.min(100, rawPct));
        this.log(`Battery via Tuya DP 0x${dp.toString(16)}:`, pct);
        await this.setCapabilityValue("measure_battery", pct).catch(this.error);
        break;
      }
      default:
        this.log(`Unhandled DP ${dp}:`, parsed);
    }
  }

  /* ───────────────  Homey settings changed  ─────────────── */
  async onSettings() {
    await this._sendSettingsToDevice();
  }

  /* ───────────────  Device removed  ─────────────── */
  onDeleted() {
    this.log("Finger Bot removed");
  }
}

module.exports = FingerBotTuya;
