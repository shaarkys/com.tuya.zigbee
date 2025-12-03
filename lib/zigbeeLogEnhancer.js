'use strict';

const Cluster = require('zigbee-clusters/lib/Cluster');
const Endpoint = require('zigbee-clusters/lib/Endpoint');
const Node = require('zigbee-clusters/lib/Node');
const { getPropertyDescriptor } = require('zigbee-clusters/lib/util');
const ZigBeeDevice = attemptRequireZigBeeDevice();

const GLOBAL_STATE_KEY = '__TUYA_ZIGBEE_LOG_ENHANCER__';
const globalState = globalThis[GLOBAL_STATE_KEY] || (globalThis[GLOBAL_STATE_KEY] = {});

if (!globalState.nodeMeta) {
  globalState.nodeMeta = new WeakMap();
}

if (!globalState.loggingPatched) {
  patchLogging();
  globalState.loggingPatched = true;
}

if (ZigBeeDevice && !globalState.devicePatched) {
  patchZigBeeDevice(ZigBeeDevice);
  globalState.devicePatched = true;
}

function attemptRequireZigBeeDevice() {
  try {
    // eslint-disable-next-line global-require
    return require('homey-zigbeedriver/lib/ZigBeeDevice');
  } catch (err) {
    // Outside of the Homey runtime the zigbee driver (and indirectly the `homey` module) is not
    // available. In that case we simply skip the patch; the real runtime will still apply it.
    return null;
  }
}

function patchLogging() {
  patchClusterLogId();
  patchEndpointGetLogId();
  patchNodeGetLogId();
}

function patchClusterLogId() {
  const descriptor = getPropertyDescriptor(Cluster.prototype, 'logId');
  const originalGetter = descriptor && typeof descriptor.get === 'function' ? descriptor.get : null;

  Object.defineProperty(Cluster.prototype, 'logId', {
    configurable: true,
    enumerable: false,
    get() {
      const base = originalGetter ? originalGetter.call(this) : '';
      const meta = extractNodeMeta(this._endpoint && this._endpoint._node);
      const prefix = buildPrefix(meta);
      return prefix ? `${prefix} ${base}` : base;
    },
  });
}

function patchEndpointGetLogId() {
  const original = Endpoint.prototype.getLogId;

  Endpoint.prototype.getLogId = function patchedGetLogId(clusterId) {
    const base = original ? original.apply(this, arguments) : '';
    const meta = extractNodeMeta(this._node);
    const prefix = buildPrefix(meta);
    return prefix ? `${prefix} ${base}` : base;
  };
}

function patchNodeGetLogId() {
  const original = Node.prototype.getLogId;

  Node.prototype.getLogId = function patchedNodeGetLogId(endpointId, clusterId) {
    const base = original ? original.apply(this, arguments) : '';
    const meta = extractNodeMeta(this);
    const prefix = buildPrefix(meta);
    return prefix ? `${prefix} ${base}` : base;
  };
}

