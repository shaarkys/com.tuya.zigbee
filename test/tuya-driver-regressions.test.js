'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// The app runtime supplies Homey; only the prototype-level helpers are tested here.
const originalLoad = Module._load;
Module._load = function mockHomey(request, parent, isMain) {
  if (request === 'homey') return { Device: class {}, Driver: class {}, App: class {} };
  return originalLoad.call(this, request, parent, isMain);
};

const TuyaSpecificClusterDevice = require('../lib/TuyaSpecificClusterDevice');
const { HOBEIAN_SOIL_SENSOR_DATA_POINTS: hobeianSoil, V2_SOIL_SENSOR_DATA_POINTS: soil } = require('../lib/TuyaDataPoints');
const SoilSensorC3007Device = require('../drivers/soilsensor2/device');
const radarSensor2 = require('../drivers/radar_sensor_2/device');
const smartplug = require('../drivers/smartplug/device');
const IrrigationController = require('../drivers/smart_garden_irrigation_control/device');
const DoorWindowSensor = require('../drivers/doorwindowsensor/device');

const root = path.resolve(__dirname, '..');

test('door sensor restores missing CR2032 metadata once and preserves energy settings', async () => {
  for (const initialEnergy of [null, {}, { batteries: null }, { batteries: [], approximation: { usageConstant: 0 } }]) {
    const device = Object.create(DoorWindowSensor.prototype);
    let energy = initialEnergy;
    let writes = 0;
    device.getSetting = () => '_TZ3000_1bwpjvlz';
    device.driver = { manifest: { energy: { batteries: ['CR2032'] } } };
    device.getEnergy = () => energy;
    device.setEnergy = async value => { energy = value; writes += 1; };
    device.log = () => {};
    device.error = err => { throw err; };

    await device.restoreBatteryType();
    assert.deepEqual(energy, { ...initialEnergy, batteries: ['CR2032'] });
    await device.restoreBatteryType();
    assert.equal(writes, 1);
  }
});

test('door sensor preserves existing battery metadata and other manufacturer variants', async () => {
  for (const [manufacturer, energy] of [
    ['_TZ3000_1bwpjvlz', { batteries: ['CR2032'] }],
    ['_TZ3000_1bwpjvlz', { batteries: ['AAA', 'AAA'] }],
    ['_TZ3000_yxqnffam', {}],
  ]) {
    const device = Object.create(DoorWindowSensor.prototype);
    device.getSetting = () => manufacturer;
    device.getEnergy = () => energy;
    device.setEnergy = async () => assert.fail('Unexpected energy write');
    device.error = err => { throw err; };
    await device.restoreBatteryType();
  }
});

test('door sensor initialization continues after battery metadata migration fails', async () => {
  const device = Object.create(DoorWindowSensor.prototype);
  const failure = new Error('Energy update failed');
  let reportedError;
  let batteryListener;
  device.getSetting = () => '_TZ3000_1bwpjvlz';
  device.driver = { manifest: { energy: { batteries: ['CR2032'] } } };
  device.getEnergy = () => ({});
  device.setEnergy = async () => { throw failure; };
  device.printNode = () => {};
  device.log = () => {};
  device.error = (...args) => { reportedError = args; };
  device.isFirstInit = () => false;
  device.initBatteryVoltage = async () => {};
  const iasZone = {};
  const powerConfiguration = { on: (event, listener) => { batteryListener = listener; } };

  await device.onNodeInit({ zclNode: { endpoints: { 1: { clusters: { iasZone, powerConfiguration } } } } });
  assert.equal(reportedError[1], failure);
  assert.equal(typeof iasZone.onZoneStatusChangeNotification, 'function');
  assert.equal(typeof batteryListener, 'function');
});

