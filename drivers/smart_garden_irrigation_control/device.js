'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { Cluster, CLUSTER } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');

Cluster.addCluster(TuyaSpecificCluster);

const dataPoints = { batteryLevel: 101, onOffReport: 102 };
const dataTypes = { raw: 0, bool: 1, value: 2, string: 3, enum: 4, bitmap: 5 };

const getDataValue = dpValue => {
  if (!dpValue?.data) return undefined;
  switch (dpValue.datatype) {
    case dataTypes.raw: return dpValue.data;
    case dataTypes.bool: return dpValue.data[0] === 1;
    case dataTypes.value:
    case dataTypes.bitmap: return dpValue.data.reduce((value, byte) => (value << 8) + byte, 0);
    case dataTypes.string: return Buffer.from(dpValue.data).toString('latin1');
    case dataTypes.enum: return dpValue.data[0];
    default: return undefined;
  }
};

class IrrigationController extends ZigBeeDevice {
  static _toTimedOnTime(duration) {
    return Math.max(1, Math.min(0xFFFE, Math.ceil(duration / 100)));
  }

  async onNodeInit({ zclNode }) {
    if (!this.hasCapability('measure_battery')) {
      try { await this.addCapability('measure_battery'); } catch (err) { this.error('Failed to add measure_battery capability:', err); }
    }
    if (!this.hasCapability('alarm_battery')) {
      try { await this.addCapability('alarm_battery'); } catch (err) { this.error('Failed to add alarm_battery capability:', err); }
    }

    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      set: (value, options = {}) => value && Number.isFinite(Number(options.duration)) && Number(options.duration) > 0
        ? 'onWithTimedOff' : (value ? 'setOn' : 'setOff'),
      setParser(value, options = {}) {
        const duration = Number(options.duration);
        if (value && Number.isFinite(duration) && duration > 0) {
          return { onOffControl: 0, onTime: IrrigationController._toTimedOnTime(duration), offWaitTime: 0 };
        }
        return {};
      },
    });
    if (this.hasCapability('measure_battery')) this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION);
    if (this.hasCapability('alarm_battery')) this.registerCapability('alarm_battery', CLUSTER.POWER_CONFIGURATION);

    const tuyaCluster = zclNode.endpoints?.[1]?.clusters?.tuya;
    if (!tuyaCluster) {
      this.error('Tuya cluster not available on endpoint 1');
      return;
    }
    this._onTuyaResponse = value => this.handleTuyaResponse(value).catch(err => this.error('Failed to handle Tuya response:', err));
    this._onTuyaReporting = value => this.handleTuyaResponse(value).catch(err => this.error('Failed to handle Tuya report:', err));
    tuyaCluster.on('response', this._onTuyaResponse);
    tuyaCluster.on('reporting', this._onTuyaReporting);
  }

  async handleTuyaResponse(response) {
    const value = getDataValue(response);
    switch (response?.dp) {
      case dataPoints.batteryLevel: {
        const battery = Math.max(0, Math.min(100, Number(value)));
        if (!Number.isFinite(battery)) return;
        const batteryThreshold = Number(this.getSetting('batteryThreshold')) || 20;
        await this.setCapabilityValue('measure_battery', battery);
        await this.setCapabilityValue('alarm_battery', battery <= batteryThreshold);
        break;
      }
      case dataPoints.onOffReport:
        await this.setCapabilityValue('onoff', value === 0);
        break;
      default:
        this.debug('Unprocessed irrigation Tuya datapoint:', response?.dp, value);
    }
  }

  onDeleted() {
    const tuyaCluster = this.zclNode?.endpoints?.[1]?.clusters?.tuya;
    if (tuyaCluster && this._onTuyaResponse) tuyaCluster.removeListener('response', this._onTuyaResponse);
    if (tuyaCluster && this._onTuyaReporting) tuyaCluster.removeListener('reporting', this._onTuyaReporting);
    this._onTuyaResponse = null;
    this._onTuyaReporting = null;
    this.log('Smart irrigation controller removed');
  }
}

module.exports = IrrigationController;
