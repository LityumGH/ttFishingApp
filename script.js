// --- CONSTANTS ---
const API_BASE_URL = 'https://tycoon-2epova.users.cfx.re/status';
const DEBUG_MODE = false; // Set to true to show all windows and extra logs

// --- STATE MANAGEMENT ---
function createFastStore(initial = {}) {
    const state = { ...initial };
    const listeners = new Set();

    return {
        get: () => state,
        set: (patch) => {
            let changed = false;
            for (const key in patch) {
                if (state[key] !== patch[key]) {
                    state[key] = patch[key];
                    changed = true;
                }
            }
            if (changed) listeners.forEach(fn => fn(state));
        },
        subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }
    };
}

const store = createFastStore({
    isFisherman: false,
    // isInBoat: false,
    uiVisible: false,
    status: false,
    playerPosition: { x: 0, y: 0 },
    pots: [],
    lastPotsData: [],
    fishingExp: 0,
    allGameData: {},
    config: {
        fishingPerkActive: false,
        autoGut: false,
        autoStore: false,
        autoHide: false,
        autoPlacePots: false,
        activateBlips: false,
        apiMode: 'mock',
        apiKey: '',
        sortBy: 'distance',
        sortOrder: 'asc'
    },
    pinnedWindows: [],
    inventoryCache: { fish: 0, pots: 0, fish_pot: 0 },
    potBlips: [],
    blipsNeedUpdate: 2,
    actionsRunning: {
        autoGut: false,
        autoStore: false,
        autoPlacePots: false,
        potCollection: false
    },
    playerSpawned: false
});

// --- CORE LOGIC ---

function sendCommand(command) {
    if (store.get().config.apiMode === 'mock' && window.parent === window) {
        if (command.type === 'notification') {
            console.log(`NOTIFICATION: ${command.text}`);
        } else {
            console.log("MOCK: Sent Command:", command);
        }
        return;
    }
    window.parent.postMessage(command, "*");
}

function notifyPlayer(message, type = 'info', time = 5) {
    const notificationTypes = {
        success: { prefix: '~g~', icon: '' },
        error: { prefix: '~r~', icon: '' },
        warning: { prefix: '~y~', icon: '' },
        info: { prefix: '~b~', icon: '' }
    };
    const appPrefix = '~d~[AFH]~s~';
    const notificationType = notificationTypes[type.toLowerCase()] || notificationTypes.info;

    const fullMessage = `${appPrefix}${notificationType.prefix}${notificationType.icon} ${message}`;

    sendCommand({ type: 'notification', text: fullMessage });
}

function handleGameData(data) {
    store.set({ allGameData: { ...store.get().allGameData, ...data } });

    if (DEBUG_MODE) {
        document.getElementById('debug-data').textContent = JSON.stringify(store.get().allGameData, null, 2);
    }

    let needsUiUpdate = false;

    if (data.job !== undefined) {
        store.set({ isFisherman: data.job === 'fisher' });
        document.getElementById('job-name').textContent = data.job_name || 'N/A';
        updateAppStatus();
        updateWindowVisibility();
    }

    if (data.vehicleClass !== undefined || data.vehicleName !== undefined) {
        const isInBoat = data.vehicleClass === 14 && data.vehicleName.toLowerCase() === data.boat.toLowerCase() && data.vehicle !== 'onFoot';
        document.getElementById('vehicle-name').textContent = isInBoat ? (data.vehicleName || 'Unknown Boat') : 'N/A';
    }

    if (data.pos_x !== undefined && data.pos_y !== undefined) {
        store.set({ playerPosition: { x: data.pos_x, y: data.pos_y } });
        needsUiUpdate = true;

        if (store.get().status && store.get().config.autoPlacePots && store.get().playerSpawned) {
            triggerAutoPlacePots();
        }
    }

    if (data['exp_farming_fishing'] !== undefined) {
        store.set({ fishingExp: data['exp_farming_fishing'] });
        const fishingLevel = Math.floor((Math.sqrt(1 + 8 * store.get().fishingExp / 5) - 1) / 2);
        document.getElementById('fishing-exp').textContent = `${store.get().fishingExp.toLocaleString()} (Level ${fishingLevel})`;
    }

    if (data.weather) {
        const weatherInfo = getWeatherInfo(data.weather);
        document.getElementById('current-weather').textContent = `${weatherInfo.text} ${weatherInfo.icon} (+${weatherInfo.bonus}% 🎣)`;
        document.getElementById('fishing-conditions').textContent = `${'⭐'.repeat(weatherInfo.rating)}${'☆'.repeat(5 - weatherInfo.rating)}`;
    }

    if (data.weather_forecast) {
        const forecastInfo = getWeatherInfo(data.weather_forecast);
        document.getElementById('forecast-weather').textContent = `${forecastInfo.text} ${forecastInfo.icon} (+${forecastInfo.bonus}% 🎣)`;
    }

    const inventoryKeys = Object.keys(data).filter(k => k.startsWith('inventory') || k.startsWith('chest_'));
    // if inventory is changed, update the inventory
    if (inventoryKeys.length > 0) {
        handleInventoryChange();
        updateCombinedInventoryDisplay();
    }

    if (data.focused !== undefined || data.pinned !== undefined) {
        updateWindowVisibility();
    }

    if (needsUiUpdate) {
        updatePotDisplay();
    }
}

function handleNotification(notification) {
    if (notification.includes('[AFH]')) return;
    if (notification.includes('Used')) {
        // notifyPlayer('U-s-e-d item!', 'error');
        return;
    }

    /*if (!store.get().playerSpawned) {
        if (notification.includes('Welcome. Press M to use the menu.')) {
            store.set({ playerSpawned: true });
        }
        return;
    }*/

    // Notification is string. It can be:
    // - "Gutted a total of X fish!"
    if (notification.includes('Gutted') && store.get().config.autoStore) {
        //Trigger auto store
        triggerAutoStore();
    }


    if (notification.includes('Fish:') && !notification.toLowerCase().includes('meat')) {
        notifyPlayer('New fish detected!', 'info');

        //Trigger auto gut
        if (store.get().config.autoGut) {
            triggerAutoGut();
        }

        if (notification.includes('Crab')) {
            const closestPot = findClosestPot();
            if (closestPot.distance < 11) {
                // notifyPlayer('Crab pot collected flag set', 'warning');
                store.set({ actionsRunning: { ...store.get().actionsRunning, potCollection: true } });
            }
        }
    }

    if (notification.includes('Pot placed!')) {
        // Pot placement detection
        // collection time forrmula Math.ceil(100 / 5) + 2 but we need to cap it at 22 hours
        const fishingLevel = Math.floor((Math.sqrt(1 + 8 * store.get().fishingExp / 5) - 1) / 2);
        var collectionTime = Math.min(Math.ceil(fishingLevel / 5) + 2, 22);
        collectionTime = store.get().config.fishingPerkActive ? collectionTime / 2 : collectionTime;
        notifyPlayer(`Pot placed! Ready for collection in ~g~${collectionTime} hours`, 'info');
        // generate a pot id from 1 to 40. If the pot id is already in the array, go to the next one.
        var potId = 1;
        while (store.get().pots.some(pot => pot.id === potId)) {
            potId++;
        }
        store.set({ pots: [...store.get().pots, { id: potId, position: store.get().playerPosition, age: 0, type: 'crab' }] });
        updatePotDisplay();
    }

}

