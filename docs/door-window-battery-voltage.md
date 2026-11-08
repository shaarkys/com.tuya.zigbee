# TS0203 battery voltage

The `doorwindowsensor` driver adds Homey's standard `measure_voltage` capability
at initialization for `_TZ3000_1bwpjvlz`, including already paired devices. It
uses the built-in voltage icon, V unit, Insights, and Flow support. The base
driver manifest retains its shared capabilities because the driver also serves
other manufacturer variants whose voltage support has not been verified.

Manufacturer matching uses the initialized ZigBeeNode's documented
`manufacturerName` property first, with the old `zb_manufacturer_name` app setting
as a compatibility fallback. Homey's device export may display Zigbee system
settings that are absent from the app's settings lookup. Initialization logs
`Door sensor battery support initialization | manufacturer: ...`, so a skipped
model match can be distinguished from a failed capability migration.

The sensor's recorded interview in `device.js` exposes Power Configuration
attribute `batteryVoltage` (`0x0020`) with raw value 30. This attribute uses 100 mV
units: raw 30 means 3.0 V. `0xFF` means unknown and is ignored, along with malformed
values. Logs include both raw and converted readings.

## Reporting and migration

- The voltage capability is added only when missing; existing capabilities and
  paired-device identity are preserved.
- Voltage reporting is configured for new and existing devices with a minimum
  interval of one hour, maximum interval of six hours, and a change of one raw
  unit (0.1 V). Firmware may reject or ignore this configuration.
- Successful configuration is recorded as the boolean store key
  `batteryVoltageReportingConfigured`, so it is not repeated on every restart.
- A failed configuration logs its cause and schedules one deferred attempt on
  the next end-device announce. A failed deferred attempt is logged; the next
  app initialization can try again. There is no periodic polling.
- The SDK reads voltage on first pairing and on subsequent end-device announces.
  An already paired device also gets an initial read attempt after migration or
  restart. A sleeping sensor may not answer until it is awake.
- A capability migration or voltage configuration failure does not disable
  contact or battery percentage reporting.

## Research (8 November 2026)

[Zigbee2MQTT's TS0203 definition](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/devices/tuya.ts)
exposes battery voltage, configures voltage reporting, and uses a voltage-based
percentage mapping (`3V_1500_2800`) because the sensor's percentage is often
incorrect. Its [battery converter](https://github.com/Koenkk/zigbee-herdsman-converters/blob/master/src/converters/fromZigbee.ts)
converts the raw voltage to millivolts with a factor of 100, equivalent to dividing
by 10 for Homey's V unit.

The [merged TS0203 battery change](https://github.com/Koenkk/zigbee-herdsman-converters/pull/7681)
also documents sensors reporting 2.5 V / 1% for months, and notes that voltage can
under-read relative to a battery tester. Those reports concern the TS0203 family;
they do not establish the calibration of this specific manufacturer's firmware.

This change exposes the device-reported voltage for comparison. It preserves the
existing battery percentage calculation and alarms. The voltage is not a
calibrated estimate of remaining CR2032 life.

[Homey's capability documentation](https://apps.developer.homey.app/the-basics/devices/capabilities)
and [Device API](https://apps-sdk-v3.developer.homey.app/Device.html#addCapability)
support adding capabilities to existing devices. No custom capability, asset,
dependency, or version change is required.

## Manual Homey check

1. Install the updated local build and inspect the existing sensor. Confirm its
   capabilities include `measure_voltage` with a voltage icon and V unit, and
   its battery type shows CR2032. Re-pairing is not required.
2. Let the sensor wake normally, or briefly press its wake button according to
   the device instructions without entering pairing mode. Confirm logs show
   `Door sensor batteryVoltage | raw: ... | voltage: ... V` and the capability
   updates. Opening the contact alone may not produce an end-device announce.
3. Record voltage and percentage for the old battery and a fresh CR2032. Compare
   with a meter if available; do not interpret a fixed voltage offset as actual
   battery depletion.
4. Restart the app and confirm voltage remains available, no capability is
   added twice, and successful reporting configuration is not repeated. Open and
   close the contact and verify existing contact Flows still run.

Local unit tests and package validation do not verify real-device reporting.
