'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster, ZCLDataTypes} = require('zigbee-clusters');
const TuyaOnOffCluster = require('../../lib/TuyaOnOffCluster');

Cluster.addCluster(TuyaOnOffCluster);

class smartplug extends ZigBeeDevice {
  _clearPollingIntervals() {
    if (this._measurementPollInterval) {
      this.homey.clearInterval(this._measurementPollInterval);
      this._measurementPollInterval = null;
    }
    if (this._meteringPollInterval) {
      this.homey.clearInterval(this._meteringPollInterval);
      this._meteringPollInterval = null;
    }
  }

  _getFallbackIdentity() {
    const data = typeof this.getData === 'function' ? this.getData() : {};
    return {
      manufacturerName: data?.manufacturerName || null,
      modelId: data?.modelId || null,
    };
  }

  _isTS0121MeasurementPollingDevice() {
    return ['TS0121', 'TSO121'].includes(this.modelId);
  }

  _isEnergyPollingOnlyDevice() {
    return this.manufacturerName === '_TZ3000_cehuw1lw';
  }

  _getElectricalMeasurementPollIntervalMs() {
    return Math.max(10000, Math.min(this.minReportPower, this.minReportCurrent, this.minReportVoltage));
  }

  _getMeteringPollIntervalMs() {
    return 300000;
  }

  async _pollElectricalMeasurementCluster() {
    try {
      const attrs = await this.zclNode.endpoints[1].clusters.electricalMeasurement.readAttributes(['activePower', 'rmsCurrent', 'rmsVoltage']);

      if (typeof attrs.activePower === 'number') {
        await this.setCapabilityValue('measure_power', (attrs.activePower * this.measureOffset) / 100).catch(this.error);
      }
      if (typeof attrs.rmsCurrent === 'number') {
        await this.setCapabilityValue('measure_current', attrs.rmsCurrent / 1000).catch(this.error);
      }
      if (typeof attrs.rmsVoltage === 'number') {
        await this.setCapabilityValue('measure_voltage', attrs.rmsVoltage).catch(this.error);
      }
    } catch (err) {
      this.error('Electrical measurement poll failed', err);
    }
  }

  async _pollMeteringCluster() {
    try {
      const attrs = await this.zclNode.endpoints[1].clusters.metering.readAttributes(['currentSummationDelivered']);
      if (typeof attrs.currentSummationDelivered === 'number') {
        await this.setCapabilityValue('meter_power', (attrs.currentSummationDelivered * this.meteringOffset) / 100.0).catch(this.error);
      }
    } catch (err) {
      this.error('Metering poll failed', err);
    }
  }

  _scheduleFallbackPolling() {
    this._clearPollingIntervals();

    if (this._isTS0121MeasurementPollingDevice()) {
      const electricalIntervalMs = this._getElectricalMeasurementPollIntervalMs();
      const meteringIntervalMs = this._getMeteringPollIntervalMs();
      this._measurementPollInterval = this.homey.setInterval(() => this._pollElectricalMeasurementCluster(), electricalIntervalMs);
      this._meteringPollInterval = this.homey.setInterval(() => this._pollMeteringCluster(), meteringIntervalMs);
      return;
    }

    if (this._isEnergyPollingOnlyDevice()) {
      const meteringIntervalMs = this._getMeteringPollIntervalMs();
      this._meteringPollInterval = this.homey.setInterval(() => this._pollMeteringCluster(), meteringIntervalMs);
    }
  }