function triggerAutoPlacePots() {
    if (store.get().config.autoPlacePots && !store.get().actionsRunning.autoPlacePots) {
        const closestPot = findClosestPot();
        if (200 > closestPot.distance && closestPot.distance > 124 && store.get().inventoryCache.pots > 0) {
            placePotSequence();
        }
    }
}

async function placePotSequence() {
    if (!store.get().status || !store.get().config.autoPlacePots || store.get().actionsRunning.autoPlacePots) return;
    store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: true } });
    const closestPot = findClosestPot();
    if (closestPot.distance > 124 && store.get().inventoryCache.pots > 0) {
        if (!store.get().allGameData.menu_open) {
            try {
                notifyPlayer('Auto-placing pot.', 'success');
                if (store.get().config.autoStore) {
                    await waitForCondition(() => !store.get().allGameData.menu_open);
                }
                sendCommand({ type: 'openMainMenu' });
                await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('menu'));
                const inventoryChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'inventory');
                if (inventoryChoice.index !== -1) {
                    sendCommand({ type: 'forceMenuChoice', choice: inventoryChoice.name, mod: 0 });
                    // notifyPlayer('Inventory opened.', 'success');
                } else {
                    throw new Error('Could not find \'Inventory\' option.');
                }
                await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('inventory'));
                const potChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'crab pot');
                if (potChoice.index !== -1) {
                    sendCommand({ type: 'forceMenuChoice', choice: potChoice.name, mod: 0 });
                    // notifyPlayer('Crab pot menu opened.', 'success');
                } else {
                    throw new Error('Could not find \'Crab Pot\' option.');
                }
                await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('crab pot'));
                const placePotChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'place');
                if (placePotChoice.index !== -1) {
                    sendCommand({ type: 'forceMenuChoice', choice: placePotChoice.name, mod: 0 });
                    // notifyPlayer('Crab pot placed.', 'success');
                    // sleep for 1 second
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    throw new Error('Could not find \'Place\' option.');
                }
            } catch (error) {
                notifyPlayer('Auto-placing pot failed: ' + error.message, 'error');
            } finally {
                setTimeout(() => {
                    store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: false } });
                }, 2000);
            }
        } else {
            if (store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('crab pot')) {
                try {
                    notifyPlayer('Auto-placing pot.', 'success');
                    const placePotChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'place');
                    if (placePotChoice.index !== -1) {
                        sendCommand({ type: 'forceMenuChoice', choice: placePotChoice.name, mod: 0 });
                        // notifyPlayer('Crab pot placed.', 'success');
                        // sleep for 1 second
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } else {
                        throw new Error('Could not find \'Place\' option.');
                    }
                } catch (error) {
                    notifyPlayer('Auto-placing pot failed: ' + error.message, 'error');
                } finally {
                    setTimeout(() => {
                        store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: false } });
                    }, 2000);
                }
            }
            else if (store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('inventory')) {
                sendCommand({ type: 'forceMenuBack' });
                notifyPlayer('Inventory was open, retrying place pot sequence', 'error');
                setTimeout(() => {
                    store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: false } });
                }, 2000);
            }
            else {
                notifyPlayer('Auto-placing pot failed.', 'error');
                setTimeout(() => {
                    store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: false } });
                }, 2000);
            }
        }
    }
    else {
        notifyPlayer('No pots to place.', 'error');
        setTimeout(() => {
            store.set({ actionsRunning: { ...store.get().actionsRunning, autoPlacePots: false } });
        }, 2000);
    }
}

