'use strict';

const Homey = require('homey');
const { ZigBeeDevice } = require('homey-zigbeedriver');
const { debug, CLUSTER } = require('zigbee-clusters');

class doorwindowsensor extends ZigBeeDevice {
		
	async onNodeInit({zclNode}) {

    this.printNode();

    this.log('Door sensor battery support initialization | manufacturer:', this.getBatteryManufacturerName() || 'unknown');
    await this.restoreBatteryType();

    if (this.isFirstInit()){
			await this.configureAttributeReporting([
				{
					endpointId: 1,
					cluster: CLUSTER.POWER_CONFIGURATION,
					attributeName: 'batteryPercentageRemaining',
					minInterval: 3600,
					maxInterval: 21600,
					minChange: 0,
				}
			]).catch(this.error);

      // Read the initial battery percentage
      try {
        const batteryPercentageResult = await zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME].readAttributes(['batteryPercentageRemaining']);
        const batteryPercentage = batteryPercentageResult.batteryPercentageRemaining;
        this.log("Initial door sensor battery percentage: ", batteryPercentage / 2);
        this.setCapabilityValue('measure_battery', batteryPercentage / 2).catch(this.error);
    } catch (err) {
        this.error('Error reading door sensor initial battery percentage:', err);
    }
      
		}
    
		// alarm_contact
    zclNode.endpoints[1].clusters[CLUSTER.IAS_ZONE.NAME].onZoneStatusChangeNotification = payload => {
      this.onIASZoneStatusChangeNotification(payload);
    }

    // measure_battery // alarm_battery
		zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME]
		.on('attr.batteryPercentageRemaining', this.onBatteryPercentageRemainingAttributeReport.bind(this));

    await this.initBatteryVoltage();
    }
  
  getBatteryManufacturerName() {
    // Homey's displayed Zigbee system settings need not be exposed as app settings.
    return this.node?.manufacturerName || this.getSetting('zb_manufacturer_name');
  }

  async restoreBatteryType() {
    if (this.getBatteryManufacturerName() !== '_TZ3000_1bwpjvlz') return;

    try {
      const energy = this.getEnergy() || {};
      if (Array.isArray(energy.batteries) && energy.batteries.length > 0) return;

      // An empty device energy override can hide the batteries declared in the manifest.
      this.log('Door sensor battery type migration started: CR2032');
      await this.setEnergy({
        ...this.driver.manifest.energy,
        ...energy,
        batteries: ['CR2032'],
      });
      this.log('Door sensor battery type migration completed: CR2032');
    } catch (err) {
      this.error('Door sensor battery type migration failed:', err);
    }
  }

  async initBatteryVoltage() {
    // Other variants sharing this driver have not been verified to expose batteryVoltage.
    if (this.getBatteryManufacturerName() !== '_TZ3000_1bwpjvlz') return;

    try {
      if (!this.hasCapability('measure_voltage')) {
        this.log('Door sensor voltage capability migration started');
        await this.addCapability('measure_voltage');
        this.log('Door sensor voltage capability migration completed');
      }

      if (!this._batteryVoltageRegistered) {
        this.registerCapability('measure_voltage', CLUSTER.POWER_CONFIGURATION, {
          endpoint: 1,
          get: 'batteryVoltage',
          report: 'batteryVoltage',
          getOpts: { getOnStart: true, getOnOnline: true },
          reportParser: this.parseBatteryVoltage,
        });
        this._batteryVoltageRegistered = true;
      }
    } catch (err) {
      this.error('Door sensor voltage capability initialization failed:', err);
      return;
    }

    // Reporting must also be configured for already paired devices, outside isFirstInit().
    await this.configureBatteryVoltageReporting().catch(err => {
      this.error('Door sensor battery voltage reporting failed; retrying on next announce:', err);
      if (!this._batteryVoltageReportingRetryPending) {
        this._batteryVoltageReportingRetryPending = true;
        this.scheduleForNextEndDeviceAnnounce(this.configureBatteryVoltageReporting.bind(this))
          .catch(retryErr => this.error('Door sensor battery voltage reporting retry failed:', retryErr))
          .finally(() => { this._batteryVoltageReportingRetryPending = false; });
      }
    });

    // The SDK reads automatically on first pairing, but skips startup reads for sleepy devices.
    if (!this.isFirstInit()) {
      this.getClusterCapabilityValue('measure_voltage', CLUSTER.POWER_CONFIGURATION)
        .catch(err => this.error('Door sensor initial battery voltage read failed; waiting for next announce:', err));
    }
  }

  async configureBatteryVoltageReporting() {
    if (this.getStoreValue('batteryVoltageReportingConfigured') === true) return;

    this.log('Door sensor battery voltage reporting configuration started');
    await this.configureAttributeReporting([{
      endpointId: 1,
      cluster: CLUSTER.POWER_CONFIGURATION,
      attributeName: 'batteryVoltage',
      minInterval: 3600,
      maxInterval: 21600,
      minChange: 1,
    }]);
    await this.setStoreValue('batteryVoltageReportingConfigured', true);
    this.log('Door sensor battery voltage reporting configuration completed');
  }

  parseBatteryVoltage(rawValue) {
    // ZCL batteryVoltage is in 100 mV units; 0xFF means unknown.
    if (!Number.isInteger(rawValue) || rawValue < 0 || rawValue >= 255) {
      this.log('Door sensor ignored invalid/unknown batteryVoltage:', rawValue);
      return null;
    }
    const voltage = rawValue / 10;
    this.log('Door sensor batteryVoltage | raw:', rawValue, '| voltage:', voltage, 'V');
    return voltage;
  }

  onIASZoneStatusChangeNotification({zoneStatus, extendedStatus, zoneId, delay,}) {
    this.log('Door/Windows Sensor IASZoneStatusChangeNotification received:', zoneStatus, extendedStatus, zoneId, delay);
    this.setCapabilityValue('alarm_contact', zoneStatus.alarm1).catch(this.error);
    this.setCapabilityValue('alarm_battery', zoneStatus.battery).catch(this.error);
  }

  onBatteryPercentageRemainingAttributeReport(batteryPercentageRemaining) {
		const batteryThreshold = this.getSetting('batteryThreshold') || 20;
		this.log("Door sensor measure_battery | powerConfiguration - batteryPercentageRemaining (%): ", batteryPercentageRemaining/2);
		this.setCapabilityValue('measure_battery', batteryPercentageRemaining/2).catch(this.error);
		this.setCapabilityValue('alarm_battery', (batteryPercentageRemaining/2 < batteryThreshold) ? true : false).catch(this.error);
  }
  
	onDeleted(){
		this.log("Door/Window Sensor removed")
	}

}

