'use strict';

/*
 * Created with @iobroker/create-adapter v1.29.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
//const { all } = require('axios');
const axios = require('axios').default;
const xml2js = require('xml2js');

// Load your modules here, e.g.:
// const fs = require("fs");
const SESSION_RETRYS = 3; // Total number of session re-establish attempts before adapter is sent to sleep = SESSION_RETRYS + 1
const IP_FORMAT =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const PIN_FORMAT = /^(\d{4})$/;
const sleeps = new Map();

let timeOutMessage;
let sessionTimestamp = 0;
let notifyTimestamp = 0;
let lastSleepClear = 0;
let polling = false;
let sessionRetryCnt = SESSION_RETRYS;

let currentNavNumItems = 0;
let currentNavNumItemsMax = 0;
let currentNavIndex = 0;
let currentNavType = 0;
let currentNavSubtype = 0;
let currentNavList = [];
const currentNavListChunk = 25;
let allModes = {};
let currentNavChunks = []; // neu: Liste von Chunk-Start-Keys (als Strings) für infinite Listen
let currentNavChunkIndex = 0; // neu: aktueller Chunk-Index in currentNavChunks

class FrontierSilicon extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'frontier_silicon',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        await this.setState('info.connection', false, true);

        if (!this.config.IP) {
            this.log.error(`Device IP is empty - please check instance configuration of ${this.namespace}`);
            return;
        } else if (!this.config.IP.match(IP_FORMAT)) {
            this.log.error(`Device IP format not valid. Should be e.g. 192.168.123.123`);
            return;
        }
        if (!this.config.PIN) {
            this.log.error(`PIN code is empty - please check instance configuration of ${this.namespace}`);
            return;
        } else if (!this.config.PIN.match(PIN_FORMAT)) {
            this.log.error(
                `PIN code ${this.config.PIN} format not valid. Should be four decimal digits. Default is 1234`,
            );
            return;
        }
        try {
            await this.getDeviceInfo();
        } catch (err) {
            this.log.debug(`Error in getDeviceInfo: ${JSON.stringify(err)}`);
            //this.log.error(err);
            this.log.info(
                'Check if you entered the correct IP address of your device and if it is reachable on your network.',
            );
            return;
        }

        // create session to check for PIN mismatch
        const conn = await this.getStateAsync('info.connection');
        if (conn === null || conn === undefined || !conn.val || this.config.SessionID === 0) {
            try {
                await this.createSession();
            } catch (err) {
                this.log.error(String(err));
                return;
            }
        }

        await this.discoverDeviceFeatures();
        await this.discoverState();
        await this.getAllPresets(false);

        this.onFSAPIMessage();
        // In order to get state updates, you need to subscribe to them.
        // The following line adds a subscription for our variable we have created above.
        // this.subscribeStates("testVariable");
        // You can also add a subscription for multiple states.
        // The following line watches all states starting with "lights."
        // this.subscribeStates("lights.*");
        // Or, if you really must, you can also watch all states.
        // Don't do this if you don't need to.
        // Otherwise this will cause a lot of unnecessary load on the system:
        this.subscribeStates('device.power');
        this.subscribeStates('device.friendlyName');
        this.subscribeStates('device.dayLightSavingTime');
        this.subscribeStates('modes.*.switchTo');
        this.subscribeStates('modes.*.presets.*.recall');
        this.subscribeStates('modes.selected');
        this.subscribeStates('modes.selectPreset');
        this.subscribeStates('modes.presetUp');
        this.subscribeStates('modes.presetDown');
        this.subscribeStates('modes.navigationUp');
        this.subscribeStates('modes.navigationDown');
        this.subscribeStates('modes.navigationSelect');
        this.subscribeStates('modes.navigationBack');
        this.subscribeStates('modes.navigationSearch');
        this.subscribeStates('audio.mute');
        this.subscribeStates('audio.volume');
        this.subscribeStates('modes.readPresets');
        this.subscribeStates('media.control.*');
        this.subscribeStates('audio.control.*');
        this.subscribeStates('media.state');
        if (this.log.level == 'debug' || this.log.level == 'silly') {
            this.subscribeStates('debug.resetSession');
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback
     */
    onUnload(callback) {
        // Here you must clear all timeouts or intervals that may still be active
        polling = true; // disable onFSAPI processing
        this.cleanUp() //stop all timeouts
            // this.setState("info.connection", false, true)

            //		this.deleteSession()
            .then(() => {
                //
                callback();
            })
            .catch(() => {
                callback();
            });
    }

    async cleanUp() {
        clearTimeout(timeOutMessage);
        sleeps.forEach(value => {
            clearTimeout(value);
        });
        sleeps.clear();
    }

    /**
    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //
    */
    // onObjectChange(id, obj) {
    // 	if (obj) {
    // 		// The object was changed
    // 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    // 	} else {
    // 		// The object was deleted
    // 		this.log.info(`object ${id} deleted`);
    // 	}
    // }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (notifyTimestamp <= Date.now() - (this.config.PollIntervall * 1000 + 40000)) {
            clearTimeout(timeOutMessage);
            timeOutMessage = setTimeout(() => this.onFSAPIMessage(), this.config.PollIntervall * 1000); // Poll states every configured seconds
        }
        if (state) {
            if (!id || !state || state.ack) {
                return;
            }
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            //const setState = this.setState;
            const zustand = id.split('.');
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const adapter = this;

            //let response;
            switch (zustand[2]) {
                case 'device':
                    switch (zustand[3]) {
                        case 'power':
                            this.log.debug('Ein-/Ausschalten');
                            //const adapter = this;
                            await adapter
                                .callAPI('netRemote.sys.power', state.val ? '1' : '0')
                                .then(async function (response) {
                                    if (response.success) {
                                        await adapter.setState('device.power', { val: state.val, ack: true });
                                    }
                                });

                            if (state.val && this.config.SangeanNoSound) {
                                adapter.makeSangeanDABPlay();
                            }
                            break;
                        case 'friendlyName':
                            this.log.debug('Umbenennen');

                            if (state != null && state != undefined && state.val != null && state.val != undefined) {
                                const name = state.val.toString();
                                await adapter.callAPI('netRemote.sys.info.friendlyName', name).then(async response => {
                                    if (response.success) {
                                        await adapter.setState('device.friendlyName', {
                                            val: name.toString(),
                                            ack: true,
                                        });
                                    }
                                });
                            }
                            break;
                        case 'dayLightSavingTime':
                            this.log.debug('Daylight Saving Time');
                            await adapter
                                .callAPI('netRemote.sys.clock.dst', state.val ? '1' : '0')
                                .then(async function (response) {
                                    if (response.success) {
                                        await adapter.setState('device.dayLightSavingTime', {
                                            val: state.val,
                                            ack: true,
                                        });
                                    }
                                });
                            break;
                        default:
                            break;
                    }
                    break;
                case 'modes':
                    if (
                        (zustand.length == 5 && zustand[4] === 'switchTo') ||
                        (zustand.length == 7 && zustand[4] === 'presets' && zustand[6] === 'recall')
                    ) {
                        // frontier_silicon.0.modes.2.switchTo
                        this.log.debug('Modus umschalten');
                        await adapter.callAPI('netRemote.sys.mode', zustand[3]).then(async function (response) {
                            if (response.success) {
                                await adapter.setState('modes.selected', { val: Number(zustand[3]), ack: true });
                                await adapter.getStateAsync(`modes.${zustand[3]}.label`).then(async function (lab) {
                                    if (lab !== null && lab !== undefined && lab.val !== null) {
                                        await adapter.setState('modes.selectedLabel', { val: lab.val, ack: true });
                                    }
                                });
                                await adapter.sleep(3000); // wait for mode change to get current nav list
                                await adapter.updateNavList();

                                await adapter.setState(`modes.${zustand[3]}.switchTo`, { val: true, ack: true });
                                //adapter.setState("modes.selectPreset", {val:null, ack: true});
                            }
                        });
                    }
                    // frontier_silicon.1.modes.4.presets.2.recall
                    if (zustand.length == 7 && zustand[4] === 'presets' && zustand[6] === 'recall') {
                        await this.callAPI('netRemote.nav.state', '1');
                        // this.log.debug(`modes.${zustand[3]}.presets.${zustand[5]} activated`);
                        await adapter
                            .callAPI('netRemote.nav.action.selectPreset', zustand[5])
                            .then(async function (response) {
                                if (response.success) {
                                    await adapter.setState('modes.selectPreset', {
                                        val: Number(zustand[5]),
                                        ack: true,
                                    });
                                    await adapter.setState(`modes.${zustand[3]}.presets.${zustand[5]}.recall`, {
                                        val: true,
                                        ack: true,
                                    });
                                }
                            });
                        //adapter.getSelectedPreset();
                        // eslint-disable-next-line brace-style
                    }
                    // frontier_silicon.1.modes.selected
                    else if (zustand[3] === 'selected' && state.val !== null) {
                        this.log.debug('Modus umschalten');
                        await adapter.callAPI('netRemote.sys.mode', state.val.toString()).then(async response => {
                            if (response.success) {
                                await adapter.setState('modes.selected', { val: Number(state.val), ack: true });
                                await adapter.getStateAsync(`modes.${state.val}.label`).then(async function (lab) {
                                    if (lab !== null && lab !== undefined && lab.val !== null) {
                                        await adapter.setState('modes.selectedLabel', { val: lab.val, ack: true });
                                    }
                                });

                                /*
                                let deviceReady = false;
                                while (!deviceReady) {
                                    adapter.log.debug('Waiting for device to become ready...');
                                    await adapter.sleep(3000);

                                    await adapter.callAPI('netRemote.nav.status').then(async function (response) {
                                        if (response.success) {
                                            adapter.log.debug(`Nav Status: ${response.result.value[0].u8[0]}`);
                                            if (response.result.value[0].u8[0] == 1) {
                                                deviceReady = true;
                                            }
                                        }
                                    });
                                }

*/
                                await adapter.sleep(3000); // wait for mode change to get current nav list
                                await this.updateNavList();

                                await adapter.callAPI('netRemote.play.info.graphicUri').then(async function (response) {
                                    await adapter.setState('media.graphic', {
                                        val: response.result.value[0].c8_array[0].trim(),
                                        ack: true,
                                    });
                                });
                                //adapter.setState("modes.selectPreset", {val:null, ack: true});
                            }
                        });
                    } else if (zustand[3] === 'selectPreset' && state.val !== null) {
                        this.log.debug(`Selecting Preset ${state.val}`);
                        await this.callAPI('netRemote.nav.state', '1');
                        await adapter
                            .callAPI('netRemote.nav.action.selectPreset', state.val.toString())
                            .then(async function (response) {
                                if (response.success) {
                                    await adapter.setState('modes.selectPreset', { val: state.val, ack: true });
                                    await adapter
                                        .callAPI('netRemote.play.info.graphicUri')
                                        .then(async function (response) {
                                            await adapter.setState('media.graphic', {
                                                val: response.result.value[0].c8_array[0].trim(),
                                                ack: true,
                                            });
                                        });
                                }
                            });
                    } else if (zustand[3] === 'readPresets') {
                        await this.getAllPresets(true);
                        await adapter.setState(`modes.readPresets`, { val: true, ack: true });
                    } else if (zustand[3] === 'presetUp') {
                        let tmpnr;
                        let currMode;
                        let len;
                        await adapter.getStateAsync('modes.selected').then(async currentMode => {
                            if (currentMode !== null && currentMode !== undefined && currentMode.val !== null) {
                                currMode = currentMode.val.toString();
                                await adapter
                                    .getStateAsync(`modes.${currMode}.presets.available`)
                                    .then(async available => {
                                        if (
                                            available !== null &&
                                            available !== undefined &&
                                            available.val !== null &&
                                            available.val === true
                                        ) {
                                            await adapter
                                                .getStateAsync(`modes.${currMode}.presets.number`)
                                                .then(async numPres => {
                                                    if (
                                                        numPres !== null &&
                                                        numPres !== undefined &&
                                                        numPres.val !== null
                                                    ) {
                                                        len = numPres.val;
                                                    }
                                                });
                                            await adapter.getStateAsync('modes.selectPreset').then(async selPres => {
                                                if (selPres === null || selPres === undefined || selPres.val === null) {
                                                    tmpnr = 0;
                                                } else {
                                                    tmpnr = Number(selPres.val);
                                                    tmpnr++;
                                                    if (tmpnr == len) {
                                                        tmpnr = 0;
                                                    }
                                                }
                                            });
                                            let empty = true;
                                            while (empty) {
                                                await adapter
                                                    .getStateAsync(`modes.${currMode}.presets.${tmpnr.toString()}.name`)
                                                    .then(async name => {
                                                        // skip empty preset names
                                                        if (
                                                            name === null ||
                                                            name === undefined ||
                                                            name.val === null ||
                                                            name.val === undefined ||
                                                            name.val === ''
                                                        ) {
                                                            tmpnr++;
                                                            if (tmpnr == len) {
                                                                tmpnr = 0;
                                                            }
                                                        } else {
                                                            empty = false;
                                                        }
                                                    });
                                            }
                                        }
                                    });

                                this.log.debug(`Next Station: ${tmpnr}`);
                                adapter.setState('modes.selectPreset', { val: tmpnr, ack: false });
                                adapter.setState(`modes.presetUp`, { val: true, ack: true });
                            }
                        });
                    } else if (zustand[3] === 'presetDown') {
                        let tmpnr = 0;
                        let currMode;
                        let len;
                        await adapter.getStateAsync('modes.selected').then(async currentMode => {
                            if (currentMode !== null && currentMode !== undefined && currentMode.val !== null) {
                                currMode = currentMode.val.toString();
                                await adapter
                                    .getStateAsync(`modes.${currMode}.presets.available`)
                                    .then(async available => {
                                        if (
                                            available !== null &&
                                            available !== undefined &&
                                            available.val !== null &&
                                            available.val === true
                                        ) {
                                            await adapter
                                                .getStateAsync(`modes.${currMode}.presets.number`)
                                                .then(async numPres => {
                                                    if (
                                                        numPres !== null &&
                                                        numPres !== undefined &&
                                                        numPres.val !== null
                                                    ) {
                                                        len = numPres.val;
                                                    }
                                                });
                                            await adapter.getStateAsync('modes.selectPreset').then(async selPres => {
                                                if (selPres === null || selPres === undefined || selPres.val === null) {
                                                    tmpnr = 0;
                                                } else {
                                                    tmpnr = Number(selPres.val);
                                                    tmpnr--;
                                                    if (tmpnr < 0) {
                                                        tmpnr = len - 1;
                                                    }
                                                }
                                            });

                                            let empty = true;
                                            while (empty) {
                                                await adapter
                                                    .getStateAsync(`modes.${currMode}.presets.${tmpnr.toString()}.name`)
                                                    .then(async name => {
                                                        // skip empty preset names
                                                        if (
                                                            name === null ||
                                                            name === undefined ||
                                                            name.val === null ||
                                                            name.val === undefined ||
                                                            name.val === ''
                                                        ) {
                                                            tmpnr--;
                                                            if (tmpnr < 0) {
                                                                tmpnr = len - 1;
                                                            }
                                                        } else {
                                                            empty = false;
                                                        }
                                                    });
                                            }
                                        }
                                    });
                                this.log.debug(`Previous Station: ${tmpnr}`);
                                adapter.setState('modes.selectPreset', { val: tmpnr, ack: false });
                                adapter.setState(`modes.presetDown`, { val: true, ack: true });
                            }
                        });
                        // ...existing code...
                    } else if (zustand[3] === 'navigationUp') {
                        try {
                            let nextKey = 0;
                            let tmpnr = currentNavIndex;
                            this.log.debug(
                                `In navigationUp: Current Index: ${tmpnr} current key: ${currentNavList[tmpnr] ? currentNavList[tmpnr].$.key : 'n/a'} currentNavNumItemsMax: ${currentNavNumItemsMax} currentNavNumItems: ${currentNavNumItems}`,
                            );

                            tmpnr += 1;
                            if (currentNavNumItems >= 0) {
                                // normale Liste mit bekannter Länge
                                if (tmpnr >= currentNavList.length) {
                                    let ceilingItemsMax = Math.ceil(currentNavNumItemsMax / currentNavListChunk);
                                    let ceilingItems = Math.ceil(currentNavNumItems / currentNavListChunk);

                                    if (ceilingItemsMax < ceilingItems) {
                                        // Es gibt noch mehr Items zu laden
                                        const nextChunkStart = ceilingItemsMax * currentNavListChunk - 1;
                                        this.log.debug(
                                            `Loading more items for navigationUp from index ${nextChunkStart} ceilingItemsMax=${ceilingItemsMax} ceilingItems=${ceilingItems}`,
                                        );
                                        await this.updateNavList(nextChunkStart);
                                    } else if (ceilingItemsMax == ceilingItems && ceilingItems > 0) {
                                        // Letzter Chunk erreicht, zurück zum Anfang
                                        this.log.debug('Last chunk reached, reloading list from beginning');
                                        await this.updateNavList();
                                    }
                                    tmpnr = 0; // Bei neuem Chunk immer bei Index 0 starten
                                    nextKey = currentNavList[tmpnr].$.key;
                                } else {
                                    nextKey = currentNavList[tmpnr].$.key;
                                }
                            } else {
                                // infinite Liste: Chunk-Tracking korrekt nutzen und Wrap-Logik
                                if (tmpnr >= currentNavList.length) {
                                    // Wir sind am Ende des aktuellen Chunks
                                    this.log.debug(
                                        `Infinite list: end of current chunk reached (len=${currentNavList.length}, chunkSize=${currentNavListChunk}), currentChunkIndex=${currentNavChunkIndex}, knownChunks=${currentNavChunks.length}`,
                                    );

                                    if (currentNavChunkIndex < currentNavChunks.length - 1) {
                                        // Es gibt einen aufgezeichneten nächsten Chunk
                                        const nextChunkId = currentNavChunks[currentNavChunkIndex + 1];
                                        const startParam = nextChunkId === '-1' ? -1 : Number(nextChunkId);
                                        this.log.debug(
                                            `Infinite list: loading next recorded chunk, chunkIndex ${currentNavChunkIndex} -> ${currentNavChunkIndex + 1}`,
                                        );
                                        await this.updateNavList(startParam);
                                    } else {
                                        // Kein aufgezeichneter nächster Chunk - check ob aktueller Chunk vollständig ist
                                        if (currentNavList.length < currentNavListChunk) {
                                            // Aktueller Chunk ist der letzte Chunk (unvollständig) -> WRAP zur ersten Seite
                                            this.log.debug(
                                                `Infinite list: last chunk detected (${currentNavList.length} < ${currentNavListChunk}), wrapping to first chunk`,
                                            );
                                            await this.updateNavList(-1);
                                        } else {
                                            // Lade nächsten Chunk dynamisch anhand des letzten Keys
                                            const lastKey = currentNavList[currentNavList.length - 1].$.key;
                                            this.log.debug(
                                                `Infinite list: loading next chunk from last key ${lastKey}, currentChunks before=${JSON.stringify(currentNavChunks)}`,
                                            );
                                            await this.updateNavList(Number(lastKey));
                                            this.log.debug(
                                                `Infinite list: after updateNavList, currentChunks=${JSON.stringify(currentNavChunks)}, currentNavChunkIndex=${currentNavChunkIndex}`,
                                            );
                                        }
                                    }

                                    tmpnr = 0;
                                    nextKey = currentNavList[tmpnr] ? currentNavList[tmpnr].$.key : undefined;
                                } else {
                                    nextKey = currentNavList[tmpnr].$.key;
                                }
                            }

                            if (
                                nextKey !== undefined &&
                                nextKey !== null &&
                                tmpnr >= 0 &&
                                tmpnr < currentNavList.length
                            ) {
                                let name = '';

                                currentNavList[tmpnr].field.forEach(f => {
                                    switch (f.$.name) {
                                        case 'name':
                                            name = f.c8_array[0];
                                            break;
                                        case 'type':
                                            currentNavType = f.u8[0];
                                            break;
                                        case 'subtype':
                                            currentNavSubtype = f.u8[0];
                                            break;
                                        default:
                                            break;
                                    }
                                });

                                currentNavIndex = tmpnr;
                                this.log.debug(`Next Item: Index=${tmpnr}, Key=${nextKey}, Name=${name}`);
                                await adapter.setState('modes.currentNavIndex', { val: tmpnr, ack: true });
                                await adapter.setState('modes.currentNavKey', {
                                    val: Number(nextKey),
                                    ack: true,
                                });
                                await adapter.setState(`modes.currentNavName`, { val: name, ack: true });

                                const obj = await this.getObjectAsync('modes.currentNavKey');
                                if (obj && obj.native) {
                                    obj.native.currentNavIndex.value = Number(currentNavIndex);
                                    obj.native.currentNavType.value = Number(currentNavType);
                                    obj.native.currentNavSubtype.value = Number(currentNavSubtype);
                                    obj.native.currentNavNumItemsMax.value = Number(currentNavNumItemsMax);
                                    await this.setObject('modes.currentNavKey', obj);
                                }

                                await adapter.setState(`modes.navigationUp`, { val: true, ack: true });
                            } else {
                                this.log.error(
                                    `navigationUp: Invalid navigation state. nextKey=${nextKey}, tmpnr=${tmpnr}, currentNavList.length=${currentNavList.length}`,
                                );
                            }
                        } catch (err) {
                            this.log.debug(`Error in navigationUp: ${JSON.stringify(err)}`);
                        }
                    } else if (zustand[3] === 'navigationDown') {
                        try {
                            let nextKey = 0;
                            let tmpnr = currentNavIndex;
                            this.log.debug(
                                `In navigationDown: Current Index: ${tmpnr} current key: ${currentNavList[tmpnr].$.key} currentNavNumItemsMax: ${currentNavNumItemsMax} currentNavNumItems: ${currentNavNumItems}`,
                            );

                            tmpnr -= 1;

                            if (currentNavNumItems >= 0) {
                                // normale Liste mit bekannter Länge
                                if (tmpnr < 0) {
                                    let floorItemsMax = Math.floor(currentNavNumItemsMax / currentNavListChunk);
                                    let floorItems = Math.floor(currentNavNumItems / currentNavListChunk);
                                    let remainderItemsMax = currentNavNumItemsMax % currentNavListChunk;

                                    if (floorItemsMax > 1) {
                                        const prevChunkStart =
                                            remainderItemsMax > 0
                                                ? (floorItemsMax - 1) * currentNavListChunk - 1
                                                : (floorItemsMax - 2) * currentNavListChunk - 1;
                                        this.log.debug(
                                            `Loading previous items for navigationDown from index ${prevChunkStart} floorItemsMax=${floorItemsMax} remainderItemsMax=${remainderItemsMax}`,
                                        );
                                        await this.updateNavList(prevChunkStart);

                                        tmpnr = currentNavList.length - 1;
                                        nextKey = currentNavList[tmpnr].$.key;
                                    } else if (floorItemsMax == 1) {
                                        const endChunkStart = Math.max(0, floorItems * currentNavListChunk - 1);
                                        this.log.debug(
                                            `At beginning of first list, loading from end at index ${endChunkStart}`,
                                        );
                                        await this.updateNavList(endChunkStart);
                                        tmpnr = currentNavList.length - 1;
                                        nextKey = currentNavList[tmpnr].$.key;
                                    } else {
                                        this.log.debug('Single chunk list, jumping to last item');
                                        tmpnr = currentNavList.length - 1;
                                        if (tmpnr >= 0) {
                                            nextKey = Number(currentNavList[tmpnr].$.key);
                                        }
                                    }
                                } else {
                                    nextKey = currentNavList[tmpnr].$.key;
                                }
                            } else {
                                // numItems is -1, infinite list: nutze chunk-tracking
                                if (tmpnr < 0) {
                                    // Wir sind vor dem ersten Item des aktuellen Chunks
                                    if (currentNavChunkIndex > 0) {
                                        // Es gibt einen vorherigen Chunk
                                        const prevIndex = currentNavChunkIndex - 1;
                                        const prevChunkId = currentNavChunks[prevIndex];
                                        const startParam = prevChunkId === '-1' ? -1 : Number(prevChunkId);
                                        this.log.debug(
                                            `Infinite list: loading previous chunk (from chunkIndex ${currentNavChunkIndex} -> ${prevIndex})`,
                                        );
                                        await this.updateNavList(startParam);
                                        this.log.debug(
                                            `After loading previous chunk: chunkIndex=${currentNavChunkIndex}, currentNavNumItemsMax=${currentNavNumItemsMax}, currentNavChunks=${JSON.stringify(currentNavChunks)}`,
                                        );
                                        tmpnr = currentNavList.length - 1;
                                        nextKey = currentNavList[tmpnr].$.key;
                                    } else {
                                        // Wir sind am Anfang (Chunk 0), gehe zum LETZTEN Chunk durch Wrapping
                                        this.log.debug(
                                            'Infinite list: at beginning of first chunk, wrapping to last chunk',
                                        );
                                        if (currentNavChunks.length > 0) {
                                            const lastIdx = currentNavChunks.length - 1;
                                            const lastChunkId = currentNavChunks[lastIdx];
                                            const startParam = lastChunkId === '-1' ? -1 : Number(lastChunkId);
                                            this.log.debug(
                                                `Loading last chunk for wrap-around (chunkIndex ${lastIdx})`,
                                            );
                                            await this.updateNavList(startParam);
                                            this.log.debug(
                                                `After wrapping to last chunk: chunkIndex=${currentNavChunkIndex}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                                            );
                                            tmpnr = currentNavList.length - 1;
                                            nextKey = currentNavList[tmpnr].$.key;
                                        } else {
                                            // Keine Chunks vorhanden, lade Chunk 0
                                            this.log.debug('Infinite list: no chunks recorded, loading from start');
                                            await this.updateNavList(-1);
                                            this.log.debug(
                                                `After loading from start: chunkIndex=${currentNavChunkIndex}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                                            );
                                            tmpnr = currentNavList.length - 1;
                                            nextKey = currentNavList[tmpnr].$.key;
                                        }
                                    }
                                } else {
                                    nextKey = currentNavList[tmpnr].$.key;
                                }
                            }

                            if (
                                nextKey !== undefined &&
                                nextKey !== null &&
                                tmpnr >= 0 &&
                                tmpnr < currentNavList.length
                            ) {
                                let name = '';

                                currentNavList[tmpnr].field.forEach(f => {
                                    switch (f.$.name) {
                                        case 'name':
                                            name = f.c8_array[0];
                                            break;
                                        case 'type':
                                            currentNavType = f.u8[0];
                                            break;
                                        case 'subtype':
                                            currentNavSubtype = f.u8[0];
                                            break;
                                        default:
                                            break;
                                    }
                                });

                                this.log.debug(`Previous Item: Index=${tmpnr}, Key=${nextKey}, Name=${name}`);
                                await adapter.setState('modes.currentNavIndex', { val: tmpnr, ack: true });
                                await adapter.setState('modes.currentNavKey', {
                                    val: Number(nextKey),
                                    ack: true,
                                });
                                await adapter.setState(`modes.currentNavName`, { val: name, ack: true });
                                currentNavIndex = tmpnr;

                                const obj = await this.getObjectAsync('modes.currentNavKey');
                                if (obj && obj.native) {
                                    obj.native.currentNavIndex.value = Number(tmpnr);
                                    obj.native.currentNavType.value = Number(currentNavType);
                                    obj.native.currentNavSubtype.value = Number(currentNavSubtype);
                                    await this.setObject('modes.currentNavKey', obj);
                                }

                                await adapter.setState(`modes.navigationDown`, { val: true, ack: true });
                            } else {
                                this.log.error(
                                    `navigationDown: Invalid navigation state. nextKey=${nextKey}, tmpnr=${tmpnr}, currentNavList.length=${currentNavList.length}`,
                                );
                            }
                        } catch (err) {
                            this.log.debug(`Error in navigationDown: ${JSON.stringify(err)}`);
                        }
                        // ...existing code...
                    } else if (zustand[3] === 'navigationSelect') {
                        try {
                            let currKey;
                            const currentKey = await adapter.getStateAsync('modes.currentNavKey');
                            if (currentKey !== null && currentKey !== undefined && currentKey.val !== null) {
                                currKey = Number(currentKey.val);
                                /*
                                const obj = await this.getObjectAsync('modes.currentNavKey');
                                let type = '';
                                let subtype = '';
                                if (obj && obj.native) {
                                    type = obj.native.currentNavType.value.toString(); // Zugriff auf den Key in der native Sektion
                                    subtype = obj.native.currentNavSubtype.value.toString(); // Zugriff auf den Key in der native Sektion
                                    this.log.debug(`navType: ${type}, navSubtype: ${subtype}`);
                                } else {
                                    this.log.debug('Objekt oder native Sektion nicht gefunden');
                                }
                                    */

                                if (currentNavType == 0) {
                                    // directory
                                    let response = await this.callAPI(
                                        'netRemote.nav.action.navigate',
                                        currKey.toString(),
                                    );
                                    if (response.success) {
                                        await this.updateNavList();
                                        await adapter.setState(`modes.navigationSelect`, { val: true, ack: true });
                                    }
                                } else if (currentNavType == 1) {
                                    // Playable item
                                    const response = await this.callAPI(
                                        'netRemote.nav.action.selectItem',
                                        currKey.toString(),
                                    );
                                    if (response.success) {
                                        await adapter.setState(`modes.navigationSelect`, {
                                            val: true,
                                            ack: true,
                                        });
                                    }
                                } else if (currentNavType == 2) {
                                    // Search directory
                                    let searchTerm = '';
                                    const currentSearch = await adapter.getStateAsync('modes.navigationSearch');
                                    if (
                                        currentSearch !== null &&
                                        currentSearch !== undefined &&
                                        currentSearch.val !== null
                                    ) {
                                        searchTerm = currentSearch.val.toString();
                                        let response = await this.callAPI('netRemote.nav.searchTerm', searchTerm);
                                        if (response.success) {
                                            this.log.debug(`Sent Search Term: ${searchTerm}`);
                                        }
                                    }
                                    let response = await this.callAPI('netRemote.nav.searchTerm');
                                    if (response.success && response.result.value[0].c8_array[0].trim() == searchTerm) {
                                        this.log.debug(`SearchTerm verified`);
                                        response = await this.callAPI(
                                            'netRemote.nav.action.navigate',
                                            currKey.toString(),
                                        );
                                        if (response.success) {
                                            await this.updateNavList();
                                            await adapter.setState(`modes.navigationSelect`, { val: true, ack: true });
                                        }
                                    } else {
                                        this.log.debug(
                                            `SearchTerm error: ${response.result.value[0].c8_array[0].trim()} <> ${searchTerm}`,
                                        );
                                    }
                                }
                            }
                        } catch (err) {
                            this.log.debug(`Error in navigationSelect: ${JSON.stringify(err)}`);
                        }
                    } else if (zustand[3] === 'navigationBack') {
                        try {
                            //const obj = await this.getObjectAsync('modes.currentNavKey');
                            if (currentNavNumItems >= 0) {
                                // only go back if navigation is possible
                                let response = await this.callAPI('netRemote.nav.action.navigate', '0xFFFFFFFF');
                                if (response.success) {
                                    await this.updateNavList();
                                }
                            }
                            await adapter.setState(`modes.navigationBack`, { val: true, ack: true });
                        } catch (err) {
                            this.log.debug(`Error in navigationBack: ${JSON.stringify(err)}`);
                        }
                    } else if (zustand[3] === 'navigationSearch') {
                        try {
                            await adapter.setState(`modes.navigationSearch`, { ack: true });
                        } catch (err) {
                            this.log.debug(`Error in navigationBack: ${JSON.stringify(err)}`);
                        }
                    }

                    break;

                case 'audio':
                    if (zustand[3] === 'volume' && state.val !== null) {
                        await this.callAPI('netRemote.nav.state', '1');

                        if (typeof state.val === 'number' && state.val >= 0 && state.val <= this.config.VolumeMax) {
                            await adapter
                                .callAPI('netRemote.sys.audio.volume', state.val.toString())
                                .then(async function (response) {
                                    if (response.success) {
                                        await adapter.setState('audio.volume', { val: Number(state.val), ack: true });
                                    }
                                });
                        }
                    } else if (zustand[3] === 'mute' && state.val !== null) {
                        await this.callAPI('netRemote.nav.state', '1');
                        await adapter
                            .callAPI('netRemote.sys.audio.mute', state.val ? '1' : '0')
                            .then(async function (response) {
                                if (response.success) {
                                    await adapter.setState('audio.mute', { val: state.val, ack: true });
                                }
                            });
                    } else {
                        switch (zustand[4]) {
                            case 'volumeUp':
                                await this.callAPI('netRemote.nav.state', '1');
                                await adapter.getStateAsync('audio.volume').then(async function (response) {
                                    if (
                                        response != null &&
                                        response != undefined &&
                                        response.val != null &&
                                        response.val != undefined &&
                                        Number(response.val) < adapter.config.VolumeMax
                                    ) {
                                        const vol = parseInt(response.val.toString()) + 1;
                                        await adapter
                                            .callAPI('netRemote.sys.audio.volume', vol.toString())
                                            .then(async function (response) {
                                                if (response.success) {
                                                    await adapter.setState('audio.volume', {
                                                        val: Number(vol),
                                                        ack: true,
                                                    });
                                                    await adapter.setState(`audio.control.volumeUp`, {
                                                        val: true,
                                                        ack: true,
                                                    });
                                                }
                                            });
                                    }
                                });
                                break;
                            case 'volumeDown':
                                await this.callAPI('netRemote.nav.state', '1');
                                await adapter.getStateAsync('audio.volume').then(async function (response) {
                                    if (
                                        response != null &&
                                        response != undefined &&
                                        response.val != null &&
                                        response.val != undefined &&
                                        Number(response.val) > 0
                                    ) {
                                        const vol = parseInt(response.val.toString()) - 1;
                                        await adapter
                                            .callAPI('netRemote.sys.audio.volume', vol.toString())
                                            .then(async function (response) {
                                                if (response.success) {
                                                    await adapter.setState('audio.volume', {
                                                        val: Number(vol),
                                                        ack: true,
                                                    });
                                                    await adapter.setState(`audio.control.volumeDown`, {
                                                        val: true,
                                                        ack: true,
                                                    });
                                                }
                                            });
                                    }
                                });
                                break;
                            default:
                                break;
                        }
                    }
                    break;
                case 'media':
                    if (zustand[3] === 'control' && zustand[4] === 'stop') {
                        await this.callAPI('netRemote.nav.state', '1');
                        await this.callAPI('netRemote.play.control', '0').then(async function (response) {
                            if (response.success) {
                                await adapter.setState(`media.control.stop`, { val: true, ack: true });
                            }
                        });
                    } else if (zustand[3] === 'control' && zustand[4] === 'play') {
                        await this.callAPI('netRemote.nav.state', '1');
                        await this.callAPI('netRemote.play.control', '1').then(async function (response) {
                            if (response.success) {
                                await adapter.setState(`media.control.play`, { val: true, ack: true });
                            }
                        });
                    } else if (zustand[3] === 'control' && zustand[4] === 'pause') {
                        await this.callAPI('netRemote.nav.state', '1');
                        await this.callAPI('netRemote.play.control', '2').then(async function (response) {
                            if (response.success) {
                                await adapter.setState(`media.control.pause`, { val: true, ack: true });
                            }
                        });
                    } else if (zustand[3] === 'control' && zustand[4] === 'next') {
                        await this.callAPI('netRemote.nav.state', '1');
                        await this.callAPI('netRemote.play.control', '3').then(async function (response) {
                            if (response.success) {
                                await adapter.setState(`media.control.next`, { val: true, ack: true });
                            }
                        });
                    } else if (zustand[3] === 'control' && zustand[4] === 'previous') {
                        await this.callAPI('netRemote.nav.state', '1');
                        await this.callAPI('netRemote.play.control', '4').then(async function (response) {
                            if (response.success) {
                                await adapter.setState(`media.control.previous`, { val: true, ack: true });
                            }
                        });
                    }
                    break;
                case 'debug':
                    if (zustand[3] === 'resetSession') {
                        try {
                            await this.createSession();
                            await adapter.setState(`debug.resetSession`, { val: true, ack: true });
                        } catch (err) {
                            this.log.error(String(err));
                        }
                    }
                    break;
                default:
                    break;
            }
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    makeSangeanDABPlay() {
        this.sleep(100);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const adapter = this;
        this.callAPI('netRemote.sys.mode').then(function (response) {
            adapter.getStateAsync(`modes.${response.result.value[0].u32[0]}.id`).then(function (res) {
                if (res !== null && res !== undefined && res.val !== null && res.val === 'DAB') {
                    adapter.sleep(2000).then(function () {
                        adapter.getStateAsync('modes.mediaplayer').then(function (r) {
                            if (r !== null && r !== undefined && r.val !== null) {
                                adapter.callAPI('netRemote.sys.mode', r.val.toString());
                                adapter.sleep(2000).then(function () {
                                    adapter.callAPI('netRemote.sys.mode', response.result.value[0].u32[0]);
                                });
                            }
                        });
                    });
                }
            });
        });
    }

    async discoverDeviceFeatures() {
        await this.setObjectNotExistsAsync('device.radioId', {
            type: 'state',
            common: {
                name: 'Radio ID',
                type: 'string',
                role: 'info.hardware',
                read: true,
                write: false,
            },
            native: {},
        });
        let response = await this.callAPI('netRemote.sys.info.radioId');
        if (response.success) {
            await this.setState('device.radioId', { val: response.result.value[0].c8_array[0], ack: true });
        }

        //netRemote.sys.caps.volumeSteps
        await this.setObjectNotExistsAsync('audio.maxVolume', {
            type: 'state',
            common: {
                name: 'Max volume setting',
                type: 'number',
                role: 'level.volume.max',
                read: true,
                write: false,
            },
            native: {},
        });
        response = await this.callAPI('netRemote.sys.caps.volumeSteps');
        if (response.success) {
            await this.setState('audio.maxVolume', { val: response.result.value[0].u8[0] - 1, ack: true });
            this.config.VolumeMax = response.result.value[0].u8[0] - 1;
        }

        response = await this.callAPI('netRemote.sys.caps.validModes', '', -1, 100);

        if (!response.success) {
            return;
        }

        let key = response.result.item[0].$.key;
        let selectable = false;
        let label = '';
        let streamable = false;
        let id = '';
        const proms = [];
        const promo = [];
        const modeKeys = [];
        const modeLabels = [];

        response.result.item.forEach(item => {
            key = item.$.key;
            modeKeys.push(key);
            id = '';
            selectable = false;
            label = '';
            streamable = false;
            item.field.forEach(f => {
                switch (f.$.name) {
                    case 'id':
                        id = f.c8_array[0];
                        break;
                    case 'selectable':
                        selectable = f.u8[0] == 1;
                        break;
                    case 'label':
                        label = f.c8_array[0];
                        modeLabels.push(label);
                        break;
                    case 'streamable':
                        streamable = f.u8[0] == 1;
                        break;
                    default:
                        break;
                }
            });

            this.log.debug(`ModeMaxIndex: ${this.config.ModeMaxIndex} - Key: ${key}`);
            if (this.config.ModeMaxIndex === undefined || this.config.ModeMaxIndex < key) {
                this.config.ModeMaxIndex = key;
            }
            let pro;
            if (id === 'MP' && this.config.SangeanNoSound) {
                pro = this.setObjectNotExistsAsync(`modes.mediaplayer`, {
                    type: 'state',
                    common: {
                        name: 'Media Player Mode Key',
                        type: 'number',
                        role: 'media.input',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                promo.push(pro);
            }

            pro = this.setObjectNotExistsAsync(`modes.${key}`, {
                type: 'channel',
                common: {
                    name: label,
                },
                native: {},
            });
            promo.push(pro);

            pro = this.setObjectNotExistsAsync(`modes.${key}.key`, {
                type: 'state',
                common: {
                    name: 'Mode key',
                    type: 'number',
                    role: 'media.input',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);

            pro = this.setObjectNotExistsAsync(`modes.${key}.id`, {
                type: 'state',
                common: {
                    name: 'Mode ID',
                    type: 'string',
                    role: 'media.input.id',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);

            pro = this.setObjectNotExistsAsync(`modes.${key}.label`, {
                type: 'state',
                common: {
                    name: 'Mode label',
                    type: 'string',
                    role: 'media.input.label',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);

            pro = this.setObjectNotExistsAsync(`modes.${key}.streamable`, {
                type: 'state',
                common: {
                    name: 'Mode streamable',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);

            pro = this.setObjectNotExistsAsync(`modes.${key}.selectable`, {
                type: 'state',
                common: {
                    name: 'Mode selectable',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);

            if (selectable) {
                pro = this.setObjectNotExistsAsync(`modes.${key}.switchTo`, {
                    type: 'state',
                    common: {
                        name: 'Switch to mode',
                        type: 'boolean',
                        role: 'button',
                        def: false,
                        read: false,
                        write: true,
                    },
                    native: {},
                });
                promo.push(pro);

                pro = this.setObjectNotExistsAsync(`modes.readPresets`, {
                    type: 'state',
                    common: {
                        name: 'Read presets',
                        type: 'boolean',
                        role: 'button',
                        def: false,
                        read: false,
                        write: true,
                    },
                    native: {},
                });
                promo.push(pro);
            }
            this.log.debug(`ID: ${id} - Selectable: ${selectable} - Label: ${label} - Key: ${key}`);
        });

        // Loop to insert key & value in modes object
        for (let i = 0; i < modeKeys.length; i++) {
            allModes[modeKeys[i]] = modeLabels[i];
        }
        //this.log.debug(`Discovered modes: ${JSON.stringify(allModes)}`);

        await Promise.all(promo);
        response.result.item.forEach(item => {
            key = item.$.key;
            id = '';
            selectable = false;
            label = '';
            streamable = false;
            item.field.forEach(f => {
                switch (f.$.name) {
                    case 'id':
                        id = f.c8_array[0];
                        break;
                    case 'selectable':
                        selectable = f.u8[0] == 1;
                        break;
                    case 'label':
                        label = f.c8_array[0];
                        break;
                    case 'streamable':
                        streamable = f.u8[0] == 1;
                        break;
                    default:
                        break;
                }
            });
            let prom;
            if (id === 'MP' && this.config.SangeanNoSound) {
                prom = this.setState('modes.mediaplayer', { val: key, ack: true });
                proms.push(prom);
            }
            prom = this.setState(`modes.${key}.key`, { val: Number(key), ack: true });
            proms.push(prom);
            prom = this.setState(`modes.${key}.id`, { val: id, ack: true });
            proms.push(prom);
            prom = this.setState(`modes.${key}.label`, { val: label, ack: true });
            proms.push(prom);
            prom = this.setState(`modes.${key}.streamable`, { val: streamable, ack: true });
            proms.push(prom);
            prom = this.setState(`modes.${key}.selectable`, { val: selectable, ack: true });
            proms.push(prom);
        });
        await Promise.all(proms);
    }

    /**
     * Update navigation list after mode switch or after selecting a directory
     */

    async updateNavList(startItem) {
        try {
            this.log.debug(`updateNavList called with startItem=${startItem}`);
            this.log.debug('Updating navigation list');
            await this.enableNavIfNeccessary();
            await this.sleep(1000);

            let response = await this.callAPI('netRemote.nav.numitems');
            if (response.success) {
                currentNavNumItems = response.result.value[0].s32[0];
                this.log.debug(`Number of items in current mode: ${currentNavNumItems}`);
            }

            // Parameterauswertung:
            // - startItem === undefined  => vollständiger Reset (z.B. Mode-Wechsel), lade Chunk 0
            // - startItem === -1         => explizit Chunk 0 laden OHNE Reset der Chunk-Tracking-Liste
            // - startItem >= 0           => lade ab diesem Schlüssel (Chunk-StartKey)
            let startIndex = -1;
            const explicitLoadZero = startItem === -1;
            const fullReset = startItem === undefined;

            if (fullReset) {
                startIndex = -1; // Lade Chunk 0 für vollständigen Reset
                currentNavChunks = [];
                currentNavChunkIndex = 0;
                this.log.debug('updateNavList: full reset of chunk tracking (loading chunk 0)');
            } else if (explicitLoadZero) {
                startIndex = -1; // load first page but keep currentNavChunks
                this.log.debug('updateNavList: explicit load of chunk 0 (no reset)');
            } else if (startItem !== undefined && startItem !== null && startItem >= 0) {
                startIndex = startItem;
                this.log.debug(`updateNavList: explicit startIndex=${startIndex}`);
            } else {
                // fallback: treat as full reset
                startIndex = -1;
                currentNavChunks = [];
                currentNavChunkIndex = 0;
                this.log.debug('updateNavList: fallback full reset');
            }

            this.log.debug(
                `updateNavList: Loading from startIndex=${startIndex} (explicitLoadZero=${explicitLoadZero}, fullReset=${fullReset})`,
            );
            response = await this.callAPI('netRemote.nav.list', '', startIndex, currentNavListChunk);
            if (!response.success) {
                this.log.debug('updateNavList: nav.list call failed');
                return;
            }

            currentNavList = response.result.item || [];
            this.log.debug(`Current List length: ${currentNavList.length}`);

            // Build states mapping
            const currentNavItems = {};
            currentNavList.forEach((item, i) => {
                const nameField = item.field.find(f => f.$.name === 'name');
                currentNavItems[i] = nameField ? nameField.c8_array[0].trim() : '';
            });

            // Reset index into the chunk
            currentNavIndex = 0;

            if (currentNavNumItems < 0) {
                // Bestimme Chunk-Identifikator
                // - Chunk 0 wird IMMER mit "-1" identifiziert
                // - Andere Chunks mit ihrem ERSTEN Key (als String)

                let chunkIdentifier;
                let isChunkZero = false;

                if (startIndex === -1) {
                    chunkIdentifier = '-1';
                    isChunkZero = true;
                } else if (startIndex >= 0) {
                    chunkIdentifier = String(startIndex);
                    isChunkZero = false;
                } else if (currentNavList.length > 0) {
                    chunkIdentifier = currentNavList[0].$.key.toString();
                    isChunkZero = false;
                } else {
                    chunkIdentifier = '-1';
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    isChunkZero = true;
                }

                if (fullReset || currentNavChunks.length === 0) {
                    currentNavChunks = [chunkIdentifier];
                    currentNavChunkIndex = 0;
                    this.log.debug(`Infinite: initialized with chunk 0, identifier=${chunkIdentifier}`);
                } else if (explicitLoadZero) {
                    // Chunk 0 muss immer auf Position 0 sein und mit "-1" identifiziert
                    let foundIdx = currentNavChunks.findIndex(k => k === '-1' || k === chunkIdentifier);
                    if (foundIdx === -1) {
                        currentNavChunks.unshift('-1');
                        currentNavChunkIndex = 0;
                        this.log.debug(`Infinite: inserted chunk 0 with identifier "-1"`);
                    } else if (foundIdx !== 0) {
                        currentNavChunks.splice(foundIdx, 1);
                        currentNavChunks.unshift('-1');
                        currentNavChunkIndex = 0;
                        this.log.debug(`Infinite: moved chunk 0 to position 0`);
                    } else {
                        currentNavChunkIndex = 0;
                        this.log.debug(`Infinite: chunk 0 already at position 0`);
                    }
                } else {
                    // Neuer Chunk wird hinzugefügt (nicht Chunk 0)
                    // WICHTIG: Chunks werden in Ladreihenfolge gespeichert, NICHT sortiert!
                    let idx = currentNavChunks.findIndex(k => k === chunkIdentifier);
                    if (idx === -1) {
                        // Neuer Chunk: einfach am Ende anhängen (Ladreihenfolge beibehalten)
                        currentNavChunks.push(chunkIdentifier);
                        idx = currentNavChunks.length - 1;
                        this.log.debug(
                            `Infinite: appended new chunk with identifier ${chunkIdentifier} at pos ${idx}, chunks now: ${JSON.stringify(currentNavChunks)}`,
                        );
                    } else {
                        this.log.debug(
                            `Infinite: found existing chunk with identifier ${chunkIdentifier} at pos ${idx}`,
                        );
                    }
                    currentNavChunkIndex = idx;
                    this.log.debug(`Infinite: set currentNavChunkIndex to ${idx} for identifier ${chunkIdentifier}`);
                }

                // currentNavNumItemsMax berechnen
                if (currentNavList.length < currentNavListChunk) {
                    // Aktueller Chunk ist unvollständig (letzter Chunk)
                    currentNavNumItemsMax = currentNavChunkIndex * currentNavListChunk + currentNavList.length;
                    this.log.debug(
                        `Infinite: last incomplete chunk - chunkIndex=${currentNavChunkIndex}, itemsInThisChunk=${currentNavList.length}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                    );
                } else {
                    // Aktueller Chunk ist vollständig
                    // WICHTIG: currentNavNumItemsMax = Items bis zum AKTUELLEN Chunk + aktuelle Chunk-Items
                    // NOT = Gesamtanzahl aller bekannten Chunks
                    currentNavNumItemsMax = (currentNavChunkIndex + 1) * currentNavListChunk;
                    this.log.debug(
                        `Infinite: complete chunk - chunkIndex=${currentNavChunkIndex}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                    );
                }
                this.log.debug(
                    `Infinite list: chunkIndex=${currentNavChunkIndex}, chunks=${JSON.stringify(currentNavChunks)}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                );
            } else {
                // ...existing code...
                // --- Finite list handling ---
                if (startIndex >= 0) {
                    // startIndex wurde als "letzter geladener Index" übergeben => +1 vor Chunk-Berechnung
                    const chunkIndex = Math.max(0, Math.floor((startIndex + 1) / currentNavListChunk));
                    currentNavNumItemsMax = Math.min((chunkIndex + 1) * currentNavListChunk, currentNavNumItems);
                } else {
                    // Initial load -> nur erster Chunk sichtbar
                    currentNavNumItemsMax = Math.min(currentNavListChunk, currentNavNumItems);
                }
                this.log.debug(
                    `Finite list: startIndex=${startIndex}, currentNavNumItems=${currentNavNumItems}, currentNavNumItemsMax=${currentNavNumItemsMax}`,
                );
            }

            // extract first item meta
            if (currentNavList.length > 0) {
                const key = currentNavList[currentNavIndex].$.key;
                let name = '';
                currentNavList[currentNavIndex].field.forEach(f => {
                    switch (f.$.name) {
                        case 'name':
                            name = f.c8_array[0];
                            break;
                        case 'type':
                            currentNavType = f.u8[0];
                            break;
                        case 'subtype':
                            currentNavSubtype = f.u8[0];
                            break;
                        default:
                            break;
                    }
                });

                this.log.debug(
                    `updateNavList: Loaded from startIndex=${startIndex}, currentNavNumItemsMax=${currentNavNumItemsMax}, firstKey=${key}`,
                );

                await this.setState('modes.currentNavIndex', { val: Number(currentNavIndex), ack: true });
                await this.setState('modes.currentNavKey', { val: Number(key), ack: true });
                await this.setState('modes.currentNavName', { val: name, ack: true });

                // Aktualisiere das Objekt mit den neuen Werten
                const obj = await this.getObjectAsync('modes.currentNavKey');
                if (obj && obj.native) {
                    obj.native.currentNavNumItems.value = Number(currentNavNumItems);
                    obj.native.currentNavNumItemsMax.value = Number(currentNavNumItemsMax);
                    obj.native.currentNavIndex.value = Number(currentNavIndex);
                    obj.common.states = currentNavItems;
                    obj.native.currentNavType.value = Number(currentNavType);
                    obj.native.currentNavSubtype.value = Number(currentNavSubtype);
                    await this.setObject('modes.currentNavKey', obj);
                }
            } else {
                this.log.debug('updateNavList: currentNavList empty after nav.list call');
            }
        } catch (err) {
            this.log.debug(`Error in updateNavList: ${JSON.stringify(err)}`);
        }
    }

    /**
     * Enable navigation if it is disabled
     */

    async enableNavIfNeccessary() {
        try {
            const response = await this.callAPI('netRemote.nav.state');
            if (response.success) {
                this.log.debug(
                    `Navigation state: ${JSON.stringify(response)} result: ${response.result.value[0].u8[0]}`,
                );
                if (response.result.value[0].u8[0] == 0) {
                    // Navigation is disabled, enable it
                    await this.callAPI('netRemote.nav.state', '1');
                }
            }
        } catch (err) {
            this.log.debug(`Error in enableNavIfNeccessary: ${JSON.stringify(err)}`);
        }
    }

    /**
     * Reads presets for all modes
     *
     * @param {boolean} force Force rescan of all presets
     */
    async getAllPresets(force) {
        this.log.debug('Getting presets');
        let response = await this.callAPI('netRemote.nav.state', '1');
        if (!response.success) {
            return;
        }
        response = await this.callAPI('netRemote.sys.mode');
        const mode = response.result.value[0].u32[0]; // save original mode
        let unmute = false;

        response = await this.callAPI('netRemote.sys.audio.mute');
        unmute = response.result.value[0].u8[0] == 0;
        this.log.debug(`Mute: ${JSON.stringify(response)} - Unmute: ${unmute.toString()}`);

        for (let i = 0; i <= this.config.ModeMaxIndex; ++i) {
            this.log.debug('Getting Modes');
            let mode = await this.getStateAsync(`modes.${i}.key`);
            if (mode === null) {
                continue;
            }
            this.log.debug(`Mode ${i}`);

            if (!force) {
                mode = await this.getStateAsync(`modes.${i}.presets.available`);
                //this.log.debug(JSON.stringify(mode));
                if (mode !== null) {
                    continue;
                }
            }
            await this.getModePresets(i, unmute);
        }
        await this.callAPI('netRemote.sys.mode', mode); // restore original mode
        if (unmute) {
            await this.callAPI('netRemote.sys.audio.mute', '0');
        }
    }

    async getModePresets(mode, unmute = false) {
        this.log.debug(`Presets of mode ${mode}`);

        let response = await this.callAPI('netRemote.sys.mode', mode.toString());
        await this.sleep(1000);
        response = await this.callAPI('netRemote.nav.state', '1');
        response = await this.callAPI('netRemote.nav.presets', '', -1, 65535);

        let key = 0;
        let name = '';
        //presets.clear();

        await this.setObjectNotExistsAsync(`modes.${mode}.presets`, {
            type: 'channel',
            common: {
                name: 'Presets',
            },
            native: {},
        });

        //const available = await this.getStateAsync(`modes.${mode}.presets.available`);
        await this.setObjectNotExistsAsync(`modes.${mode}.presets.available`, {
            type: 'state',
            common: {
                name: 'Presets available',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`modes.${mode}.presets.number`, {
            type: 'state',
            common: {
                name: 'Number of Presets available',
                type: 'number',
                role: 'value.max',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setState(`modes.${mode}.presets.available`, { val: response.success, ack: true });
        //this.log.debug(response.success.toString() + " - " + response.result.status[0].toString());
        if (!response.success) {
            return;
        }

        await this.setState(`modes.${mode}.presets.number`, { val: response.result.item.length, ack: true });
        this.log.debug(`${response.result.item.length} presets found`);
        if (!response.success) {
            return;
        }

        if (unmute) {
            await this.callAPI('netRemote.sys.audio.mute', '1');
        }
        const proms = [];
        const promo = [];
        response.result.item.forEach(item => {
            //this.setState(`modes.${mode}.presets.available`, { val: true, ack: true });
            key = item.$.key;
            let pro = this.setObjectNotExistsAsync(`modes.${mode}.presets.${key}`, {
                type: 'channel',
                common: {
                    name: `Preset ${key}`,
                },
                native: {},
            });
            promo.push(pro);
            pro = this.setObjectNotExistsAsync(`modes.${mode}.presets.${key}.name`, {
                type: 'state',
                common: {
                    name: 'Preset name',
                    type: 'string',
                    role: 'media.name',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);
            pro = this.setObjectNotExistsAsync(`modes.${mode}.presets.${key}.key`, {
                type: 'state',
                common: {
                    name: 'Preset key',
                    type: 'number',
                    role: 'media.playid',
                    read: true,
                    write: false,
                },
                native: {},
            });
            promo.push(pro);
            pro = this.setObjectNotExistsAsync(`modes.${mode}.presets.${key}.recall`, {
                type: 'state',
                common: {
                    name: 'Recall preset',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });
            promo.push(pro);
            //presets.set(name.toString().trim(), key);
        });
        // Wait for all object creation processes
        await Promise.all(promo);
        response.result.item.forEach(item => {
            //this.setState(`modes.${mode}.presets.available`, { val: true, ack: true });
            key = item.$.key;
            item.field.forEach(f => {
                //this.log.debug("Preset key: " + key.toString() + " Item: " + JSON.stringify(item) + " f: " + JSON.stringify(f));
                switch (f.$.name) {
                    case 'name':
                        name = f.c8_array[0];
                        break;
                    default:
                        break;
                }
            });
            this.log.debug(`Preset of Mode: ${mode} with key: ${key} set to ${name.toString().trim()}`);

            let prom = this.setState(`modes.${mode}.presets.${key}.name`, { val: name.toString().trim(), ack: true });
            proms.push(prom);
            prom = this.setState(`modes.${mode}.presets.${key}.key`, { val: Number(key), ack: true });
            proms.push(prom);
        });
        await Promise.all(proms);
    }

    /**
     * Get state of the device
     */
    async discoverState() {
        try {
            //const log = this.log;
            await this.setObjectNotExistsAsync('device.power', {
                type: 'state',
                common: {
                    name: 'Power',
                    type: 'boolean',
                    role: 'switch.power',
                    read: true,
                    write: true,
                },
                native: {},
            });
            let response = await this.callAPI('netRemote.sys.result');
            //this.log.debug(JSON.stringify(response));
            if (response.success) {
                this.log.debug(`Power: ${response.result.value[0].u8[0] == 1}`);
                await this.setState('device.power', { val: response.result.value[0].u8[0] == 1, ack: true });
            }

            // dailight saving time
            await this.setObjectNotExistsAsync('device.dayLightSavingTime', {
                type: 'state',
                common: {
                    name: 'Daylight Saving Time',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: true,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.sys.clock.dst');
            if (response.success) {
                this.log.debug(`Daylight Saving Time: ${response.result.value[0].u8[0] == 1}`);
                await this.setState('device.dayLightSavingTime', {
                    val: response.result.value[0].u8[0] == 1,
                    ack: true,
                });
            }

            await this.setObjectNotExistsAsync('modes.selected', {
                type: 'state',
                common: {
                    name: 'Selected mode',
                    type: 'number',
                    role: 'media.input',
                    read: true,
                    write: true,
                    states: JSON.parse(JSON.stringify(allModes)),
                },
                native: {},
            });
            response = await this.callAPI('netRemote.sys.mode');
            let modeSelected = null;
            if (response.success) {
                modeSelected = response.result.value[0].u32[0];
                this.log.debug(`Mode1: ${modeSelected}`);
                await this.setState('modes.selected', { val: Number(modeSelected), ack: true });
            }

            await this.setObjectNotExistsAsync('modes.selectedLabel', {
                type: 'state',
                common: {
                    name: 'Selected mode label',
                    type: 'string',
                    role: 'media.input.label',
                    read: true,
                    write: false,
                },
                native: {},
            });
            const modeLabel = await this.getStateAsync(`modes.${modeSelected}.label`);
            this.log.debug(`modeLabel: ${JSON.stringify(modeLabel)}`);
            if (response.success && modeLabel && modeLabel !== null) {
                this.log.debug(`ModeLabel: ${modeLabel.val}`);
                await this.setState('modes.selectedLabel', { val: modeLabel.val, ack: true });
            }
            await this.setObjectNotExistsAsync('modes.selectPreset', {
                type: 'state',
                common: {
                    name: 'Select preset',
                    type: 'number',
                    role: 'media.track',
                    read: true,
                    write: true,
                },
                native: {},
            });
            //this.getSelectedPreset();
            await this.setObjectNotExistsAsync(`modes.presetDown`, {
                type: 'state',
                common: {
                    name: 'Presets down',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`modes.presetUp`, {
                type: 'state',
                common: {
                    name: 'Presets up',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`modes.navigationDown`, {
                type: 'state',
                common: {
                    name: 'Navigation down',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`modes.navigationUp`, {
                type: 'state',
                common: {
                    name: 'Navigation up',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`modes.navigationSelect`, {
                type: 'state',
                common: {
                    name: 'Navigation select',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`modes.navigationBack`, {
                type: 'state',
                common: {
                    name: 'Navigation back',
                    type: 'boolean',
                    role: 'button',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            this.setObjectNotExistsAsync(`modes.navigationSearch`, {
                type: 'state',
                common: {
                    name: 'Navigation search term',
                    type: 'string',
                    role: 'media.navigation.search',
                    read: true,
                    write: true,
                },
                native: {},
            });

            this.setObjectNotExistsAsync(`modes.currentNavIndex`, {
                type: 'state',
                common: {
                    name: 'Navigation index',
                    type: 'number',
                    role: 'media.navigationindex',
                    read: true,
                    write: false,
                    states: {},
                },
                native: {},
            });

            this.setObjectNotExistsAsync(`modes.currentNavKey`, {
                type: 'state',
                common: {
                    name: 'Navigation key',
                    type: 'number',
                    role: 'media.navigationkey',
                    read: true,
                    write: false,
                },
                native: {
                    currentNavNumItems: {
                        value: 'number',
                    },
                    currentNavNumItemsMax: {
                        value: 'number',
                    },
                    currentNavIndex: {
                        value: 'number',
                    },
                    currentNavType: {
                        value: 'number',
                        states: {
                            0: 'Directory',
                            1: 'PlayableItem',
                            2: 'SearchDirectory',
                            3: 'Unknown',
                            4: 'FormItem',
                            5: 'MessageItem',
                            6: 'AmazonLogin',
                        },
                    },
                    currentNavSubtype: {
                        value: 'number',
                        states: {
                            0: 'None',
                            1: 'Station',
                            2: 'Podcast',
                            3: 'Track',
                            4: 'Text',
                            5: 'Password',
                            6: 'Options',
                            7: 'Submit',
                            8: 'Button',
                            9: 'Disabled',
                        },
                    },
                },
            });

            this.setObjectNotExistsAsync(`modes.currentNavName`, {
                type: 'state',
                common: {
                    name: 'Navigation name',
                    type: 'string',
                    role: 'media.navigation.name',
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.name', {
                type: 'state',
                common: {
                    name: 'Media name',
                    type: 'string',
                    role: 'media.name',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.name');
            if (response.success) {
                this.setState('media.name', { val: response.result.value[0].c8_array[0].trim(), ack: true });
                await this.UpdatePreset(response.result.value[0].c8_array[0].trim());
                await this.UpdateNavigation(response.result.value[0].c8_array[0].trim());
            }

            await this.setObjectNotExistsAsync('media.album', {
                type: 'state',
                common: {
                    name: 'Media album',
                    type: 'string',
                    role: 'media.album',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.album');
            if (response.success) {
                await this.setState('media.album', { val: response.result.value[0].c8_array[0].trim(), ack: true });
            }

            await this.setObjectNotExistsAsync('media.title', {
                type: 'state',
                common: {
                    name: 'Media title',
                    type: 'string',
                    role: 'media.title',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.title');
            if (response.success) {
                await this.setState('media.title', { val: response.result.value[0].c8_array[0].trim(), ack: true });
            }

            await this.setObjectNotExistsAsync('media.artist', {
                type: 'state',
                common: {
                    name: 'Media artist',
                    type: 'string',
                    role: 'media.artist',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.artist');
            if (response.success) {
                await this.setState('media.artist', { val: response.result.value[0].c8_array[0].trim(), ack: true });
            }

            await this.setObjectNotExistsAsync('media.text', {
                type: 'state',
                common: {
                    name: 'Media text',
                    type: 'string',
                    role: 'media.text',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.text');
            if (response.success) {
                await this.setState('media.text', { val: response.result.value[0].c8_array[0].trim(), ack: true });
            }

            await this.setObjectNotExistsAsync('media.graphic', {
                type: 'state',
                common: {
                    name: 'Media graphic',
                    type: 'string',
                    role: 'media.cover',
                    read: true,
                    write: false,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.info.graphicUri');
            if (response.success) {
                await this.setState('media.graphic', { val: response.result.value[0].c8_array[0].trim(), ack: true });
            }

            //netRemote.sys.audio.volume
            response = await this.callAPI('netRemote.sys.audio.volume');
            await this.setObjectNotExistsAsync('audio.volume', {
                type: 'state',
                common: {
                    name: 'Volume',
                    type: 'number',
                    role: 'level.volume',
                    read: true,
                    write: true,
                },
                native: {},
            });
            if (response.success && response.value !== null) {
                await this.setState('audio.volume', { val: Number(response.result.value[0].u8[0]), ack: true });
            }

            //netRemote.sys.audio.mute
            response = await this.callAPI('netRemote.sys.audio.mute');
            await this.setObjectNotExistsAsync('audio.mute', {
                type: 'state',
                common: {
                    name: 'Mute',
                    type: 'boolean',
                    role: 'media.mute',
                    read: true,
                    write: true,
                },
                native: {},
            });
            if (response.success && response.value !== null) {
                await this.setState('audio.mute', { val: response.result.value[0].u8[0] == 1, ack: true });
            }

            await this.setObjectNotExistsAsync('audio.control', {
                type: 'channel',
                common: {
                    name: 'Media control',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('audio.control.volumeUp', {
                type: 'state',
                common: {
                    name: 'Volume up',
                    type: 'boolean',
                    role: 'button.volume.up',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('audio.control.volumeDown', {
                type: 'state',
                common: {
                    name: 'Volume down',
                    type: 'boolean',
                    role: 'button.volume.down',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control', {
                type: 'channel',
                common: {
                    name: 'Media control',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control.stop', {
                type: 'state',
                common: {
                    name: 'Stop',
                    type: 'boolean',
                    role: 'button.stop',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control.play', {
                type: 'state',
                common: {
                    name: 'Play',
                    type: 'boolean',
                    role: 'button.play',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control.pause', {
                type: 'state',
                common: {
                    name: 'Pause',
                    type: 'boolean',
                    role: 'button.pause',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control.previous', {
                type: 'state',
                common: {
                    name: 'Previous',
                    type: 'boolean',
                    role: 'button.prev',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('media.control.next', {
                type: 'state',
                common: {
                    name: 'Next',
                    type: 'boolean',
                    role: 'button.forward',
                    def: false,
                    read: false,
                    write: true,
                },
                native: {},
            });
            response = await this.callAPI('netRemote.play.status');
            await this.setObjectNotExistsAsync('media.state', {
                type: 'state',
                common: {
                    name: 'Media state',
                    type: 'string',
                    role: 'media.state',
                    read: true,
                    write: false,
                },
                native: {},
            });
            if (response.success && response.value !== null) {
                switch (response.result.value[0].u8[0]) {
                    // IDLE
                    case '0':
                        await this.setState('media.state', { val: 'IDLE', ack: true });
                        break;
                    // BUFFERING
                    case '1':
                        await this.setState('media.state', { val: 'BUFFERING', ack: true });
                        break;
                    // PLAYING
                    case '2':
                        await this.setState('media.state', { val: 'PLAYING', ack: true });
                        break;
                    // PAUSED
                    case '3':
                        await this.setState('media.state', { val: 'PAUSED', ack: true });
                        break;
                    // REBUFFERING
                    case '4':
                        await this.setState('media.state', { val: 'REBUFFERING', ack: true });
                        break;
                    // ERROR
                    case '5':
                        await this.setState('media.state', { val: 'ERROR', ack: true });
                        break;
                    // STOPPED
                    case '6':
                        await this.setState('media.state', { val: 'STOPPED', ack: true });
                        break;
                    // ERROR_POPUP
                    case '7':
                        await this.setState('media.state', { val: 'ERROR_POPUP', ack: true });
                        break;

                    default:
                        break;
                }
            }
        } catch (err) {
            if (err instanceof Error) {
                this.log.error(`Error in discoverState(): ${err.message}${err.stack}`);
            } else {
                this.log.error(`Error in discoverState(): ${String(err)}`);
            }
        }
    }

    /**
	Get basic device info and FSAPI URL
     */
    async getDeviceInfo() {
        const log = this.log;
        const dev = {};
        try {
            await axios.get(`http://${this.config.IP}/device`).then(async device => {
                //log.debug(device.)
                const parser = new xml2js.Parser();
                parser.parseStringPromise(device.data).then(function (result) {
                    log.debug(result.netRemote.friendlyName);
                    dev.friendlyName = result.netRemote.friendlyName;
                    dev.version = result.netRemote.version;
                    dev.webfsapi = result.netRemote.webfsapi;
                });
            });

            await this.setObjectNotExistsAsync('device.friendlyName', {
                type: 'state',
                common: {
                    name: 'Friendly name',
                    type: 'string',
                    role: 'info.name',
                    read: true,
                    write: true,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('device.webfsapi', {
                type: 'state',
                common: {
                    name: 'Web FSAPI URL',
                    type: 'string',
                    role: 'url.fsapi',
                    read: true,
                    write: false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync('device.version', {
                type: 'state',
                common: {
                    name: 'SW version',
                    type: 'string',
                    role: 'info.firmware',
                    read: true,
                    write: false,
                },
                native: {},
            });

            if (dev.friendlyName !== null || dev.friendlyName !== undefined) {
                await this.setState('device.friendlyName', { val: dev.friendlyName.toString(), ack: true });
            }
            if (dev.version !== null || dev.version !== undefined) {
                await this.setState('device.version', { val: dev.version.toString(), ack: true });
            }
            if (dev.webfsapi !== null || dev.webfsapi !== undefined) {
                await this.setState('device.webfsapi', { val: dev.webfsapi.toString(), ack: true });
                this.config.fsAPIURL = dev.webfsapi.toString();
            }
        } catch (err) {
            //this.log.debug("Error in getDeviceInfo: " + JSON.stringify(err));
            if (axios.isAxiosError(err) && err.request) {
                // catch device not reachable
                if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') {
                    if (sessionRetryCnt > 0) {
                        this.log.info(`Device unreachable, retry ${sessionRetryCnt} more times`);
                        --sessionRetryCnt;
                        await this.getDeviceInfo();
                    } else {
                        //terminate adapter after unsuccessful retries
                        sessionRetryCnt = SESSION_RETRYS;
                        this.log.info(
                            `Device unreachable - Adapter stopped after ${++sessionRetryCnt} connection attempts`,
                        );
                        throw err;
                    }
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }

    /**
     * Call FSAPI
     *
     * @param {string} command
     * @param {string} value optional
     * @param {number} start optional, nur bei Listen, default ist -1
     * @param {number} maxItems optional, nur bei Listen, default ist 65535
     * @param {boolean} notify optional, true, wenn auf Nachrichten gewartet werden soll
     */
    async callAPI(command, value = '', start = -65535, maxItems = 65535, notify = false) {
        const answer = {};
        answer.success = false;

        if (sessionTimestamp <= Date.now() - this.config.RecreateSessionInterval * 60 * 1000) {
            this.log.debug('Recreating Session after RecreateSessionInterval');
            //recreate session
            try {
                await this.createSession(true);
            } catch (err) {
                this.log.error(String(err));
            }
        }

        const conn = await this.getStateAsync('info.connection');

        if (conn !== null && conn !== undefined && conn.val) {
            let url = '';
            const log = this.log;

            if (command.toUpperCase().startsWith('/FSAPI')) {
                command = command.substring(6);
            }
            if (command.toUpperCase().startsWith('/GET') || command.toUpperCase().startsWith('/SET')) {
                command = command.substring(5);
            }
            if (command.toUpperCase().startsWith('/LIST_GET_NEXT')) {
                command = command.substring(14);
            }

            if (notify) {
                url = `${this.config.fsAPIURL}/GET_NOTIFIES?pin=${this.config.PIN}&sid=${this.config.SessionID}`;
            } else if (start > -65535) {
                url = `${this.config.fsAPIURL}/LIST_GET_NEXT/${command}/${start}?pin=${this.config.PIN}&sid=${this.config.SessionID}&maxItems=${maxItems}`;
            } else if (value !== '') {
                url = `${this.config.fsAPIURL}/SET/${command}?pin=${this.config.PIN}&sid=${this.config.SessionID}&value=${value}`;
            } else {
                url = `${this.config.fsAPIURL}/GET/${command}?pin=${this.config.PIN}&sid=${this.config.SessionID}`;
            }
            this.log.debug(`Call API with url: ${url}`);
            try {
                await axios.get(url).then(data => {
                    //log.debug(device.)
                    const parser = new xml2js.Parser();
                    parser.parseStringPromise(data.data).then(function (result) {
                        log.debug(JSON.stringify(result.fsapiResponse));
                        answer.result = result.fsapiResponse;
                        answer.success = result.fsapiResponse.status[0].toString() == 'FS_OK';
                    });
                });
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (err) {
                this.log.info('Session error, trying to reestablish session...');
                await this.setState('info.connection', false, true);
                try {
                    await this.createSession();
                } catch (error) {
                    this.log.error(String(error));
                }
            }
        }
        return answer;
    }

    async createSession(reCreateSession = false) {
        const log = this.log;
        const dev = {};
        let url;
        let connected = false;
        if (this.config.fsAPIURL !== null) {
            const devName = await this.getStateAsync('device.friendlyName');
            const devIp = this.config.IP;
            if (!reCreateSession) {
                if (devName && devName.val) {
                    log.info(`Trying to create session with ${devName.val} @ ${devIp} ...`);
                } else {
                    log.info(`Trying to create session with device @ ${devIp} ...`);
                }
            }

            try {
                url = `${this.config.fsAPIURL}/CREATE_SESSION?pin=${this.config.PIN}`;
                log.debug(`Create session with ${url}`);
                await axios.get(url).then(device => {
                    const parser = new xml2js.Parser();
                    parser.parseStringPromise(device.data).then(function (result) {
                        //log.debug(result.fsapiResponse.sessionId);
                        dev.Session = result.fsapiResponse.sessionId;

                        if (!reCreateSession) {
                            log.info(
                                `Session ${dev.Session} with Device ${devName ? devName.val : 'unknown'} @ ${devIp} created`,
                            );
                        } else {
                            log.debug(
                                `Session ${dev.Session} with Device ${devName ? devName.val : 'unknown'} @ ${devIp} created`,
                            );
                        }
                        connected = true;
                        sessionRetryCnt = SESSION_RETRYS;
                        sessionTimestamp = Date.now();
                    });
                });
                this.config.SessionID = Number(dev.Session);
                //this.config.SessionTS = Date.now();
                await this.setState('info.connection', connected, true);
                if (this.log.level == 'debug' || this.log.level == 'silly') {
                    await this.setObjectNotExistsAsync('debug', {
                        type: 'channel',
                        common: {
                            name: 'Debugging tools',
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync('debug.resetSession', {
                        type: 'state',
                        common: {
                            name: 'Reset session',
                            type: 'boolean',
                            role: 'button',
                            def: false,
                            read: false,
                            write: true,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync('debug.session', {
                        type: 'state',
                        common: {
                            name: 'Session ID',
                            type: 'number',
                            role: 'value',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync('debug.sessionCreationTime', {
                        type: 'state',
                        common: {
                            name: 'Session timestamp',
                            type: 'number',
                            role: 'value.time',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync('debug.lastNotifyCall', {
                        type: 'state',
                        common: {
                            name: 'Timestamp of last notify call',
                            type: 'number',
                            role: 'value.time',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync('debug.lastNotifyError', {
                        type: 'state',
                        common: {
                            name: 'Error of last notify call',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await this.setState('debug.session', { val: Number(dev.Session), ack: true });
                    await this.setState('debug.sessionCreationTime', { val: sessionTimestamp, ack: true });
                } else {
                    await this.delObjectAsync('debug', { recursive: true });
                }

                await this.sleep(200);
            } catch (err) {
                // create session failed
                await this.setState('info.connection', connected, true);

                if (axios.isAxiosError(err) && err.response) {
                    // catch wrong PIN
                    if (err.response.status == 403) {
                        throw new Error('PIN mismatch - enter the PIN set on your device. Default is 1234');
                    } else if (err.response.status == 404) {
                        throw new Error('Session ID mismatch or invalid command');
                    } else {
                        throw new Error(`Unknown createSession response error: ${JSON.stringify(err)}`);
                    }
                } else if (axios.isAxiosError(err) && err.request) {
                    // catch device not reachable
                    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') {
                        this.log.debug(JSON.stringify(err));
                        if (sessionRetryCnt > 0) {
                            this.log.warn(
                                `Device ${devName ? devName.val : 'unknown'} @ ${devIp} unreachable, retrying ${sessionRetryCnt} more times ...`,
                            );
                            --sessionRetryCnt;
                            try {
                                await this.createSession();
                            } catch (err) {
                                this.log.error(String(err));
                            }
                        } else {
                            // send adapter to sleep after unsuccessful session retries
                            sessionRetryCnt = SESSION_RETRYS;
                            this.log.error(
                                `Device ${devName ? devName.val : 'unknown'} @ ${devIp} unreachable, retrying after session refresh interval ...`,
                            );
                            // clean up timers or intervals
                            polling = true; // disable onFSAPI processing
                            this.cleanUp(); // stop all sleeps
                            clearTimeout(timeOutMessage); // stop polling
                            await this.sleep(this.config.RecreateSessionInterval * 60 * 1000);
                            try {
                                await this.createSession();
                                timeOutMessage = setTimeout(
                                    () => this.onFSAPIMessage(),
                                    this.config.PollIntervall * 1000,
                                );
                                polling = false;
                            } catch (err) {
                                this.log.error(String(err));
                            }
                        }
                    } else {
                        throw new Error(`Unknown createSession request error: ${JSON.stringify(err)}`);
                    }
                } else {
                    throw new Error(`Unknown createSession error: ${JSON.stringify(err)}`);
                }
            }
        }
    }

    /*
	async deleteSession()
	{
		const log = this.log;
		let url;
		//const connected = false;
		const currentSession = this.config.SessionID;
		if (this.config.fsAPIURL !== null) {
			//await this.setState("info.connection", connected, true);
			log.debug(`Deleting Session ${currentSession}`);
			try {
				url = `${this.config.fsAPIURL}/DELETE_SESSION?pin=${this.config.PIN}&sid=${currentSession.toString()}`;
				log.debug(`Delete session with ${url}`);
				await axios.get(url)
					.then(device => {
						//log.debug(device.)
						const parser = new xml2js.Parser();
						parser.parseStringPromise(device.data)
							.then(function (result) {
								//log.debug(result.fsapiResponse.sessionId);
								//dev.Session = result.fsapiResponse.sessionId;
								log.debug(JSON.stringify(result.fsapiResponse));
								if (result.fsapiResponse.status[0].toString() == "FS_OK") {
									// @ts-ignore
									log.debug(`Session ${currentSession} deleted`);
								} else {
									// @ts-ignore
									log.debug(`Session ${currentSession} could not be deleted`);
								}
							});
					});
				//this.config.SessionID = 0;
				//connected = false;
				// await this.setState("info.connection", connected, true);
				//if(this.log.level=="debug" || this.log.level=="silly")
				//{
				//	await this.delObjectAsync("debug",{ recursive: true });
				//}
				//await this.sleep(200);
			}
			catch (err) {
			// delete session failed due to connection error
				//connected = false;
				this.log.debug ("Delete Session failed: " + JSON.stringify(err));
			}
		}
	}
*/

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    // 	if (typeof obj === "object" && obj.message) {
    // 		if (obj.command === "send") {
    // 			// e.g. send email or pushover or whatever
    // 			this.log.info("send command");

    // 			// Send response in callback if required
    // 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    // 		}
    // 	}
    // }

    async sleep(ms) {
        const ts = Date.now();
        return new Promise(resolve => {
            sleeps.set(ts, resolve);
            setTimeout(resolve, ms);
        });
    }

    async onFSAPIMessage() {
        if (!polling) {
            polling = true;
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const adapter = this;
            if (lastSleepClear <= Date.now() - 10 * 60 * 1000) {
                lastSleepClear = Date.now();
                adapter.log.debug('Clearing sleeps');
                if (sleeps.size > 0) {
                    try {
                        const timers = [];
                        sleeps.forEach((value, key) => {
                            if (key <= Date.now() - 900 * 1000) {
                                clearTimeout(value);
                                timers.push(key);
                            }
                        });
                        timers.forEach((value, index) => sleeps.delete(index));
                    } finally {
                        /* empty */
                    }
                }
            }

            try {
                notifyTimestamp = Date.now();
                if (this.log.level == 'debug' || this.log.level == 'silly') {
                    this.setState('debug.lastNotifyCall', { val: notifyTimestamp, ack: true });
                }
                const response = await this.callAPI('', '', 0, 0, true);

                if (response.success) {
                    //this.log.debug(JSON.stringify(response.response));
                    response.result.notify.forEach(async item => {
                        this.log.debug(`Item: ${item.$.node} - ${JSON.stringify(item.value)}`);

                        switch (item.$.node) {
                            case 'netremote.sys.state':
                                await this.callAPI('netRemote.sys.power').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('device.power', {
                                            val: response.result.value[0].u8[0] == 1,
                                            ack: true,
                                        });
                                    }
                                });
                                break;
                            case 'netremote.sys.mode':
                                await this.setState('modes.selected', { val: Number(item.value[0].u32[0]), ack: true });
                                await this.getStateAsync(`modes.${item.value[0].u32[0]}.label`).then(
                                    function (response) {
                                        if (response !== null && response !== undefined && response.val !== null) {
                                            adapter.setState('modes.selectedLabel', { val: response.val, ack: true });
                                        }
                                    },
                                );
                                //adapter.setState("modes.selectPreset", {val:null, ack: true});
                                //removed the following two lines to fix readPresets. Side effects tbs.
                                //await this.getModePresets(item.value[0].u32[0], false);
                                //await this.UpdatePreset();
                                break;
                            case 'netremote.play.serviceids.ecc':
                                break;
                            case 'netremote.play.info.text':
                                await this.setState('media.text', { val: item.value[0].c8_array[0].trim(), ack: true });
                                await this.callAPI('netRemote.play.info.artist').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('media.artist', {
                                            val: response.result.value[0].c8_array[0],
                                            ack: true,
                                        });
                                    }
                                });
                                await this.callAPI('netremote.sys.mode').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('modes.selected', {
                                            val: Number(response.result.value[0].u32[0]),
                                            ack: true,
                                        });
                                        adapter
                                            .getStateAsync(`modes.${response.result.value[0].u32[0]}.label`)
                                            .then(function (response) {
                                                if (
                                                    response !== null &&
                                                    response !== undefined &&
                                                    response.val !== null
                                                ) {
                                                    adapter.setState('modes.selectedLabel', {
                                                        val: response.val,
                                                        ack: true,
                                                    });
                                                }
                                            });
                                        //adapter.setState("modes.selectPreset", {val:null, ack: true});
                                    }
                                });
                                break;
                            case 'netremote.play.info.artist':
                                await this.setState('media.artist', {
                                    val: item.value[0].c8_array[0].trim(),
                                    ack: true,
                                });
                                break;
                            case 'netremote.play.info.album':
                                await this.setState('media.album', {
                                    val: item.value[0].c8_array[0].trim(),
                                    ack: true,
                                });
                                break;
                            case 'netremote.play.info.title':
                                await this.setState('media.title', {
                                    val: item.value[0].c8_array[0].trim(),
                                    ack: true,
                                });
                                break;
                            case 'netremote.play.info.name':
                                await this.setState('media.name', { val: item.value[0].c8_array[0].trim(), ack: true });
                                await this.callAPI('netRemote.play.info.artist').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('media.artist', {
                                            val: response.result.value[0].c8_array[0],
                                            ack: true,
                                        });
                                    }
                                });
                                await this.callAPI('netRemote.play.info.album').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('media.album', {
                                            val: response.result.value[0].c8_array[0],
                                            ack: true,
                                        });
                                    }
                                });
                                await this.callAPI('netremote.sys.audio.volume').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('audio.volume', {
                                            val: Number(response.result.value[0].u8[0]),
                                            ack: true,
                                        });
                                    }
                                });
                                await this.callAPI('netremote.sys.audio.mute').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('audio.mute', {
                                            val: response.result.value[0].u8[0] == 1,
                                            ack: true,
                                        });
                                    }
                                });

                                await this.callAPI('netremote.sys.mode').then(function (response) {
                                    if (response !== null && response !== undefined && response.val !== null) {
                                        adapter.setState('modes.selected', {
                                            val: Number(response.result.value[0].u32[0]),
                                            ack: true,
                                        });
                                        adapter
                                            .getStateAsync(`modes.${response.result.value[0].u32[0]}.label`)
                                            .then(function (response) {
                                                if (
                                                    response !== null &&
                                                    response !== undefined &&
                                                    response.val !== null
                                                ) {
                                                    adapter.setState('modes.selectedLabel', {
                                                        val: response.val,
                                                        ack: true,
                                                    });
                                                }
                                            });
                                        //adapter.setState("modes.selectPreset", {val:null, ack: true});
                                    }
                                });
                                await this.UpdatePreset(item.value[0].c8_array[0].trim());
                                await this.UpdateNavigation(item.value[0].c8_array[0].trim());
                                break;
                            case 'netremote.sys.audio.volume':
                                await this.setState('audio.volume', { val: Number(item.value[0].u8[0]), ack: true });
                                break;
                            case 'netremote.sys.audio.mute':
                                await this.setState('audio.mute', { val: item.value[0].u8[0] == 1, ack: true });
                                break;
                            case 'netremote.play.status':
                                switch (item.value[0].u8[0]) {
                                    // IDLE
                                    case '0':
                                        await this.setState('media.state', { val: 'IDLE', ack: true });
                                        break;
                                    // BUFFERING
                                    case '1':
                                        await this.setState('media.state', { val: 'BUFFERING', ack: true });
                                        break;
                                    // PLAYING
                                    case '2':
                                        await this.setState('media.state', { val: 'PLAYING', ack: true });
                                        break;
                                    // PAUSED
                                    case '3':
                                        await this.setState('media.state', { val: 'PAUSED', ack: true });
                                        break;
                                    // REBUFFERING
                                    case '4':
                                        await this.setState('media.state', { val: 'REBUFFERING', ack: true });
                                        break;
                                    // ERROR
                                    case '5':
                                        await this.setState('media.state', { val: 'ERROR', ack: true });
                                        break;
                                    // STOPPED
                                    case '6':
                                        await this.setState('media.state', { val: 'STOPPED', ack: true });
                                        break;
                                    // ERROR_POPUP
                                    case '7':
                                        await this.setState('media.state', { val: 'ERROR_POPUP', ack: true });
                                        break;
                                    default:
                                        break;
                                }
                                break;
                            case 'netremote.sys.power':
                                await this.setState('device.power', { val: item.value[0].u8[0] == 1, ack: true });
                                break;
                            case 'netremote.play.info.graphicuri':
                                await this.setState('media.graphic', {
                                    val: item.value[0].c8_array[0].trim(),
                                    ack: true,
                                });
                                break;
                            default:
                                break;
                        }
                    });
                    this.callAPI('netRemote.play.info.graphicUri').then(async function (response) {
                        await adapter.setState('media.graphic', {
                            val: response.result.value[0].c8_array[0].trim(),
                            ack: true,
                        });
                    });
                }
            } catch (e) {
                if (e instanceof Error) {
                    adapter.log.error(e.message);
                } else {
                    adapter.log.error(String(e));
                }
                if (this.log.level == 'debug' || this.log.level == 'silly') {
                    await adapter.setState('debug.lastNotifyError', { val: JSON.stringify(e), ack: true });
                }
            } finally {
                clearTimeout(timeOutMessage);
                timeOutMessage = setTimeout(() => this.onFSAPIMessage(), this.config.PollIntervall * 1000);
                polling = false;
            }
        }
    }

    async UpdateNavigation(name) {
        try {
            if (!name) {
                this.log.debug('UpdateNavigation: Name is undefined or empty.');
                return;
            }
            let navFound = false;
            let navKey = '';

            for (const item of currentNavList) {
                let navName = '';
                item.field.forEach(f => {
                    switch (f.$.name) {
                        case 'name':
                            navName = f.c8_array[0];
                            break;
                        default:
                            break;
                    }
                });
                if (navName === name) {
                    this.log.debug(
                        `UpdateNavigation: Found matching navigation item "${name}" with key ${item.$.key}.`,
                    );
                    navFound = true;
                    navKey = item.$.key;
                    break;
                }
            }
            if (navFound) {
                await this.setState('modes.currentNavIndex', {
                    val: Number(navKey) >= currentNavListChunk ? Number(navKey) % currentNavListChunk : Number(navKey),
                    ack: true,
                });
                await this.setState('modes.currentNavKey', { val: Number(navKey), ack: true });
                await this.setState(`modes.currentNavName`, { val: name, ack: true });
            }
        } catch (error) {
            this.log.error(`UpdateNavigation error: ${String(error)}`);
        }
    }

    async UpdatePreset(name) {
        if (!name) {
            this.log.debug('UpdatePreset: Name is undefined or empty.');
            return;
        }

        const mode = await this.getStateAsync('modes.selected');
        if (!mode || mode.val === null || mode.val === undefined) {
            this.log.debug('UpdatePreset: Selected mode is not available.');
            return;
        }

        const hasPresets = await this.getStateAsync(`modes.${mode.val}.presets.available`);
        if (!hasPresets || !hasPresets.val) {
            this.log.debug(`UpdatePreset: No presets available for mode ${mode.val}.`);
            await this.setState('modes.selectPreset', { val: null, ack: true });
            return;
        }

        let presetFound = false;
        let i = 0;

        while (true) {
            const preset = await this.getStateAsync(`modes.${mode.val}.presets.${i.toString()}.name`);
            this.log.debug(`checking Preset: modes.${mode.val}.presets.${i}.name`);
            // Wenn keine weiteren Presets vorhanden sind, Schleife beenden
            if (!preset) {
                this.log.debug(`UpdatePreset: No more presets found at index ${i}.`);
                break;
            }

            // Wenn der aktuelle Eintrag leer oder null ist, überspringen
            if (!preset.val) {
                this.log.debug(`UpdatePreset:  Mode ${mode.val} Preset at index ${i} is empty or null. Skipping.`);
                i++;
                continue;
            }

            // Wenn ein passender Preset-Name gefunden wurde
            if (name === preset.val) {
                this.log.debug(`UpdatePreset: Found matching preset "${name}" at index ${i}.`);
                await this.setState('modes.selectPreset', { val: i, ack: true });
                presetFound = true;
                break;
            }

            i++;
        }

        if (!presetFound) {
            this.log.debug(`UpdatePreset: No matching preset found for name "${name}".`);
            await this.setState('modes.selectPreset', { val: null, ack: true });
        }
    }
}

// @ts-expect-error parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = options => new FrontierSilicon(options);
} else {
    // otherwise start the instance directly
    new FrontierSilicon();
}