  async onNodeInit({zclNode}) {

    this.printNode();

    this.meteringOffset = this.getSetting('metering_offset');
    this.measureOffset = this.getSetting('measure_offset') * 100;
    this.minReportPower= this.getSetting('minReportPower') * 1000;
    this.minReportCurrent = this.getSetting('minReportCurrent') * 1000;
    this.minReportVoltage = this.getSetting('minReportVoltage') * 1000;

    const basicCluster = zclNode.endpoints[1].clusters.basic;
    const fallbackIdentity = this._getFallbackIdentity();
    this.manufacturerName = fallbackIdentity.manufacturerName;
    this.modelId = fallbackIdentity.modelId;

    if (!this.hasCapability('measure_current')) {
      await this.addCapability('measure_current').catch(this.error);;
    }

    if (!this.hasCapability('measure_voltage')) {
      await this.addCapability('measure_voltage').catch(this.error);;
    }

    // onOff
    this.registerCapability('onoff', CLUSTER.ON_OFF, {
      getOpts: {
        getOnStart: true
	    }
    });

/*     // Catch Power Factors - if those exists
    if (typeof this.activePowerFactor !== 'number') {
      const { acPowerMultiplier, acPowerDivisor } = await zclNode.endpoints[
        this.getClusterEndpoint(CLUSTER.ELECTRICAL_MEASUREMENT)
      ]
      .clusters[CLUSTER.ELECTRICAL_MEASUREMENT.NAME]
      .readAttributes('acPowerMultiplier', 'acPowerDivisor');
      this.activePowerFactor = acPowerMultiplier / acPowerDivisor;
      this.log("Active Power Factor: ", this.meteringFactor);
    }
    if (typeof this.meteringFactor !== 'number') {
      const { multiplier, divisor } = await zclNode.endpoints[
        this.getClusterEndpoint(CLUSTER.METERING)
      ]
      .clusters[CLUSTER.METERING.NAME]
      .readAttributes('multiplier', 'divisor');
      this.meteringFactor = multiplier / divisor;
      this.log("Metering Factor: ", this.meteringFactor);
    } */

    
    // When upgrading to node-zigbee-clusters v.2.0.0 this must be adressed:
    // v2.0.0
    // Changed Cluster.readAttributes signature, attributes must now be specified as an array of strings.
    // zclNode.endpoints[1].clusters.windowCovering.readAttributes(["motorReversal", "ANY OTHER IF NEEDED"]);

    try {
      const relayStatus = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['relayStatus']);
      const childLock = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['childLock']);
      const indicatorMode = await this.zclNode.endpoints[1].clusters.onOff.readAttributes(['indicatorMode']);    

      this.log("Relay Status supported by device");

      await this.setSettings({
        relay_status : ZCLDataTypes.enum8RelayStatus.args[0][relayStatus.relayStatus].toString(),
        indicator_mode: ZCLDataTypes.enum8IndicatorMode.args[0][indicatorMode.indicatorMode].toString(),
        child_lock: childLock.childLock ? "1" : "0",
      });
    } catch (error) {
      this.log("This device does not support Relay Control", error);
    }

    // meter_power
    this.registerCapability('meter_power', CLUSTER.METERING, {
      reportParser: value => (value * this.meteringOffset)/100.0,
      getParser: value => (value * this.meteringOffset)/100.0,
      getOpts: {
        getOnStart: true
	    }
    });

    // measure_power
    this.registerCapability('measure_power', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => {
        return (value * this.measureOffset)/100;
      },
      getOpts: {
        getOnStart: true
	    }
    });

    this.registerCapability('measure_current', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => {
        return value/1000;
      },
      getOpts: {
        getOnStart: true
      }
    });

    this.registerCapability('measure_voltage', CLUSTER.ELECTRICAL_MEASUREMENT, {
      reportParser: value => {
        return value;
      },
      getOpts: {
        getOnStart: true
      }
    });

    await basicCluster.readAttributes(['manufacturerName', 'zclVersion', 'appVersion', 'modelId', 'powerSource', 'attributeReportingStatus'])
      .then((attrs) => {
        this.manufacturerName = attrs?.manufacturerName || this.manufacturerName;
        this.modelId = attrs?.modelId || this.modelId;
      })
      .catch(err => {
        this.error('Error when reading device attributes ', err);
      });

    this._scheduleFallbackPolling();

  }

  onReset () {
    // Endpoint: 1 Cluster: 0x00 Command: 0 Payload: 
  }

  onDeleted() {
    this._clearPollingIntervals();
    this.log("Smart Plug removed")
  }

  async onSettings({oldSettings, newSettings, changedKeys}) {
    let parsedValue = 0;

    this.meteringOffset = newSettings.metering_offset;
    this.measureOffset = newSettings.measure_offset * 100;
    this.minReportPower= newSettings.minReportPower * 1000;
    this.minReportCurrent = newSettings.minReportCurrent * 1000;
    this.minReportVoltage = newSettings.minReportVoltage * 1000;

    if (changedKeys.includes('relay_status')) {
      parsedValue = parseInt(newSettings.relay_status);
      await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({ relayStatus: parsedValue });
    }

    if (changedKeys.includes('indicator_mode')) {
      parsedValue = parseInt(newSettings.indicator_mode);
      await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({ indicatorMode: parsedValue });
    }

    if (changedKeys.includes('child_lock')) {
      parsedValue = parseInt(newSettings.child_lock);
      await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({ childLock: parsedValue });
    }

    if (changedKeys.some((key) => ['metering_offset', 'measure_offset', 'minReportPower', 'minReportCurrent', 'minReportVoltage'].includes(key))) {
      this._scheduleFallbackPolling();
    }
  }
}