async function fetchPotData() {
    const statusEl = document.getElementById('api-status');
    const fetchBtn = document.getElementById('fetch-pots-btn');
    const potsTableBody = document.querySelector('#pots-table tbody');

    statusEl.textContent = 'Fetching...';
    statusEl.style.backgroundColor = '#555';
    fetchBtn.disabled = true;
    potsTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center;">Loading pot data...</td></tr>';

    if (store.get().config.apiMode === 'mock') {
        // const mockResponse = [{ "position": { "x": 4815, "z": 0.16, "y": -5152.52 }, "type": "crab", "age": 5091 }, { "position": { "x": 4690, "z": 0.17, "y": -5187.90 }, "type": "crab", "age": 82000 }, { "position": { "x": 4571, "z": 0.16, "y": -5237.00 }, "type": "crab", "age": 250000 }, { "position": { "x": 4437, "z": 0.16, "y": -5288.00 }, "type": "crab", "age": 900000 }];
        const mockResponse = [{ "type": "crab", "position": { "y": -5149.759765625, "z": 0.21701847016811, "x": 4888.0712890625 }, "age": 17277 },
            { "type": "crab", "position": { "y": -5182.34912109375, "z": -0.70535272359848, "x": 4753.291015625 }, "age": 17259 },
            { "type": "crab", "position": { "y": -5218.072265625, "z": -0.76718986034393, "x": 4617.4931640625 }, "age": 17243 },
            { "type": "crab", "position": { "y": -5261.24267578125, "z": -0.36991009116172, "x": 4429.93310546875 }, "age": 11*3600 },
            { "type": "crab", "position": { "y": -5268.15771484375, "z": -0.4619168639183, "x": 4301.11328125 }, "age": 22*3600 },
            { "type": "crab", "position": { "y": -5285.86865234375, "z": -0.52720665931701, "x": 4161.93212890625 }, "age": 46*3600-10 },
            { "type": "crab", "position": { "y": -5308.15625, "z": -0.58976018428802, "x": 4026.44775390625 }, "age": 70*3600-10 },
            { "type": "crab", "position": { "y": -5329.49951171875, "z": -0.53005814552307, "x": 3860.073486328125 }, "age": 166*3600-10 },
            { "type": "crab", "position": { "y": -5349.87109375, "z": -0.83912104368209, "x": 3721.862548828125 }, "age": 177*3600-10 },
            { "type": "crab", "position": { "y": -5375.125, "z": -0.51604741811752, "x": 3550.22021484375 }, "age": 179*3600 },
            { "type": "crab", "position": { "y": -5403.24169921875, "z": -0.59877079725265, "x": 3370.7421875 }, "age": 17070 },
            { "type": "crab", "position": { "y": -5437.53662109375, "z": -0.77667194604873, "x": 3192.0703125 }, "age": 17037 },
            { "type": "crab", "position": { "y": -5457.29541015625, "z": -0.44545397162437, "x": 3055.45654296875 }, "age": 17023 },
            { "type": "crab", "position": { "y": -5476.61474609375, "z": -0.52935063838958, "x": 2908.35595703125 }, "age": 17009 },
            { "type": "crab", "position": { "y": -5373.08837890625, "z": -0.69694530963897, "x": 4492.7275390625 }, "age": 16750 },
            { "type": "crab", "position": { "y": -5399.263671875, "z": -0.64206933975219, "x": 4352.9208984375 }, "age": 16733 },
            { "type": "crab", "position": { "y": -5430.5693359375, "z": -0.7971367239952, "x": 4213.11474609375 }, "age": 16716 },
            { "type": "crab", "position": { "y": -5445.8515625, "z": -0.5644541978836, "x": 4080.660400390625 }, "age": 16701 },
            { "type": "crab", "position": { "y": -5456.822265625, "z": -0.39270955324172, "x": 3948.472900390625 }, "age": 16685 },
            { "type": "crab", "position": { "y": -5476.890625, "z": -0.68046897649765, "x": 3811.533447265625 }, "age": 16669 },
            { "type": "crab", "position": { "y": -5497.56396484375, "z": -0.42885586619377, "x": 3657.878662109375 }, "age": 16652 },
            { "type": "crab", "position": { "y": -5514.28564453125, "z": -0.61045652627944, "x": 3519.136474609375 }, "age": 16637 },
            { "type": "crab", "position": { "y": -5535.88720703125, "z": -0.50635528564453, "x": 3385.2509765625 }, "age": 16623 },
            { "type": "crab", "position": { "y": -5562.16015625, "z": -0.61524301767349, "x": 3246.49609375 }, "age": 16608 },
            { "type": "crab", "position": { "y": -5600.70361328125, "z": -0.28910514712333, "x": 3018.197998046875 }, "age": 16589 },
            { "type": "crab", "position": { "y": -5618.81201171875, "z": -0.4139070212841, "x": 2869.555419921875 }, "age": 16574 },
            { "type": "crab", "position": { "y": -5600.24560546875, "z": -0.85140979290008, "x": 2721.820556640625 }, "age": 16560 },
            { "type": "crab", "position": { "y": -5151.05712890625, "z": -0.51913142204284, "x": 4364.40576171875 }, "age": 16350 },
            { "type": "crab", "position": { "y": -5147.81396484375, "z": -0.41992011666297, "x": 4233.1396484375 }, "age": 16335 },
            { "type": "crab", "position": { "y": -5154.2490234375, "z": -0.53720414638519, "x": 4101.935546875 }, "age": 16320 },
            { "type": "crab", "position": { "y": -5164.837890625, "z": -0.66131508350372, "x": 3969.5556640625 }, "age": 16304 },
            { "type": "crab", "position": { "y": -5186.94873046875, "z": -0.64436054229736, "x": 3838.661865234375 }, "age": 16289 },
            { "type": "crab", "position": { "y": -5210.81689453125, "z": -0.53106343746185, "x": 3708.585205078125 }, "age": 16273 },
            { "type": "crab", "position": { "y": -5233.212890625, "z": -0.77945387363433, "x": 3577.6806640625 }, "age": 16257 },
            { "type": "crab", "position": { "y": -5260.05810546875, "z": -0.76321160793304, "x": 3446.51171875 }, "age": 16242 },
            { "type": "crab", "position": { "y": -5283.16357421875, "z": -0.55829626321792, "x": 3312.194091796875 }, "age": 16226 },
            { "type": "crab", "position": { "y": -5295.583984375, "z": -0.59182846546173, "x": 3180.0703125 }, "age": 16210 },
            { "type": "crab", "position": { "y": -5306.74169921875, "z": -0.68594169616699, "x": 3048.262451171875 }, "age": 16194 },
            { "type": "crab", "position": { "y": -5316.96630859375, "z": -0.54583913087844, "x": 2916.0830078125 }, "age": 16179 },
            { "type": "crab", "position": { "y": -5323.99755859375, "z": -0.72026985883712, "x": 2787.104248046875 }, "age": 16162 }
        ];
        setTimeout(() => { // Simulate network delay
            handlePotData(mockResponse);
            localStorage.setItem('cachedPots', JSON.stringify({ timestamp: Date.now() - 79200, data: mockResponse }));
            statusEl.textContent = 'Mock data loaded.';
            statusEl.style.backgroundColor = 'var(--success-color)';
            fetchBtn.disabled = false;
        }, 500);
        return;
    }

    if (!store.get().config.apiKey) {
        statusEl.textContent = 'Error: API Key is missing.';
        statusEl.style.backgroundColor = 'var(--error-color)';
        potsTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--error-color);">API Key is missing.</td></tr>';
        fetchBtn.disabled = false;
        return;
    }

    const apiUrl = `${API_BASE_URL}/deadliest_catch.json`;
    const headers = { 'X-Tycoon-Key': store.get().config.apiKey };

    try {
        const response = await fetch(apiUrl, { headers });
        if (response.ok) {
            const potsData = await response.json();
            handlePotData(potsData);
            localStorage.setItem('cachedPots', JSON.stringify({ timestamp: Date.now(), data: potsData }));
            statusEl.textContent = `Pots loaded: ${potsData.length}`;
            statusEl.style.backgroundColor = 'var(--success-color)';
            document.getElementById('pot-warning').style.display = 'none';
        } else {
            statusEl.textContent = `API Error: ${response.status}`;
            statusEl.style.backgroundColor = 'var(--error-color)';
            potsTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--error-color);">API Error: ${response.status}</td></tr>`;
            notifyPlayer(`API Error: ${response.status}`, 'error');
        }
    } catch (error) {
        statusEl.textContent = 'Network Error';
        statusEl.style.backgroundColor = 'var(--error-color)';
        potsTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--error-color);">Network Error.</td></tr>';
        notifyPlayer(`Fetch Error: ${error.message}`, 'error');
    } finally {
        fetchBtn.disabled = false;
    }
}

function handlePotData(potsData) {
    const now = new Date();
    const newPots = potsData.map((pot, index) => ({
        id: index + 1,
        position: pot.position,
        age: pot.age,
        type: pot.type || 'unknown'
    }));

    store.set({
        pots: newPots,
        lastPotsData: potsData
    });
    clearPotBlips();
    updatePotDisplay();
}

