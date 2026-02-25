'use strict';

/**
 * TuyaSpecificCluster
 * 
 * This class defines the Tuya-specific Zigbee cluster and its associated commands.
 * It includes the following commands: `datapoint`, `reporting`, `response`, 
 * and `reportingConfiguration`. These commands facilitate communication between
 * Zigbee devices using the Tuya protocol.
 * 
 * Usage:
 * This class is used as part of the Zigbee driver for devices that support the 
 * Tuya Zigbee protocol. The commands can be extended or customized based on 
 * the device's needs.
 * 
 * Make sure to register this cluster using `Cluster.addCluster(TuyaSpecificCluster)` 
 * in your driver file.
 */

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

// Attributes definition (currently empty, can be extended as needed)
const ATTRIBUTES = {};

// Commands definition for Tuya-specific communication
const COMMANDS = {
    /**
     * Command to send a datapoint to a Tuya Zigbee device.
     * 
     * This command is used for sending specific data points (dp) to the device. 
     * The dp defines the action/message of a command frame.
     */
    datapoint: {
        id: 0, // Command ID
        direction: Cluster.DIRECTION_CLIENT_TO_SERVER,
        args: {
            status: ZCLDataTypes.uint8,    // Status byte
            transid: ZCLDataTypes.uint8,   // Transaction ID
            dp: ZCLDataTypes.uint8,        // Datapoint ID
            datatype: ZCLDataTypes.uint8,  // Datatype ID (boolean, enum, etc.)
            length: ZCLDataTypes.data16,   // Length of data
            data: ZCLDataTypes.buffer      // Data payload
        }
    },
    
    dataQuery: {
        id: 0x03, // Command ID
        direction: Cluster.DIRECTION_CLIENT_TO_SERVER,
    },

    /**
     * Command to report a datapoint change from the device.
     * 
     * This command is triggered when the device reports a change in one of its
     * datapoints, allowing the application to update its state.
     */
    reporting: {
        id: 0x01, // Command ID
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        args: {
            status: ZCLDataTypes.uint8,    // Status byte
            transid: ZCLDataTypes.uint8,   // Transaction ID
            dp: ZCLDataTypes.uint8,        // Datapoint ID
            datatype: ZCLDataTypes.uint8,  // Datatype ID
            length: ZCLDataTypes.data16,   // Length of data
            data: ZCLDataTypes.buffer      // Data payload
        }
    },
    
    /**
     * Command for device responses.
     * 
     * This command handles the response from a Tuya Zigbee device. The response 
     * includes information about the status, datapoint, and any data sent back 
     * by the device.
     */
    response: {
        id: 0x02, // Command ID
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        args: {
            status: ZCLDataTypes.uint8,    // Status byte
            transid: ZCLDataTypes.uint8,   // Transaction ID
            dp: ZCLDataTypes.uint8,        // Datapoint ID
            datatype: ZCLDataTypes.uint8,  // Datatype ID
            length: ZCLDataTypes.data16,   // Length of data
            data: ZCLDataTypes.buffer      // Data payload
        }
    },

    /**
     * Some Tuya devices (including Fingerbot variants) report datapoints via cmdId 0x05.
     * The payload layout matches the standard Tuya datapoint envelope.
     */
    statusReport: {
        id: 0x05,
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        args: {
            status: ZCLDataTypes.uint8,
            transid: ZCLDataTypes.uint8,
            dp: ZCLDataTypes.uint8,
            datatype: ZCLDataTypes.uint8,
            length: ZCLDataTypes.data16,
            data: ZCLDataTypes.buffer
        }
    },
    
    /**
     * Command for reporting configuration.
     * 
     * This command allows the configuration of reporting for the Tuya device, 
     * setting up how and when the device should report its state or data.
     */
    reportingConfiguration: {
        id: 0x06, // Command ID
        direction: Cluster.DIRECTION_CLIENT_TO_SERVER,
        args: {
            status: ZCLDataTypes.uint8,    // Status byte
            transid: ZCLDataTypes.uint8,   // Transaction ID
            dp: ZCLDataTypes.uint8,        // Datapoint ID
            datatype: ZCLDataTypes.uint8,  // Datatype ID
            length: ZCLDataTypes.data16,   // Length of data
            data: ZCLDataTypes.buffer      // Data payload
        }
    },

    /**
     * Some Tuya devices also use cmdId 0x06 in the same datapoint envelope format.
     */
    statusReportAlt: {
        id: 0x06,
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        args: {
            status: ZCLDataTypes.uint8,
            transid: ZCLDataTypes.uint8,
            dp: ZCLDataTypes.uint8,
            datatype: ZCLDataTypes.uint8,
            length: ZCLDataTypes.data16,
            data: ZCLDataTypes.buffer
        }
    },

    /**
     * Optional short response on some firmware variants.
     */
    queryResponse: {
        id: 0x0b,
        direction: Cluster.DIRECTION_SERVER_TO_CLIENT,
        args: {
            status: ZCLDataTypes.uint8,
            transid: ZCLDataTypes.uint8
        }
    },
};

/**
 * TuyaSpecificCluster Class
 * 
 * This class extends the base Cluster class from the zigbee-clusters library and 
 * defines custom behavior for the Tuya Zigbee protocol.
 * 
 * Methods:
 * - onReporting(response): Emits a `reporting` event when a reporting command is received.
 * - onResponse(response): Emits a `response` event when a response command is received.
 * - onReportingConfiguration(response): Emits a `reportingConfiguration` event when a 
 *    reporting configuration command is received.
 */
class TuyaSpecificCluster extends Cluster {
    
    // Static properties defining the cluster's ID and name
    static get ID() {
        return 61184;  // Tuya-specific cluster ID
    }

    static get NAME() {
        return 'tuya';  // Cluster name
    }

    static get ATTRIBUTES() {
        return ATTRIBUTES;  // Attributes defined (currently empty)
    }

    static get COMMANDS() {
        return COMMANDS;  // Commands defined for the cluster
    }

    /**
     * Method called when a reporting command is received.
     * Emits a `reporting` event with the response data.
     * 
     * @param {Object} response - The response data from the device
     */
    onReporting(response) {
        this.emit('reporting', response);
    }

    /**
     * Method called when a response command is received.
     * Emits a `response` event with the response data.
     * 
     * @param {Object} response - The response data from the device
     */
    onResponse(response) {
        this.emit('response', response);
    }

    /**
     * Method called when a cmdId 0x05 datapoint report is received.
     * Route as a generic datapoint report for existing drivers.
     */
    onStatusReport(response) {
        this.emit('reporting', response);
    }

    /**
     * Method called when a reporting configuration command is received.
     * Emits a `reportingConfiguration` event with the response data.
     * 
     * @param {Object} response - The response data from the device
     */
    onReportingConfiguration(response) {
        this.emit('reportingConfiguration', response);
    }

    /**
     * Method called when a cmdId 0x06 datapoint report is received.
     * Route as a generic datapoint report for existing drivers.
     */
    onStatusReportAlt(response) {
        this.emit('reporting', response);
    }

    /**
     * Method called when a cmdId 0x0b short query response is received.
     */
    onQueryResponse(response) {
        this.emit('response', response);
    }
}

// Register the TuyaSpecificCluster with the zigbee-clusters library
Cluster.addCluster(TuyaSpecificCluster);

module.exports = TuyaSpecificCluster;
