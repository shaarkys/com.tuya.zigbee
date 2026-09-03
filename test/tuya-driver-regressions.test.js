'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

// The app runtime supplies Homey; only the prototype-level helpers are tested here.
const originalLoad = Module._load;
Module._load = function mockHomey(request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {}, App: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

const TuyaSpecificClusterDevice = require('../lib/TuyaSpecificClusterDevice');
const { V2_SOIL_SENSOR_DATA_POINTS: soil } = require('../lib/TuyaDataPoints');
const radarSensor2 = require('../drivers/radar_sensor_2/device');
const smartplug = require('../drivers/smartplug/device');
const IrrigationController = require('../drivers/smart_garden_irrigation_control/device');

const root = path.resolve(__dirname, '..');

test('DATA32 encodes signed values and preserves default versus strict send failures', async () => {
  const device = Object.create(TuyaSpecificClusterDevice.prototype);
  device.log = () => {};
  device.error = () => {};
  let sent;
  device._sendTuyaDatapoint = async payload => { sent = payload; };

  await device.writeData32(104, -15);
  assert.deepEqual([...sent.data], [0xFF, 0xFF, 0xFF, 0xF1]);
  assert.equal(sent.datatype, 2);
  assert.equal(sent.length, 4);

  await device.writeData32(104, 0.29 * 100);
  assert.deepEqual([...sent.data], [0, 0, 0, 28]);

  device._sendTuyaDatapoint = async () => { throw new Error('unreachable'); };
  await assert.doesNotReject(() => device.writeData32(104, 1));
  await assert.rejects(() => device.writeData32(104, 1, { throwOnError: true }), /unreachable/);
  await assert.rejects(() => device.writeData32(104, 0x100000000), RangeError);
});

test('model-specific soil, radar, and motion driver contracts remain scoped', () => {
  assert.deepEqual(soil, {
    dryAlarm: 1,
    soilMoistureCalibration: 102,
    temperature: 103,
    temperatureCalibration: 104,
    humidityCalibration: 105,
    displayUnit: 106,
    soilMoisture: 107,
    batteryPercentage: 108,
    humidity: 109,
    alarmSoilMoistureMin: 110,
    temperatureSampling: 111,
    soilMoistureSampling: 112,
  });

  const radarCompose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/radar_sensor_2/driver.compose.json')));
  assert.deepEqual(radarCompose.zigbee.manufacturerName, ['_TZE204_sxm7l9xa']);
  const motionCompose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/motion_sensor_3/driver.compose.json')));
  assert.equal(motionCompose.zigbee.manufacturerName.includes('_TZE200_y8jijhba'), false);

  const smartplugCompose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/smartplug/driver.compose.json')));
  assert.equal(smartplugCompose.zigbee.manufacturerName.includes('_TZ3000_bfn1w0mm'), false);
  assert.equal(smartplugCompose.zigbee.manufacturerName.filter(id => id === '_TZ3000_5f43h46b').length, 1);
  assert.equal(smartplugCompose.zigbee.manufacturerName.includes('_TZ3000_3uimvkn6'), true);

  const radarSource = fs.readFileSync(path.join(root, 'drivers/radar_sensor_2/device.js'), 'utf8');
  assert.equal(radarSource.includes('getDeviceTriggerCard'), false);
  assert.equal(radarSource.includes('targetDistanceTrigger'), false);
});

test('smartplug clamps fallback polling and prevents overlapping electrical reads', async () => {
  const device = Object.create(smartplug.prototype);
  device.minReportPower = 10000;
  device.minReportCurrent = 20000;
  device.minReportVoltage = 30000;
  assert.equal(device._getElectricalMeasurementPollIntervalMs(), 60000);

  device.minReportPower = undefined;
  device.minReportCurrent = Number.NaN;
  device.minReportVoltage = null;
  assert.equal(device._getElectricalMeasurementPollIntervalMs(), 60000);

  device.minReportPower = undefined;
  device.minReportCurrent = 120000;
  device.minReportVoltage = 180000;
  assert.equal(device._getElectricalMeasurementPollIntervalMs(), 120000);

  let reads = 0;
  let releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  device.zclNode = { endpoints: { 1: { clusters: { electricalMeasurement: {
    readAttributes: async attrs => {
      reads += 1;
      assert.deepEqual(attrs, ['activePower', 'rmsCurrent', 'rmsVoltage']);
      await pendingRead;
      return {};
    },
  } } } } };
  device.error = () => {};
  device.setCapabilityValue = async () => {};
  device.measureOffset = 100;

  const first = device._pollElectricalMeasurementCluster();
  const second = device._pollElectricalMeasurementCluster();
  await Promise.resolve();
  assert.equal(reads, 1);
  releaseRead();
  await Promise.all([first, second]);
  assert.equal(device._electricalPollInFlight, false);
});

test('radar range reports preserve hundredth-metre values and smartplug enum names become setting IDs', async () => {
  const radar = Object.create(radarSensor2.prototype);
  const settings = [];
  radar.lastDistanceUpdateTime = 0;
  radar.getSetting = key => (key === 'distance_update_interval' ? 10 : 0);
  radar.setSettings = async value => { settings.push(value); };
  radar.log = () => {};
  radar.error = () => {};

  await radar.updatePosition({ dp: 108, datatype: 2, data: Buffer.from([0, 0, 0, 15]) });
  await radar.updatePosition({ dp: 107, datatype: 2, data: Buffer.from([0, 0, 0, 195]) });
  assert.deepEqual(settings, [{ minimum_range: 0.15 }, { maximum_range: 1.95 }]);

  const relayValues = { Off: 0, On: 1, Previous: 2 };
  const indicatorValues = { Off: 0, Status: 1, Position: 2 };
  assert.equal(smartplug._normalizeEnumSettingValue('Off', relayValues), 0);
  assert.equal(smartplug._normalizeEnumSettingValue('Status', indicatorValues), 1);
  assert.equal(smartplug._normalizeEnumSettingValue(2, relayValues), 2);
  assert.equal(smartplug._normalizeEnumSettingValue('Unsupported', indicatorValues), null);
  assert.equal(smartplug._normalizeEnumSettingValue(3, relayValues), null);
});

test('irrigation timed on duration uses Zigbee tenths and reserves 0xFFFF', () => {
  assert.equal(IrrigationController._toTimedOnTime(1), 1);
  assert.equal(IrrigationController._toTimedOnTime(101), 2);
  assert.equal(IrrigationController._toTimedOnTime(1001), 11);
  assert.equal(IrrigationController._toTimedOnTime(Number.MAX_SAFE_INTEGER), 0xFFFE);
});