function addPotBlip(pot) {
    if (!store.get().config.activateBlips) return;
    if (store.get().pots.length === 0) return;
    if (store.get().potBlips.some(blip => blip.position.x === pot.position.x && blip.position.y === pot.position.y)) return;

    const newBlip = {
        id: `afh_blip${pot.id}`,
        position: pot.position,
        type: pot.type,
        state: pot.state,
        yield: pot.yield,
        age: pot.age,
        isReady: pot.isReady
    };
    sendCommand({ type: 'addBlip', id: newBlip.id, x: newBlip.position.x, y: newBlip.position.y });
    store.set({ blipsNeedUpdate: 0 });
    store.set({ potBlips: [...store.get().potBlips, newBlip] });
}

function clearPotBlips() {
    store.get().potBlips.forEach(blip => {
        sendCommand({ type: 'removeBlip', id: blip.id });
    });
    store.set({ potBlips: [] });
}

function updatePotBlips() {
    if (!store.get().config.activateBlips) return;
    if (store.get().potBlips.length === 0) return;

    // add new blips
    store.get().potBlips.forEach(blip => {
        var blipName = '';
        var blipColor = 40;  // dark gray
        if (blip.type === 'crab') {
            blipName = 'Crab Pot ' + blip.state;
            sendCommand({ type: 'setBlipSprite', id: blip.id, sprite: 237 }); // 237 crab pot
        } else if (blip.type === 'lobster') {
            blipName = 'Lobster Pot ' + blip.state;
            sendCommand({ type: 'setBlipSprite', id: blip.id, sprite: 238 }); // 238 lobster pot
        } else {
            blipName = 'Seafloor Pot ' + blip.state;
            sendCommand({ type: 'setBlipSprite', id: blip.id, sprite: 237 });
        }
        if (blip.isReady) {
            if (blip.state === 'Ready') {
                blipName = '~g~' + blipName;
                blipColor = 2;  // green
            } else if (blip.state === 'Degrading') {
                blipName = '~y~' + blipName;
                blipColor = 5;  // yellow
            } else if (blip.state === 'Degraded') {
                blipName = '~r~' + blipName;
                blipColor = 1;  // red
            }
            sendCommand({ type: 'setBlipName', id: blip.id, name: blipName });
            sendCommand({ type: 'setBlipColour', id: blip.id, color: blipColor });
            sendCommand({ type: 'showTickOnBlip', id: blip.id, ticked: true });
        } else {
            sendCommand({ type: 'setBlipName', id: blip.id, name: blipName });
            sendCommand({ type: 'setBlipColour', id: blip.id, color: blipColor });
            // sendCommand({ type: 'showTickOnBlip', id: blip.id, ticked: false });
        }
    });
}

function findClosestPot() {
    if (store.get().pots.length === 0 || !store.get().playerPosition) return { pot: null, distance: Infinity };

    return store.get().pots.reduce((closest, pot) => {
        const distance = calculateDistance(store.get().playerPosition, pot.position);
        if (distance < closest.distance) {
            return { pot, distance };
        }
        return closest;
    }, { pot: null, distance: Infinity });
}

function findItemIndexBySubstring(menuChoicesData, searchString, excludeStrings) {
    if (!menuChoicesData) {
        return { index: -1, name: null };
    }

    try {
        const choices = JSON.parse(menuChoicesData);
        if (!Array.isArray(choices)) {
            console.error("menu_choices is not an array:", choices);
            return { index: -1, name: null };
        }

        const itemIndex = choices.findIndex(item => {
            if (Array.isArray(item) && typeof item[0] === 'string') {
                if (excludeStrings && excludeStrings.some(excludeString => item[0].toLowerCase().includes(excludeString.toLowerCase()))) {
                    return false;
                }
                else {
                    return item[0].toLowerCase().includes(searchString.toLowerCase());
                }
            }
            return false;
        });

        if (itemIndex !== -1) {
            return { index: itemIndex, name: choices[itemIndex][0] };
        }

        return { index: -1, name: null };
    } catch (e) {
        console.error("Error parsing menu_choices JSON:", e);
        return { index: -1, name: null };
    }
}

/**
 * Waits for a condition to be true, with a timeout.
 * @param {() => boolean} conditionFn - A function that returns true when the condition is met.
 * @param {number} [timeout=2000] - The maximum time to wait in milliseconds.
 * @returns {Promise<void>} A promise that resolves when the condition is met, or rejects on timeout.
 */