function patchZigBeeDevice(ZigBeeDeviceCtor) {
  if (!ZigBeeDeviceCtor || ZigBeeDeviceCtor.prototype.__tuyaLogEnhancerPatched) return;

  const originalOnInit = ZigBeeDeviceCtor.prototype.onInit;

  ZigBeeDeviceCtor.prototype.onInit = async function patchedOnInit(...args) {
    const originalOnNodeInit = this.onNodeInit;

    this.onNodeInit = async initArgs => {
      attachLogMeta(this, initArgs ? initArgs.zclNode : undefined, initArgs ? initArgs.node : undefined);
      if (typeof originalOnNodeInit === 'function') {
        return originalOnNodeInit.call(this, initArgs || {});
      }
      return undefined;
    };

    try {
      return await originalOnInit.apply(this, args);
    } finally {
      this.onNodeInit = originalOnNodeInit;
    }
  };

  Object.defineProperty(ZigBeeDeviceCtor.prototype, '__tuyaLogEnhancerPatched', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function attachLogMeta(device, zclNode, rawNode) {
  if (!zclNode || typeof zclNode !== 'object') return;

  const meta = getOrCreateMeta(zclNode);
  if (device) {
    ensureSet(meta, 'devices').add(device);
  }

  const data = safeInvoke(() => (typeof device.getData === 'function' ? device.getData() : null));
  if (data && typeof data === 'object') {
    if (data.token) meta.token = data.token;
    if (data.id) meta.id = data.id;
    const tokenValue = data.token || data.id;
    if (tokenValue) ensureSet(meta, 'tokens').add(String(tokenValue));
  }

  const name = safeInvoke(() => (typeof device.getName === 'function' ? device.getName() : null));
  if (name) {
    meta.name = name;
    ensureSet(meta, 'names').add(name);
  }

  const driverId = device && device.driver && device.driver.id;
  if (driverId) {
    meta.driverId = driverId;
    ensureSet(meta, 'driverIds').add(driverId);
  }

  if (rawNode && typeof rawNode === 'object') {
    meta.ieeeAddress = rawNode.ieeeAddress || rawNode.ieeeAddr || meta.ieeeAddress;
    const networkAddress = getNetworkAddress(rawNode);
    if (typeof networkAddress === 'number') {
      meta.networkAddress = networkAddress;
    }
  }

  meta.updatedAt = Date.now();
  globalState.nodeMeta.set(zclNode, meta);
}

function extractNodeMeta(node) {
  if (!node || typeof node !== 'object') return null;
  if (globalState.nodeMeta && globalState.nodeMeta.has(node)) {
    return globalState.nodeMeta.get(node);
  }
  return node.__tuyaLogMeta || node.__tuyaLogInfo || null;
}

function getOrCreateMeta(node) {
  if (!globalState.nodeMeta) {
    globalState.nodeMeta = new WeakMap();
  }

  if (!node.__tuyaLogMeta) {
    Object.defineProperty(node, '__tuyaLogMeta', {
      value: {},
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  const meta = node.__tuyaLogMeta;
  globalState.nodeMeta.set(node, meta);
  return node.__tuyaLogMeta;
}

function buildPrefix(meta) {
  if (!meta) return '';

  const parts = [];
  const label = computeLabel(meta);
  if (label) parts.push(label);

  const driverIds = collectSet(meta, 'driverIds');
  if (driverIds.length === 1) {
    parts.push(`driver:${driverIds[0]}`);
  } else if (driverIds.length > 1) {
    parts.push(`drivers:${driverIds.join(',')}`);
  }

  if (meta.ieeeAddress && meta.ieeeAddress !== label) {
    parts.push(meta.ieeeAddress);
  }

  if (typeof meta.networkAddress === 'number') {
    parts.push(`nwk:0x${meta.networkAddress.toString(16).padStart(4, '0')}`);
  }

  if (!parts.length) return '';

  const uniqueParts = [...new Set(parts.filter(Boolean))];
  return uniqueParts.length ? `[${uniqueParts.join(' | ')}]` : '';
}

function computeLabel(meta) {
  const devices = collectDevices(meta);
  const labels = devices.map(device => {
    const name = safeInvoke(() => (typeof device.getName === 'function' ? device.getName() : undefined));
    const data = safeInvoke(() => (typeof device.getData === 'function' ? device.getData() : undefined)) || {};
    const token = data && (data.token || data.id);
    if (name && token) return `${name} (${token})`;
    if (name) return name;
    if (token) return token;
    return null;
  }).filter(Boolean);

  if (!labels.length) {
    const nameFallbacks = collectSet(meta, 'names');
    if (nameFallbacks.length) labels.push(...nameFallbacks);
  }

  if (!labels.length) {
    const tokens = collectSet(meta, 'tokens');
    if (tokens.length) labels.push(...tokens);
  }

  if (!labels.length && meta.token) labels.push(meta.token);
  if (!labels.length && meta.id) labels.push(meta.id);
  if (!labels.length && meta.ieeeAddress) labels.push(meta.ieeeAddress);

  if (!labels.length) return null;

  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]}, ${labels[1]}`;
  return `${labels[0]}, ${labels[1]} +${labels.length - 2} more`;
}

function collectDevices(meta) {
  if (meta.devices instanceof Set && meta.devices.size) return Array.from(meta.devices);
  if (meta.device) return [meta.device];
  return [];
}

function getNetworkAddress(node) {
  if (typeof node.networkAddress === 'number') return node.networkAddress;
  if (typeof node.nwkAddress === 'number') return node.nwkAddress;
  if (typeof node.nwkAddr === 'number') return node.nwkAddr;
  if (typeof node.shortAddress === 'number') return node.shortAddress;
  if (typeof node.id === 'number') return node.id;
  return undefined;
}

function safeInvoke(fn) {
  try {
    return fn();
  } catch (err) {
    return undefined;
  }
}

function ensureSet(target, key) {
  if (!(target[key] instanceof Set)) {
    target[key] = new Set();
  }
  return target[key];
}

function collectSet(meta, key) {
  if (meta[key] instanceof Set) return Array.from(meta[key]);
  return [];
}

module.exports = {
  attachLogMeta,
};