module.exports = smartplug;


/* "ids": {
  "modelId": "TS0121",
  "manufacturerName": "_TZ3000_vtscrpmw"
},
"endpoints": {
  "endpointDescriptors": [
    {
      "endpointId": 1,
      "applicationProfileId": 260,
      "applicationDeviceId": 81,
      "applicationDeviceVersion": 0,
      "_reserved1": 1,
      "inputClusters": [
        0,
        4,
        5,
        6,
        1794,
        2820
      ],
      "outputClusters": [
        25,
        10
      ]
    }
  ],
  "endpoints": {
    "1": {
      "clusters": {
        "basic": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 0,
              "name": "zclVersion",
              "value": 3,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 1,
              "name": "appVersion",
              "value": 65,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 2,
              "name": "stackVersion",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 3,
              "name": "hwVersion",
              "value": 1,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 4,
              "name": "manufacturerName",
              "value": "_TZ3000_vtscrpmw",
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 5,
              "name": "modelId",
              "value": "TS0121",
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 6,
              "name": "dateCode",
              "value": "",
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 7,
              "name": "powerSource",
              "value": "mains",
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "writable",
                "reportable"
              ],
              "id": 65502,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 2,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65534,
              "name": "attributeReportingStatus",
              "value": "PENDING",
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65504,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65505,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65506,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65507,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "groups": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 0,
              "name": "nameSupport",
              "value": {
                "type": "Buffer",
                "data": [
                  0
                ]
              },
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 2,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "scenes": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 1,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 2,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 3,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 4,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 2,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "onOff": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 0,
              "name": "onOff",
              "value": false,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 2,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "writable",
                "reportable"
              ],
              "id": 16385,
              "name": "onTime",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "writable",
                "reportable"
              ],
              "id": 16386,
              "name": "offWaitTime",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "writable",
                "reportable"
              ],
              "id": 32769,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "writable",
                "reportable"
              ],
              "id": 32770,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 32771,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "metering": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 0,
              "name": "currentSummationDelivered",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 512,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 768,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 771,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 774,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 1,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "electricalMeasurement": {
          "attributes": [
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 1285,
              "name": "rmsVoltage",
              "value": 221,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 1288,
              "name": "rmsCurrent",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 1291,
              "name": "activePower",
              "value": 0,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            },
            {
              "acl": [
                "readable",
                "reportable"
              ],
              "id": 65533,
              "name": "clusterRevision",
              "value": 1,
              "reportingConfiguration": {
                "status": "NOT_FOUND",
                "direction": "reported"
              }
            }
          ],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        }
      },
      "bindings": {
        "ota": {
          "attributes": [],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        },
        "time": {
          "attributes": [],
          "commandsGenerated": "UNSUP_GENERAL_COMMAND",
          "commandsReceived": "UNSUP_GENERAL_COMMAND"
        }
      }
    }
  }
} */