function waitForCondition(conditionFn, timeout = 2000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (conditionFn()) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Condition not met within ${timeout}ms`));
            }
        }, 50); // Check every 50ms
    });
}

// --- AUTOMATION ---

function handleInventoryChange() {
    const newInventory = { fish: 0, pots: 0, fish_pot: 0 };
    const itemsToTrack = { 'fish_': 'fish', 'pot_': 'pots', 'fish_pot': 'fish_pot' };
    // 1. Count current items from all inventory sources
    for (const key in store.get().allGameData) {
        if (key.startsWith('inventory')) {
            try {
                const inventory = JSON.parse(store.get().allGameData[key]);
                for (const itemName in inventory) {
                    for (const prefix in itemsToTrack) {
                        if (itemName.startsWith(prefix) && !itemName.includes('meat')) {
                            newInventory[itemsToTrack[prefix]] += inventory[itemName].amount;
                        }
                    }
                }
            } catch (e) { /* Ignore parse errors */ }
        }
    }

    // notifyPlayer('handleInventoryChange newInventory.fish_pot: ' + newInventory.fish_pot + ' potCollection: ' + store.get().actionsRunning.potCollection, 'warning');

    if (newInventory.fish_pot > 0 && store.get().actionsRunning.potCollection) {
        const closestPot = findClosestPot();
        if (closestPot.distance < 25) {
            notifyPlayer(`Collected a ${closestPot.pot.type} pot!`, 'success');
            // Remove the pot from the list
            store.set({ pots: store.get().pots.filter(p => p.id !== closestPot.pot.id) });
            // Remove the blip from the list
            if (store.get().config.activateBlips) {
                store.set({ potBlips: store.get().potBlips.filter(blip => blip.id !== `afh_blip${closestPot.pot.id}`) });
                sendCommand({ type: 'removeBlip', id: `afh_blip${closestPot.pot.id}` });
            }
            updatePotDisplay();

            // Update cached pot data in localStorage to reflect the removed pot
            const cachedPotsRaw = localStorage.getItem('cachedPots');
            if (cachedPotsRaw) {
                try {
                    const cachedPots = JSON.parse(cachedPotsRaw);
                    // Remove the collected pot from cached data
                    cachedPots.data = cachedPots.data.filter(pot => pot.id !== closestPot.pot.id);
                    // Update the cache with the modified data
                    localStorage.setItem('cachedPots', JSON.stringify({ timestamp: cachedPots.timestamp, data: cachedPots.data }));
                    // handlePotData(cachedPots.data);
                } catch (e) {
                    // console.error('Error updating cached pot data:', e);
                }
            }
        }
        store.set({ actionsRunning: { ...store.get().actionsRunning, potCollection: false } });
    }

    // 3. Update cache for the next check
    store.set({ inventoryCache: newInventory });
}

function triggerAutoGut() {
    if (store.get().config.autoGut) {
        autoGutFish();
    }
}

async function triggerAutoStore() {
    if (!store.get().status || !store.get().config.autoStore) return;

    notifyPlayer('Triggering auto store', 'info');

    try {
        sendCommand({ type: 'sendCommand', command: 'rm_trunk' });
        sendCommand({ type: "getData" });
        await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('trunk'));

        const putAllChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'put all');
        if (putAllChoice.index !== -1) {
            sendCommand({ type: 'forceMenuChoice', choice: putAllChoice.name, mod: 0 });
            // notifyPlayer('All fish meat stored in trunk.', 'success');
        } else {
            notifyPlayer('Could not find \'Put All\' option.', 'error');
        }
        await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('trunk'));
        // Take all pot from trunk
        const chestKey = Object.keys(store.get().allGameData).filter(k => k.includes(store.get().allGameData.chest));
        if (chestKey.length > 0 && chestKey[0].startsWith('chest_')) {
            const chestData = JSON.parse(store.get().allGameData[chestKey[0]]);
            const chestItems = Object.keys(chestData).filter(k => k.startsWith('pot_'));
            if (chestItems.length > 0) {
                for (const item of chestItems) {
                    if (item.includes('pot_')) {
                        notifyPlayer(`Taking pots from trunk.`, 'info');
                        const takeChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'Take', ['Weightless', 'Repeat']);
                        if (takeChoice.index !== -1) {
                            sendCommand({ type: 'forceMenuChoice', choice: takeChoice.name, mod: -1 });
                        }
                        await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('take'));
                        const takePotChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'pot');
                        if (takePotChoice.index !== -1) {
                            sendCommand({ type: 'forceMenuChoice', choice: takePotChoice.name, mod: -1 });
                        }
                        else {
                            notifyPlayer('Could not find \'pot\' option in trunk.', 'error');
                        }
                    }
                }
            }
            else {
                // Take pots from trunk if pots are found in inventory
                const invKey = Object.keys(store.get().allGameData).filter(k => k.startsWith('inventory'));
                if (invKey.length > 0) {
                    const invData = JSON.parse(store.get().allGameData[invKey[0]]);
                    const invItems = Object.keys(invData).filter(k => k.startsWith('pot_'));
                    if (invItems.length > 0) {
                        for (const item of invItems) {
                            if (item.includes('pot_')) {
                                notifyPlayer(`Taking pots from trunk.`, 'info');
                                const takeChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'Take', ['Weightless', 'Repeat']);
                                if (takeChoice.index !== -1) {
                                    sendCommand({ type: 'forceMenuChoice', choice: takeChoice.name, mod: -1 });
                                }
                                await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('take'));
                                const takePotChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'pot');
                                if (takePotChoice.index !== -1) {
                                    sendCommand({ type: 'forceMenuChoice', choice: takePotChoice.name, mod: -1 });
                                }
                                else {
                                    notifyPlayer('Could not find \'pot\' option in trunk.', 'error');
                                }
                            }
                        }
                    }
                }
            }
        }
        else {
            notifyPlayer('Could not find trunk data.', 'error');
        }
        await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('trunk'));
        if (store.get().allGameData.menu_open) {
            sendCommand({ type: 'forceMenuBack' }); // Close the trunk menu
        }
        notifyPlayer('Auto-store complete.', 'success');

    } catch (error) {
        notifyPlayer(`Auto-store failed: ${error.message}`, 'error');
        // Ensure menu is closed on failure
        if (store.get().allGameData.menu_open) {
            sendCommand({ type: 'forceMenuBack' });
        }
    }
}

// --- UI UPDATE FUNCTIONS ---

function updateWindowVisibility() {
    const isBrowser = window.parent === window;
    const shouldBeVisible = DEBUG_MODE || isBrowser || !store.get().config.autoHide || store.get().status;

    if (shouldBeVisible) {
        if (!store.get().uiVisible) {
            store.set({ uiVisible: true });
            sendCommand({ type: "getData" });
            document.getElementById('main-container').style.display = 'block';
        }
    } else {
        if (store.get().uiVisible) {
            store.set({ uiVisible: false });
            document.getElementById('main-container').style.display = 'none';
            if (!store.get().config.activateBlips) clearPotBlips();
        }
    }

    const isAppFocused = store.get().allGameData.focused === true;
    const isAppPinnedByGame = store.get().allGameData.pinned === true;

    document.querySelectorAll('.window').forEach(win => {
        if (isAppFocused || win.classList.contains('pinned')) {
            win.style.display = 'flex';
        } else if (isAppPinnedByGame) {
            win.style.display = 'none';
        }
    });

    if (!DEBUG_MODE) {
        document.getElementById('debug-window').style.display = 'none';
    }
}

function updateCombinedInventoryDisplay() {
    const fishingItems = {};
    const itemsToTrack = ['tackle', 'fishing', 'pot_crab', 'pot_lobster', 'fish_', 'gut', 'flotsam', 'level_token'];

    const processInv = (inventoryObject) => {
        for (const itemName in inventoryObject) {
            if (itemsToTrack.some(track => itemName.startsWith(track))) {
                const cleanName = itemName.split('|')[0];
                if (!fishingItems[cleanName]) {
                    fishingItems[cleanName] = { amount: 0 };
                }
                fishingItems[cleanName].amount += inventoryObject[itemName].amount;
            }
        }
    };

    for (const key in store.get().allGameData) {
        if (key.startsWith('inventory') || key.startsWith('chest_')) {
            try {
                const inventory = JSON.parse(store.get().allGameData[key]);
                processInv(inventory);
            } catch (e) { /* Ignore parse errors */ }
        }
    }

    const tableBody = document.querySelector('#inventory-table tbody');
    tableBody.innerHTML = '';

    const sortedItems = Object.keys(fishingItems).sort((a, b) => a.localeCompare(b));

    for (const itemName of sortedItems) {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const quantityCell = document.createElement('td');

        nameCell.textContent = itemName.replace(/_/g, ' ').replace(/(^\w|\s\w)/g, m => m.toUpperCase());
        quantityCell.textContent = fishingItems[itemName].amount.toLocaleString();

        row.appendChild(nameCell);
        row.appendChild(quantityCell);
        tableBody.appendChild(row);
    }
}

function updatePotDisplay() {
    if (!store.get().uiVisible) return;

    const tableBody = document.querySelector('#pots-table tbody');
    tableBody.innerHTML = '';

    const potYieldModifier = {
        "crab": 6,
        "lobster": 2,
        "sand": 3,
    }

    const potExpModifier = {
        "crab": 0.1,
        "lobster": 0.6,
        "sand": 0.3,
    }

    const oneHour = 3600;

    const potsToDisplay = store.get().pots.map(pot => {
        const fishingPerkActive = store.get().config.fishingPerkActive;
        const hours = Math.floor(pot.age / oneHour);    // hours since pot was placed
        const level = Math.floor((Math.sqrt(1 + 8 * store.get().fishingExp / 5) - 1) / 2);
        const peakHours = Math.min(Math.ceil(level / 5) + 2, 22);
        const isReadyForCollection = hours >= (fishingPerkActive ? peakHours / 2 : peakHours);

        let yieldHours;

        const yieldCalcHours = hours;

        // calculate yieldHours
        if (fishingPerkActive) {
            yieldHours = Math.min(yieldCalcHours * 2, peakHours);
        } else {
            if (yieldCalcHours > peakHours) {
                const degraded = Math.max(0, -1 + Math.floor((yieldCalcHours - peakHours) / 12));
                yieldHours = Math.max(Math.ceil(peakHours / 2), peakHours - degraded);  // degrade every 12 hours
            } else {
                yieldHours = yieldCalcHours;  // soaking every hour
            }
        }

        // calculate potYield and potExp
        const potYield = (yieldHours + 1) * (potYieldModifier[pot.type] || 6);
        const potExp = potYield * (potExpModifier[pot.type] || 0.1);

        let potState;
        if (fishingPerkActive) {
            potState = isReadyForCollection ? 'Ready' : 'Soaking';
        } else {
            if (hours < peakHours) {
                potState = 'Soaking';
            } else if (yieldHours === peakHours) {
                potState = 'Ready';
            } else if (yieldHours <= Math.ceil(peakHours / 2)) {
                potState = 'Degraded';
            } else {
                potState = 'Degrading';
            }
        }

        return {
            ...pot,
            isReady: isReadyForCollection,
            state: potState,
            yield: potYield,
            distance: calculateDistance(store.get().playerPosition, pot.position)
        };
    });

    // Sorting logic
    potsToDisplay.sort((a, b) => {
        let compareA = a[store.get().config.sortBy];
        let compareB = b[store.get().config.sortBy];

        if (store.get().config.sortBy === 'state') {
            compareA = a.isReady;
            compareB = b.isReady;
        }

        if (typeof compareA === 'string') {
            return store.get().config.sortOrder === 'asc' ? compareA.localeCompare(compareB) : compareB.localeCompare(compareA);
        } else {
            return store.get().config.sortOrder === 'asc' ? compareA - compareB : compareB - compareA;
        }
    });

    potsToDisplay.forEach(pot => {
        const row = document.createElement('tr');
        const stateClass = `status-${pot.state.toLowerCase()}`;
        row.innerHTML = `
                <td>${pot.id}</td>
                <td>${pot.type}</td>
                <td>${pot.distance.toFixed(0)}</td>
                <td title="Click to set waypoint">${pot.position.x.toFixed(0)}, ${pot.position.y.toFixed(0)}</td>
                <td class="${stateClass}">${pot.state}</td>
                <td>${formatTime(pot.age)}</td>
                <td>${pot.yield}</td>
            `;
        row.style.cursor = 'pointer';
        row.onclick = () => sendCommand({ type: 'setWaypoint', x: pot.position.x, y: pot.position.y });
        tableBody.appendChild(row);
        addPotBlip(pot);
    });
    // update blips only if pot state is changed
    potsToDisplay.forEach(pot => {
        if (store.get().potBlips.length === 0) return;
        if (pot.state !== store.get().potBlips.find(blip => blip.id === `afh_blip${pot.id}`)?.state) {
            store.set({ blipsNeedUpdate: 1 });
        }
    });
    if (store.get().blipsNeedUpdate === 1) {
        notifyPlayer('Pot state changed, updating blips', 'success');
        clearPotBlips();
        store.set({ blipsNeedUpdate: 0 });
    }
    else if (store.get().blipsNeedUpdate === 0) {
        notifyPlayer('Blips are updated', 'success');
        updatePotBlips();
        store.set({ blipsNeedUpdate: 2 });
    }
}

function clearWaypointHandler() {
    sendCommand({ type: 'setWaypoint', x: store.get().playerPosition.x, y: store.get().playerPosition.y });
}

function calculateDistance(pos1, pos2) {
    if (!pos1 || !pos2) return 0;
    return Math.sqrt(Math.pow(pos1.x - pos2.x, 2) + Math.pow(pos1.y - pos2.y, 2));
}

function formatTime(seconds) {
    if (seconds <= 0) return "00:00:00";
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function getWeatherInfo(weatherName) {
    if (!weatherName) {
        return { text: 'N/A', rating: 0, bonus: 0 };
    }

    let info = { text: weatherName, rating: 1, bonus: 0, icon: '' }; // Default

    switch (weatherName) {
        case 'THUNDER':
            info = { text: 'Stormy', rating: 5, bonus: 40, icon: '⛈️' };
            break;
        case 'RAIN':
            info = { text: 'Rainy', rating: 4, bonus: 20, icon: '🌧️' };
            break;
        case 'CLEARING':
            info = { text: 'Drizzly', rating: 3, bonus: 10, icon: '🌦️' };
            break;
        case 'OVERCAST':
        case 'CLOUDS':
            info = { text: 'Cloudy', rating: 2, bonus: 0, icon: '🌥️' };
            break;
        case 'CLEAR':
        case 'EXTRASUNNY':
            info = { text: 'Sunny', rating: 1, bonus: 0, icon: '☀️' };
            break;
        case 'SMOG':
            info = { text: 'Smoggy', rating: 1, bonus: 0, icon: '🌫️' };
            break;
        case 'FOGGY':
            info = { text: 'Foggy', rating: 1, bonus: 0, icon: '🌫️' };
            break;
        case 'XMAS':
            info = { text: 'Christmas', rating: 1, bonus: 0, icon: '🎄' };
            break;
        case 'SNOW':
            info = { text: 'Snowy', rating: 1, bonus: 0, icon: '❄️' };
            break;
        case 'SNOWLIGHT':
            info = { text: 'Light Snow', rating: 1, bonus: 0, icon: '🌨️' };
            break;
        case 'BLIZZARD':
            info = { text: 'Blizzard', rating: 1, bonus: 0, icon: '🌨️' };
            break;
        case 'HALLOWEEN':
            info = { text: 'Halloween', rating: 1, bonus: 0, icon: '🎃' };
            break;
        case 'NEUTRAL':
            info = { text: 'Neutral', rating: 1, bonus: 0, icon: '🌤️' };
            break;
        case 'RAIN_HALLOWEEN':
            info = { text: 'Spooky Rain', rating: 1, bonus: 0, icon: '🌧️🎃' };
            break;
        case 'SNOW_HALLOWEEN':
            info = { text: 'Spooky Snow', rating: 1, bonus: 0, icon: '❄️🎃' };
            break;
        default:
            info = { text: weatherName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), rating: 1, bonus: 0, icon: '🤷‍♂️' };
            break;
    }
    info.text = info.text.charAt(0).toUpperCase() + info.text.slice(1).toLowerCase();

    return info;
}

function makeDraggable(windowElement) {
    const header = windowElement.querySelector('.window-header');
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = (e) => {
        e = e || window.event;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (e) => {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            windowElement.style.top = (windowElement.offsetTop - pos2) + "px";
            windowElement.style.left = (windowElement.offsetLeft - pos1) + "px";
        };
    };
}

function toggleWindow(windowId) {
    const windowEl = document.getElementById(windowId);
    const toggleButton = windowEl.querySelector('.toggle-button');
    const isMinimized = windowEl.classList.toggle('minimized');
    toggleButton.innerHTML = isMinimized ? '&#9633;' : '_'; // Square symbol for maximize
}

function togglePin(windowId) {
    const windowEl = document.getElementById(windowId);
    const pinButton = windowEl.querySelector('.pin-button');
    const isPinned = windowEl.classList.toggle('pinned');
    pinButton.classList.toggle('pinned', isPinned);
    pinButton.innerHTML = isPinned ? '&#128205;' : '&#128204;'; // Round pin for pinned

    if (isPinned) {
        if (!store.get().pinnedWindows.includes(windowId)) {
            store.set({ pinnedWindows: [...store.get().pinnedWindows, windowId] });
        }
    } else {
        const index = store.get().pinnedWindows.indexOf(windowId);
        if (index > -1) {
            store.set({ pinnedWindows: store.get().pinnedWindows.filter((_, i) => i !== index) });
        }
    }
    localStorage.setItem('pinnedWindows', JSON.stringify(store.get().pinnedWindows));
}

function openDebugTab(evt, tabName) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("debug-tab-content");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("debug-tab-button");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    document.getElementById(tabName).style.display = "block";
    evt.currentTarget.className += " active";
}

async function runCommandSequence() {
    notifyPlayer('Starting command sequence');
    await takePotFromTrunk();
}

async function takePotFromTrunk() {
    // Take all pot from trunk
    const chestKey = Object.keys(store.get().allGameData).filter(k => k.includes(store.get().allGameData.chest));
    if (chestKey.length > 0 && chestKey[0].startsWith('chest_')) {
        const chestData = JSON.parse(store.get().allGameData[chestKey[0]]);
        const chestItems = Object.keys(chestData).filter(k => k.startsWith('pot_'));
        if (chestItems.length > 0) {
            for (const item of chestItems) {
                if (item.includes('pot_')) {
                    notifyPlayer(`Taking ${item} from trunk.`, 'info');
                    const takeChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'Take', ['Weightless', 'Repeat']);
                    // notifyPlayer('takeChoice.name: ' + takeChoice.name, 'warning');
                    if (takeChoice.index !== -1) {
                        sendCommand({ type: 'forceMenuChoice', choice: takeChoice.name, mod: -1 });
                    }
                    await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('take'));
                    const takePotChoice = findItemIndexBySubstring(store.get().allGameData.menu_choices, 'pot');
                    //notifyPlayer('takePotChoice.name: ' + takePotChoice.name, 'warning');
                    if (takePotChoice.index !== -1) {
                        sendCommand({ type: 'forceMenuChoice', choice: takePotChoice.name, mod: -1 });
                    }
                    else {
                        notifyPlayer('Could not find \'pot\' option in trunk.', 'error');
                    }
                }
            }
        }
        await waitForCondition(() => store.get().allGameData.menu_open && store.get().allGameData.menu?.toLowerCase().includes('trunk'));
        sendCommand({ type: 'forceMenuBack' });
    }
}

async function autoGutFish() {
    if (store.get().config.autoGut) {
        notifyPlayer('Starting auto-gut sequence', 'info');
        sendCommand({ type: 'sendCommand', command: 'item gut_knife gut' });
        store.set({ inventoryCache: { ...store.get().inventoryCache, fish: 0, fish_pot: 0 } });
    }
}

function updateAppStatus() {
    const isBrowser = window.parent === window;
    if (isBrowser) {
        store.set({ status: false });
        document.getElementById('status').textContent = 'Mock Mode';
    } else {
        store.set({ status: store.get().isFisherman });
        document.getElementById('status').textContent = store.get().isFisherman ? 'Active' : 'Inactive';
    }
}

function initialize() {
    document.querySelectorAll('.window').forEach(makeDraggable);

    // Load settings
    store.set({
        config: {
            fishingPerkActive: localStorage.getItem('fishingPerkActive') === 'true',
            autoGut: localStorage.getItem('autoGut') === 'true',
            autoStore: localStorage.getItem('autoStore') === 'true',
            activateBlips: localStorage.getItem('activateBlips') === 'true',
            autoHide: localStorage.getItem('autoHide') === 'true',
            apiMode: localStorage.getItem('apiMode') || 'mock',
            apiKey: localStorage.getItem('apiKey') || '',
            sortBy: localStorage.getItem('sortBy') || 'distance',
            sortOrder: localStorage.getItem('sortOrder') || 'asc',
            autoPlacePots: localStorage.getItem('autoPlacePots') === 'true'
        }
    });
    store.set({ pinnedWindows: JSON.parse(localStorage.getItem('pinnedWindows') || '[]') });

    // Apply settings to UI
    document.getElementById('perk-active').checked = store.get().config.fishingPerkActive;
    document.getElementById('auto-gut').checked = store.get().config.autoGut;
    document.getElementById('auto-store').checked = store.get().config.autoStore;
    document.getElementById('activate-blips').checked = store.get().config.activateBlips;
    document.getElementById('auto-hide').checked = store.get().config.autoHide;
    document.getElementById('api-mode').value = store.get().config.apiMode;
    document.getElementById('api-key').value = store.get().config.apiKey;
    document.getElementById('api-key-container').style.display = store.get().config.apiMode === 'real' ? 'block' : 'none';
    document.getElementById('sort-by').value = store.get().config.sortBy;
    document.getElementById('sort-order').value = store.get().config.sortOrder;
    document.getElementById('auto-place-pots').checked = store.get().config.autoPlacePots;

    store.get().pinnedWindows.forEach(windowId => {
        const windowEl = document.getElementById(windowId);
        if (windowEl) {
            windowEl.classList.add('pinned');
            const pinButton = windowEl.querySelector('.pin-button');
            pinButton.classList.add('pinned');
            pinButton.innerHTML = '&#128205;';
        }
    });

    // Add event listeners
    const saveSettingsBtn = document.getElementById('save-settings-btn');
    const settingsInputs = [
        document.getElementById('perk-active'),
        document.getElementById('auto-gut'),
        document.getElementById('auto-store'),
        document.getElementById('auto-place-pots'),
        document.getElementById('activate-blips'),
        document.getElementById('auto-hide'),
        document.getElementById('api-mode'),
        document.getElementById('api-key'),
        document.getElementById('sort-by'),
        document.getElementById('sort-order')
    ];

    const getCurrentSettingsFromUI = () => ({
        fishingPerkActive: document.getElementById('perk-active').checked,
        autoGut: document.getElementById('auto-gut').checked,
        autoStore: document.getElementById('auto-store').checked,
        autoPlacePots: document.getElementById('auto-place-pots').checked,
        activateBlips: document.getElementById('activate-blips').checked,
        autoHide: document.getElementById('auto-hide').checked,
        apiMode: document.getElementById('api-mode').value,
        apiKey: document.getElementById('api-key').value,
        sortBy: document.getElementById('sort-by').value,
        sortOrder: document.getElementById('sort-order').value
    });

    const settingsChanged = () => {
        const currentSettings = getCurrentSettingsFromUI();
        const savedSettings = store.get().config;
        let hasChanged = false;
        for (const key in currentSettings) {
            if (currentSettings[key] !== savedSettings[key]) {
                hasChanged = true;
                if(DEBUG_MODE) console.log('settingsChanged: ' + key);
                break;
            }
        }
        if (hasChanged) {
            saveSettingsBtn.classList.add('blink');
        } else {
            saveSettingsBtn.classList.remove('blink');
        }
    };

    settingsInputs.forEach(input => {
        const eventType = input.type === 'checkbox' || input.tagName.toLowerCase() === 'select' ? 'onchange' : 'oninput';
        input[eventType] = settingsChanged;
    });

    saveSettingsBtn.onclick = () => {
        store.set({
            config: getCurrentSettingsFromUI()
        });
        localStorage.setItem('fishingPerkActive', store.get().config.fishingPerkActive);
        localStorage.setItem('autoGut', store.get().config.autoGut);
        localStorage.setItem('autoStore', store.get().config.autoStore);
        localStorage.setItem('activateBlips', store.get().config.activateBlips);
        localStorage.setItem('autoHide', store.get().config.autoHide);
        localStorage.setItem('apiMode', store.get().config.apiMode);
        localStorage.setItem('apiKey', store.get().config.apiKey);
        localStorage.setItem('sortBy', store.get().config.sortBy);
        localStorage.setItem('sortOrder', store.get().config.sortOrder);
        localStorage.setItem('autoPlacePots', store.get().config.autoPlacePots);
        localStorage.setItem('pinnedWindows', JSON.stringify(store.get().pinnedWindows));
        const statusEl = document.getElementById('api-status');
        statusEl.textContent = 'Settings saved!';
        statusEl.style.backgroundColor = 'var(--success-color)';
        saveSettingsBtn.classList.remove('blink');

        // update blips if activate blips is changed
        clearPotBlips();
        updatePotDisplay();
    };

    const handleSortChange = () => {
        store.set({
            config: {
                ...store.get().config,
                sortBy: document.getElementById('sort-by').value,
                sortOrder: document.getElementById('sort-order').value
            }
        });
        localStorage.setItem('sortBy', store.get().config.sortBy);
        localStorage.setItem('sortOrder', store.get().config.sortOrder);
        updatePotDisplay();
    };

    document.getElementById('api-mode').onchange = (e) => {
        document.getElementById('api-key-container').style.display = e.target.value === 'real' ? 'block' : 'none';
        settingsChanged();
    };
    document.getElementById('fetch-pots-btn').onclick = fetchPotData;
    document.getElementById('sort-by').onchange = handleSortChange;
    document.getElementById('sort-order').onchange = handleSortChange;
    document.getElementById('send-command-btn').onclick = () => {
        const commandText = document.getElementById('command-json').value;
        try {
            const command = JSON.parse(commandText);
            sendCommand(command);
        } catch (e) {
            notifyPlayer('Error: Invalid JSON in command sender.', 'error');
        }
    };
    document.getElementById('run-sequence-btn').onclick = runCommandSequence;
    document.getElementById('clear-blips-btn').onclick = clearPotBlips;
    document.getElementById('update-blips-btn').onclick = updatePotBlips;
    window.addEventListener("message", (event) => {
        if (event.data && event.data.data) {
            handleGameData(event.data.data);
        }
        // Notification handling
        if (event.data && event.data.data.notification) {
            handleNotification(event.data.data.notification);
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === "Escape") sendCommand({ type: "pin" });
        if (e.key === "h" || e.key === "H") sendCommand({ type: "close" });
    });

    setInterval(() => {
        if (store.get().uiVisible) {
            store.get().pots.forEach(pot => pot.age++);
            updatePotDisplay();
        }
    }, 1000);


    // Load cached pot data on startup
    const cachedPotsRaw = localStorage.getItem('cachedPots');
    if (cachedPotsRaw) {
        try {
            const cachedPots = JSON.parse(cachedPotsRaw);
            const dataAgeHours = (Date.now() - cachedPots.timestamp) / (1000 * 3600);
            const collectionTimeHours = store.get().config.fishingPerkActive ? 11 : 22;

            if (dataAgeHours > collectionTimeHours) {
                document.getElementById('pot-warning').style.display = 'block';
            }

            // Adjust age based on time passed since last fetch
            cachedPots.data.forEach(pot => {
                pot.age += Math.floor((Date.now() - cachedPots.timestamp) / 1000);
            });
            handlePotData(cachedPots.data);

        } catch (e) {
            notifyPlayer('Could not load cached pot data.', 'error');
        }
    }

    if (window.parent === window) {
        store.set({ uiVisible: true });
        document.getElementById('main-container').style.display = 'block';
        handleGameData({
            job: 'fisher', job_name: 'Fisher', vehicleClass: 14, vehicleName: 'Tropic',
            pos_x: 4000, pos_y: -5000, 'exp_farming_fishing': 250,  // 340: 11 level, peak 5 hours;  250: 9 level, peak 4 hours
            inventory: JSON.stringify({ "pot_crab": { "amount": 10 }, "fish_tuna": { "amount": 5 } }),
            "chest_self_storage:12345:home:chest": JSON.stringify({ "pot_lobster": { "amount": 5 } }),
            weather: 'THUNDER',
            weather_forecast: 'RAIN',
            boat: 'Tropic'
        });
        fetchPotData();
        handleInventoryChange(); // Initialize inventory cache
    } else {
        sendCommand({ type: "getData" });
        store.set({ playerSpawned: true });
    }
    updateAppStatus();
    notifyPlayer('Advanced Fishing Helper Initialized.', 'success');
}

function delayedInitialize() {
    if (window.parent !== window) {
        setTimeout(() => {
            initialize();
        }, 1000);
    }
    else {
        initialize();
    }
}

// Initialize the app
window.onload = delayedInitialize;
