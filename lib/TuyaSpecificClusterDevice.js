'use strict';

const { ZigBeeDevice } = require("homey-zigbeedriver");

/**
 * Class TuyaSpecificClusterDevice
 * 
 * This class handles writing various data types to a Tuya-specific cluster.
 * It abstracts sending boolean, integer, string, enum, and raw data types to
 * the appropriate Tuya datapoints.
 * 
 * Usage: Extend this class in your ZigBee device driver, and call the appropriate
 * write function (writeBool, writeData32, writeString, writeEnum, writeRaw) based
 * on the type of data you want to send.
 */
class TuyaSpecificClusterDevice extends ZigBeeDevice {

    // Transaction ID Management
    // Tuya requires a transaction ID to be incremented with each command. 
    // This is managed internally within this class.
    _transactionID = 0;
    
    set transactionID(val) {
        this._transactionID = val % 256;  // Ensure transaction ID stays within the range
    }

    get transactionID() {
        return this._transactionID;
    }

    getTuyaCommandName() {
        return 'datapoint';
    }

    async _sendTuyaDatapoint({ dp, datatype, length, data }) {
        const commandName = this.getTuyaCommandName();
        return await this.zclNode.endpoints[1].clusters.tuya[commandName]({
            status: 0,
            transid: this.transactionID++,
            dp,
            datatype,
            length,
            data
        });
    }

    /**
     * Sends a boolean value to the specified datapoint (dp).
     * 
     * @param {number} dp - The datapoint ID
     * @param {boolean} value - The boolean value to write (true/false)
     * @returns {Promise} - Resolves when the command is sent
     */
    async writeBool(dp, value, { throwOnError = false } = {}) {
        const data = Buffer.alloc(1);
        data.writeUInt8(value ? 0x01 : 0x00, 0);
        this.log('[WRITE BOOL] DP:', dp, 'Value:', value, 'Datatype: 1, Length: 1, Data:', data);
        try {
            return await this._sendTuyaDatapoint({
                dp,
                datatype: 1,
                length: 1,
                data
            });
        } catch (err) {
            this.error(`Error writing boolean to dp ${dp}:`, err);
            if (throwOnError) throw err;
        }
    }

    /**
     * Sends a 32-bit integer value to the specified datapoint (dp).
     * 
     * @param {number} dp - The datapoint ID
     * @param {number} value - The integer value to write
     * @returns {Promise} - Resolves when the command is sent
     */
    async writeData32(dp, value, { throwOnError = false } = {}) {
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0xFFFFFFFF) {
            throw new RangeError('DATA32 value must be an integer between -2147483648 and 4294967295');
        }
        const data = Buffer.alloc(4);
        if (value < 0) {
            data.writeInt32BE(value, 0);
        } else {
            data.writeUInt32BE(value, 0);
        }
        this.log('[WRITE DATA32] DP:', dp, 'Value:', value, 'Datatype: 2, Length: 4, Data:', data);
        try {
            return await this._sendTuyaDatapoint({
                dp,
                datatype: 2,
                length: 4,
                data
            });
        } catch (err) {
            this.error(`Error writing data32 to dp ${dp}:`, err);
            if (throwOnError) throw err;
        }
    }

    /**
     * Sends a string value to the specified datapoint (dp).
     * 
     * @param {number} dp - The datapoint ID
     * @param {string} value - The string value to write
     * @returns {Promise} - Resolves when the command is sent
     */
    async writeString(dp, value, { throwOnError = false } = {}) {
        const data = Buffer.from(String(value), 'latin1');
        try {
            return await this._sendTuyaDatapoint({
                dp,
                datatype: 3,
                length: value.length,
                data
            });
        } catch (err) {
            this.error(`Error writing string to dp ${dp}:`, err);
            if (throwOnError) throw err;
        }
    }

    /**
     * Sends an enum value to the specified datapoint (dp).
     * 
     * @param {number} dp - The datapoint ID
     * @param {number} value - The enum value to write (must be within the enum range)
     * @returns {Promise} - Resolves when the command is sent
     */
    async writeEnum(dp, value, { throwOnError = false } = {}) {
        const data = Buffer.alloc(1);
        data.writeUInt8(value, 0);
        this.log('[WRITE ENUM] DP:', dp, 'Value:', value, 'Datatype: 1, Length: 1, Data:', data);
        try {
            return await this._sendTuyaDatapoint({
                dp,
                datatype: 4,
                length: 1,
                data
            });
        } catch (err) {
            this.error(`Error writing enum to dp ${dp}:`, err);
            if (throwOnError) throw err;
        }
    }

    /**
     * Sends raw data to the specified datapoint (dp).
     * 
     * @param {number} dp - The datapoint ID
     * @param {Buffer} data - The raw data buffer to write
     * @returns {Promise} - Resolves when the command is sent
     */
    async writeRaw(dp, data, { throwOnError = false } = {}) {
        try {
            return await this._sendTuyaDatapoint({
                dp,
                datatype: 0,
                length: data.length,
                data
            });
        } catch (err) {
            this.error(`Error writing raw data to dp ${dp}:`, err);
            if (throwOnError) throw err;
        }
    }
}

module.exports = TuyaSpecificClusterDevice;