module.exports = doorwindowsensor;


/*

"ids": {
    "modelId": "TS0203",
    "manufacturerName": "_TZ3000_1bwpjvlz"
  },
  "endpoints": {
    "ieeeAddress": "a4:c1:38:0f:93:17:67:3d",
    "networkAddress": 40912,
    "modelId": "TS0203",
    "manufacturerName": "_TZ3000_1bwpjvlz",
    "endpointDescriptors": [
      {
        "status": "SUCCESS",
        "nwkAddrOfInterest": 40912,
        "_reserved": 32,
        "endpointId": 1,
        "applicationProfileId": 260,
        "applicationDeviceId": 1026,
        "applicationDeviceVersion": 0,
        "_reserved1": 1,
        "inputClusters": [
          1,
          3,
          1280,
          0
        ],
        "outputClusters": [
          3,
          4,
          5,
          6,
          8,
          4096,
          25,
          10
        ]
      }
    ],
    "deviceType": "enddevice",
    "receiveWhenIdle": false,
    "capabilities": {
      "alternatePANCoordinator": false,
      "deviceType": false,
      "powerSourceMains": false,
      "receiveWhenIdle": false,
      "security": false,
      "allocateAddress": true
    },
    "extendedEndpointDescriptors": {
      "1": {
        "clusters": {
          "powerConfiguration": {
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
                "id": 32,
                "name": "batteryVoltage",
                "value": 30,
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
                "id": 33,
                "name": "batteryPercentageRemaining",
                "value": 200,
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
            ]
          },
          "identify": {
            "attributes": []
          },
          "iasZone": {
            "attributes": [
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 0,
                "name": "zoneState",
                "value": "notEnrolled",
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
                "name": "zoneType",
                "value": "contactSwitch",
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
                "name": "zoneStatus",
                "value": {
                  "type": "Buffer",
                  "data": [
                    0,
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
                  "writable",
                  "reportable"
                ],
                "id": 16,
                "name": "iasCIEAddress",
                "value": "5c:c7:c1:ff:fe:9b:6d:a2",
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
                "id": 17,
                "name": "zoneId",
                "value": 255,
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
            ]
          },
          "basic": {
            "attributes": [
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 0,
                "name": "zclVersion",
                "value": 3
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 1,
                "name": "appVersion",
                "value": 70
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 2,
                "name": "stackVersion",
                "value": 0
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 3,
                "name": "hwVersion",
                "value": 1
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 4,
                "name": "manufacturerName",
                "value": "_TZ3000_1bwpjvlz"
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 5,
                "name": "modelId",
                "value": "TS0203"
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 6,
                "name": "dateCode",
                "value": ""
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 7,
                "name": "powerSource",
                "value": "battery"
              },
              {
                "acl": [
                  "readable",
                  "writable",
                  "reportable"
                ],
                "id": 65502
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 65533,
                "name": "clusterRevision",
                "value": 2
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 65534,
                "name": "attributeReportingStatus",
                "value": "PENDING"
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 65506
              },
              {
                "acl": [
                  "readable",
                  "reportable"
                ],
                "id": 65507
              }
            ]
          }
        },
        "bindings": {
          "identify": {
            "attributes": []
          },
          "groups": {},
          "scenes": {
            "attributes": [
              {
                "acl": [
                  "readable"
                ],
                "id": 0
              },
              {
                "acl": [
                  "readable"
                ],
                "id": 1
              },
              {
                "acl": [
                  "readable"
                ],
                "id": 2
              },
              {
                "acl": [
                  "readable"
                ],
                "id": 3
              },
              {
                "acl": [
                  "readable"
                ],
                "id": 4
              },
              {
                "acl": [
                  "readable"
                ],
                "id": 65533,
                "name": "clusterRevision"
              }
            ]
          },
          "onOff": {},
          "levelControl": {},
          "touchlink": {},
          "ota": {},
          "time": {}
        }
      }
    }
  }

  */