function batteryVoltageDevice(manufacturer = '_TZ3000_1bwpjvlz') {
  const device = Object.create(DoorWindowSensor.prototype);
  const state = { capabilities: new Set(), store: {}, registrations: [], reports: [], reads: [], errors: [], retries: [] };
  device.getSetting = key => key === 'batteryThreshold' ? 20 : manufacturer;
  device.hasCapability = id => state.capabilities.has(id);
  device.addCapability = async id => { state.capabilities.add(id); };
  device.registerCapability = (...args) => { state.registrations.push(args); };
  device.getStoreValue = key => state.store[key];
  device.setStoreValue = async (key, value) => { state.store[key] = value; };
  device.configureAttributeReporting = async config => { state.reports.push(config); };
  device.getClusterCapabilityValue = async (...args) => { state.reads.push(args); };
  device.scheduleForNextEndDeviceAnnounce = callback => {
    state.retries.push(callback);
    return new Promise(() => {});
  };
  device.isFirstInit = () => false;
  device.log = () => {};
  device.error = (...args) => { state.errors.push(args); };
  return { device, state };
}

test('node identity restores both battery metadata and voltage when system settings are absent', async () => {
  const { device, state } = batteryVoltageDevice();
  device.node = { manufacturerName: '_TZ3000_1bwpjvlz' };
  device.getSetting = () => undefined;
  device.driver = { manifest: { energy: { batteries: ['CR2032'] } } };
  let energy = {};
  device.getEnergy = () => energy;
  device.setEnergy = async value => { energy = value; };
  device.printNode = () => {};
  device.getClusterCapabilityValue = async (...args) => {
    assert.equal(state.capabilities.has('measure_voltage'), true);
    assert.deepEqual(energy.batteries, ['CR2032']);
    state.reads.push(args);
    throw new Error('Sensor is sleeping');
  };
  const iasZone = {};
  const powerConfiguration = { on: () => {} };

  await device.onNodeInit({ zclNode: { endpoints: { 1: { clusters: { iasZone, powerConfiguration } } } } });
  assert.deepEqual(energy.batteries, ['CR2032']);
  assert.equal(state.capabilities.has('measure_voltage'), true);
  assert.equal(state.registrations.length, 1);
  assert.equal(state.reads.length, 1);
  assert.match(state.errors[0][1].message, /Sensor is sleeping/);
  assert.equal(typeof iasZone.onZoneStatusChangeNotification, 'function');
});

test('live Zigbee node identity takes precedence over a conflicting setting', async () => {
  const { device, state } = batteryVoltageDevice();
  device.node = { manufacturerName: '_TZ3000_yxqnffam' };
  device.getEnergy = () => assert.fail('Unrelated manufacturer must not be migrated');
  await device.restoreBatteryType();
  await device.initBatteryVoltage();
  assert.equal(state.capabilities.size, 0);
  assert.equal(state.registrations.length, 0);
  assert.equal(state.reads.length, 0);
});

test('existing target door sensor gains voltage reporting without repeated migration or registration', async () => {
  const { device, state } = batteryVoltageDevice();
  let additions = 0;
  device.addCapability = async id => { additions += 1; state.capabilities.add(id); };
  await device.initBatteryVoltage();
  await device.initBatteryVoltage();
  assert.equal(additions, 1);
  assert.equal(state.registrations.length, 1);
  const [capability, cluster, config] = state.registrations[0];
  assert.equal(capability, 'measure_voltage');
  assert.equal(cluster.NAME, 'powerConfiguration');
  assert.equal(config.get, 'batteryVoltage');
  assert.equal(config.report, 'batteryVoltage');
  assert.deepEqual(config.getOpts, { getOnStart: true, getOnOnline: true });
  assert.equal(config.getOpts.pollInterval, undefined);
  assert.equal(config.reportParser.call(device, 30), 3);
  assert.equal(state.reports.length, 1);
  assert.deepEqual(state.reports[0], [{
    endpointId: 1, cluster, attributeName: 'batteryVoltage', minInterval: 3600, maxInterval: 21600, minChange: 1,
  }]);
  assert.equal(state.store.batteryVoltageReportingConfigured, true);
  assert.equal(state.reads.length, 2);
  assert.equal(state.errors.length, 0);
});

test('battery voltage accepts ZCL decivolts and ignores unknown or malformed readings', () => {
  const { device } = batteryVoltageDevice();
  for (const [raw, volts] of [[0, 0], [25, 2.5], [28, 2.8], [30, 3], [31, 3.1], [254, 25.4]]) {
    assert.equal(device.parseBatteryVoltage(raw), volts);
  }
  for (const raw of [255, 256, -1, 2.5, null, undefined, NaN, Infinity, '30']) {
    assert.equal(device.parseBatteryVoltage(raw), null);
  }
});

