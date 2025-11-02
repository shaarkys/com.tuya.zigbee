'use strict';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hsvToRgb255(hueDegrees, saturationPercent, valuePercent) {
  if (!Number.isFinite(hueDegrees)) hueDegrees = 0;
  if (!Number.isFinite(saturationPercent)) saturationPercent = 0;
  if (!Number.isFinite(valuePercent)) valuePercent = 0;

  const h = ((hueDegrees % 360) + 360) % 360;
  const s = clamp(saturationPercent, 0, 100) / 100;
  const v = clamp(valuePercent, 0, 100) / 100;

  if (s === 0) {
    const gray = v * 255;
    return [gray, gray, gray];
  }

  const sector = h / 60;
  const sectorIndex = Math.floor(sector) % 6;
  const fraction = sector - Math.floor(sector);

  const p = 255 * v * (1 - s);
  const q = 255 * v * (1 - (s * fraction));
  const t = 255 * v * (1 - (s * (1 - fraction)));
  const v255 = v * 255;

  switch (sectorIndex) {
    case 0: return [v255, t, p];
    case 1: return [q, v255, p];
    case 2: return [p, v255, t];
    case 3: return [p, q, v255];
    case 4: return [t, p, v255];
    default: return [v255, p, q];
  }
}

function rgb255ToHsv(r255, g255, b255) {
  const r = clamp(r255, 0, 255) / 255;
  const g = clamp(g255, 0, 255) / 255;
  const b = clamp(b255, 0, 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    switch (max) {
      case r:
        hue = ((g - b) / delta) % 6;
        break;
      case g:
        hue = ((b - r) / delta) + 2;
        break;
      default:
        hue = ((r - g) / delta) + 4;
        break;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const saturation = max === 0 ? 0 : (delta / max) * 100;
  const value = max * 100;

  return [hue, saturation, value];
}

function rgb255ToXyz(r255, g255, b255) {
  const transform = value => {
    const channel = clamp(value, 0, 255) / 255;
    return channel > 0.04045
      ? Math.pow((channel + 0.055) / 1.055, 2.4)
      : channel / 12.92;
  };

  const r = transform(r255);
  const g = transform(g255);
  const b = transform(b255);

  const x = (r * 0.41239079926595) + (g * 0.35758433938387) + (b * 0.18048078840183);
  const y = (r * 0.21263900587151) + (g * 0.71516867876775) + (b * 0.072192315360733);
  const z = (r * 0.019330818715591) + (g * 0.11919477979462) + (b * 0.95053215224966);

  return [x * 100, y * 100, z * 100];
}

function xyzToRgb255(x, y, z) {
  const xn = x / 100;
  const yn = y / 100;
  const zn = z / 100;

  let r = (xn * 3.240969941904521) + (yn * -1.537383177570093) + (zn * -0.498610760293);
  let g = (xn * -0.96924363628087) + (yn * 1.87596750150772) + (zn * 0.041555057407175);
  let b = (xn * 0.055630079696993) + (yn * -0.20397695888897) + (zn * 1.056971514242878);

  const inverseTransform = channel => (channel > 0.0031308
    ? (1.055 * Math.pow(channel, 1 / 2.4)) - 0.055
    : channel * 12.92);

  r = inverseTransform(r);
  g = inverseTransform(g);
  b = inverseTransform(b);

  return [
    clamp(r, 0, 1) * 255,
    clamp(g, 0, 1) * 255,
    clamp(b, 0, 1) * 255,
  ];
}

function xyzToXyy(x, y, z) {
  const sum = x + y + z;
  if (sum === 0) return [0, 0, y];
  return [x / sum, y / sum, y];
}

function xyyToXyz(x, y, Y) {
  if (y === 0) return [0, 0, 0];
  const X = (x * Y) / y;
  const Z = ((1 - x - y) * Y) / y;
  return [X, Y, Z];
}

const FAKE_TEMP_BLUE = { r: 217, g: 244, b: 255 };
const FAKE_TEMP_WHITE = { r: 255, g: 255, b: 255 };
const FAKE_TEMP_YELLOW = { r: 255, g: 201, b: 59 };

const FAKE_TEMPERATURE_STOPS = [
  { position: 0, color: FAKE_TEMP_BLUE },
  { position: 0.5, color: FAKE_TEMP_WHITE },
  { position: 1, color: FAKE_TEMP_YELLOW },
];

function interpolateTemperatureRgb(temperature) {
  const t = clamp(temperature, 0, 1);

  for (let i = 0; i < FAKE_TEMPERATURE_STOPS.length - 1; i += 1) {
    const current = FAKE_TEMPERATURE_STOPS[i];
    const next = FAKE_TEMPERATURE_STOPS[i + 1];
    if (t <= next.position) {
      const range = next.position - current.position || 1;
      const ratio = (t - current.position) / range;
      return {
        r: ((next.color.r - current.color.r) * ratio) + current.color.r,
        g: ((next.color.g - current.color.g) * ratio) + current.color.g,
        b: ((next.color.b - current.color.b) * ratio) + current.color.b,
      };
    }
  }

  const lastStop = FAKE_TEMPERATURE_STOPS[FAKE_TEMPERATURE_STOPS.length - 1];
  return { ...lastStop.color };
}

/**
 * @typedef {Object} CIExyY
 * @property {number} x - CIE x (small x) value, range 0 - 1 (for Zigbee CurrentX multiply by
 * 65536)
 * @property {number} y - CIE y (small y) value, range 0 - 1 (for Zigbee CurrentY multiply by
 * 65536)
 * @property {number} Y - CIE Y value, range 0 - 100, this represents the luminance which is not
 * used by the Zigbee color control cluster.
 */

/**
 * @typedef {Object} HSV
 * @property {number} hue - Hue value, range 0 - 1.
 * @property {number} saturation - Saturation value, range 0 - 1.
 * @property {number} value - Value (brightness) value, range 0 - 1.
 */

/**
 * Method that converts colors from the HSV (or HSL) color space to the CIE (1931) color space.
 * @param {HSV} - HSV color object
 * @returns {CIExyY} - CIExyY color space object
 * @memberof Util
 */
function convertHSVToCIE({ hue, saturation, value }) {
  if (typeof hue !== 'number') hue = 1;
  if (typeof saturation !== 'number') saturation = 1;
  if (typeof value !== 'number') value = 1;

  const [r, g, b] = hsvToRgb255(hue * 360, saturation * 100, value * 100);
  const [X, Y, Z] = rgb255ToXyz(r, g, b);
  const [x, y, YResult] = xyzToXyy(X, Y, Z);
  return { x, y, Y: YResult };
}

/**
 * Method that converts colors from the CIE (xyY) color space to the HSV color space. Note: do
 * not use this for converting xy values from Zigbee devices to HSV, that seems to be inaccurate
 * (see: https://github.com/colorjs/color-space/issues/48).
 * @param {CIExyY} - xyY color object
 * @returns {HSV} - HSV color object
 * @memberof Util
 */
function convertCIEToHSV({ x, y, Y }) {
  const [X, YY, Z] = xyyToXyz(x, y, typeof Y === 'number' ? Y : 100);
  const [r, g, b] = xyzToRgb255(X, YY, Z);
  const [hue, saturation, value] = rgb255ToHsv(r, g, b);
  return {
    hue: hue / 360,
    saturation: saturation / 100,
    value: value / 100,
  };
}

/**
 * Takes a temperature value (0-1) and returns a HSV object. It tries to mimic the light
 * temperature capabilities some devices have for RGB devices.
 * @param {number} temperature
 * @returns {HSV} - Range 0 - 1
 * @memberof Util
 */
function mapTemperatureToHueSaturation(temperature) {
  const { r, g, b } = interpolateTemperatureRgb(temperature);
  const [hue, saturation, value] = rgb255ToHsv(r, g, b);
  return {
    hue: hue / 360,
    saturation: saturation / 100,
    value: value / 100 || 1,
  };
}

module.exports = {
  convertHSVToCIE,
  convertCIEToHSV,
  mapTemperatureToHueSaturation,
};