test('installed Zigbee SDK routes voltage reports and announce reads through the registered capability', async () => {
  const { device, state } = batteryVoltageDevice();
  device.registerCapability = DoorWindowSensor.prototype.registerCapability;
  device._clusterCapabilityConfigurations = new Map();
  device.node = new EventEmitter();
  device.node.receiveWhenIdle = false;
  const powerConfiguration = new EventEmitter();
  device.zclNode = { endpoints: { 1: { clusters: { powerConfiguration } } } };
  device.debug = () => {};
  device.registerCapabilityListener = () => {};
  let voltage = null;
  device.getCapabilityValue = () => voltage;
  device.setCapabilityValue = async (id, value) => {
    assert.equal(id, 'measure_voltage');
    voltage = value;
  };

  await device.initBatteryVoltage();
  await device.initBatteryVoltage();
  assert.equal(powerConfiguration.listenerCount('attr.batteryVoltage'), 1);
  assert.equal(device.node.listenerCount('endDeviceAnnounce'), 1);
  powerConfiguration.emit('attr.batteryVoltage', 30);
  await new Promise(setImmediate);
  assert.equal(voltage, 3);
  powerConfiguration.emit('attr.batteryVoltage', 255);
  await new Promise(setImmediate);
  assert.equal(voltage, 3);
  const readsBeforeAnnounce = state.reads.length;
  device.node.emit('endDeviceAnnounce');
  assert.equal(state.reads.length, readsBeforeAnnounce + 1);
  assert.equal(state.errors.length, 0);
});

test('voltage configuration failure keeps reporting and reads active with one deferred retry', async () => {
  const { device, state } = batteryVoltageDevice();
  const failure = new Error('Sleepy sensor did not respond');
  device.configureAttributeReporting = async () => { throw failure; };
  await device.initBatteryVoltage();
  await device.initBatteryVoltage();
  assert.equal(state.store.batteryVoltageReportingConfigured, undefined);
  assert.equal(state.registrations.length, 1);
  assert.equal(state.reads.length, 2);
  assert.equal(state.retries.length, 1);
  assert.equal(state.errors[0][1], failure);

  device.configureAttributeReporting = async config => { state.reports.push(config); };
  await state.retries[0]();
  assert.equal(state.store.batteryVoltageReportingConfigured, true);
  assert.equal(state.reports.length, 1);
});

test('voltage capability migration failure leaves contact and battery percentage listeners active', async () => {
  const { device, state } = batteryVoltageDevice();
  const failure = new Error('Capability storage unavailable');
  device.addCapability = async () => { throw failure; };
  device.printNode = () => {};
  device.restoreBatteryType = async () => {};
  let percentageListener;
  const iasZone = {};
  const powerConfiguration = { on: (event, listener) => { percentageListener = listener; } };
  await device.onNodeInit({ zclNode: { endpoints: { 1: { clusters: { iasZone, powerConfiguration } } } } });
  assert.equal(state.errors[0][1], failure);
  assert.equal(typeof iasZone.onZoneStatusChangeNotification, 'function');
  assert.equal(typeof percentageListener, 'function');
  assert.equal(state.registrations.length, 0);
  assert.equal(state.reports.length, 0);
});

test('voltage support is scoped to the observed manufacturer and preserves percentage values', async () => {
  const { device, state } = batteryVoltageDevice('_TZ3000_yxqnffam');
  await device.initBatteryVoltage();
  assert.equal(state.capabilities.size, 0);
  assert.equal(state.registrations.length, 0);
  assert.equal(state.reports.length, 0);
  assert.equal(state.reads.length, 0);

  const values = [];
  device.setCapabilityValue = async (id, value) => { values.push([id, value]); };
  device.onBatteryPercentageRemainingAttributeReport(62);
  assert.deepEqual(values, [['measure_battery', 31], ['alarm_battery', false]]);
});

test('new door sensor uses the SDK initial voltage read and successful reporting survives restart', async () => {
  const { device, state } = batteryVoltageDevice();
  device.isFirstInit = () => true;
  await device.initBatteryVoltage();
  assert.equal(state.registrations[0][2].get, 'batteryVoltage');
  assert.equal(state.reads.length, 0);
  assert.equal(state.reports.length, 1);

  const restarted = batteryVoltageDevice();
  restarted.state.capabilities.add('measure_voltage');
  Object.assign(restarted.state.store, state.store);
  await restarted.device.initBatteryVoltage();
  assert.equal(restarted.state.reports.length, 0);
  assert.equal(restarted.state.reads.length, 1);
  assert.equal(restarted.state.registrations.length, 1);
});

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
  assert.deepEqual(hobeianSoil, {
    soilMoisture: 3,
    temperature: 5,
    displayUnit: 9,
    batteryPercentage: 15,
    soilMoistureCalibration: 102,
    temperatureCalibration: 104,
    humidityCalibration: 105,
    dryAlarm: 106,
    humidity: 109,
    alarmSoilMoistureMin: 110,
    temperatureSampling: 111,
    soilMoistureSampling: 112,
  });
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

test('soil sensor selects matching datapoints for reports and settings writes', async () => {
  for (const [manufacturer, productId, profile] of [
    ['HOBEIAN', 'ZG-303Z', hobeianSoil],
    ['_TZE200_wqashyqo', 'TS0601', soil],
  ]) {
    const device = Object.create(SoilSensorC3007Device.prototype);
    const capabilities = [];
    const writes = [];
    device.getSetting = key => ({ zb_manufacturer_name: manufacturer, zb_product_id: productId, display_unit: 'celsius' })[key];
    device.hasCapability = () => true;
    device.setCapabilityValue = async (capability, value) => { capabilities.push([capability, value]); };
    device.writeEnum = async (dp, value) => { writes.push([dp, value]); };
    device.log = () => {};
    device.debug = () => {};
    device._selectDatapoints();
    assert.equal(device._dp, profile);

    const report = (dp, value) => device._handleTuyaDatapoint({
      dp, datatype: 2, data: Buffer.from([0, 0, 0, value]),
    });
    report(profile.soilMoisture, 36);
    report(profile.temperature, 232);
    report(profile.humidity, 82);
    report(profile.batteryPercentage, 90);
    report(profile.dryAlarm, 1);
    assert.ok(capabilities.some(entry => entry[0] === 'measure_moisture' && entry[1] === 36));
    assert.ok(capabilities.some(entry => entry[0] === 'measure_temperature' && entry[1] === 23.2));
    assert.ok(capabilities.some(entry => entry[0] === 'measure_humidity' && entry[1] === 82));
    assert.ok(capabilities.some(entry => entry[0] === 'measure_battery' && entry[1] === 90));
    assert.ok(capabilities.some(entry => entry[0] === 'alarm_moisture' && entry[1] === true));

    await device.onSettings({ newSettings: { display_unit: 'fahrenheit' }, changedKeys: ['display_unit'] });
    assert.deepEqual(writes, [[profile.displayUnit, 1]]);
  }
});

test('ZG-303Z recovers from a wrong profile and processes observed Tuya reports', () => {
  const device = Object.create(SoilSensorC3007Device.prototype);
  const capabilities = [];
  device._dp = soil;
  device._lastDryFromDevice = null;
  device.getSetting = key => (key === 'alarm_soil_moisture_min' ? 20 : undefined);
  device.hasCapability = () => true;
  device.setCapabilityValue = async (capability, value) => { capabilities.push([capability, value]); };
  device.log = () => {};
  device.debug = () => {};

  device._handleTuyaDatapoint({ dp: 3, datatype: 2, data: Buffer.from([0, 0, 0, 32]) });
  device._handleTuyaDatapoint({ dp: 5, datatype: 2, data: Buffer.from([0, 0, 0, 213]) });
  device._handleTuyaDatapoint({ dp: 3, datatype: 2, data: Buffer.from([0, 0, 0, 34]) });
  assert.equal(device._dp, hobeianSoil);
  assert.ok(capabilities.some(entry => entry[0] === 'measure_moisture' && entry[1] === 32));
  assert.ok(capabilities.some(entry => entry[0] === 'measure_temperature' && entry[1] === 21.3));
  assert.ok(capabilities.some(entry => entry[0] === 'measure_moisture' && entry[1] === 34));
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
