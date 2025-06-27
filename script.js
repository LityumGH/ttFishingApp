// --- CONSTANTS ---
const API_BASE_URL = 'https://tycoon-2epova.users.cfx.re/status';
const DEBUG_MODE = true; // Set to true to show all windows and extra logs

// --- STATE MANAGEMENT ---
const state = {
    isFisherman: false,
    isInBoat: false,
    uiVisible: false,
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
        apiMode: 'mock',
        apiKey: '',
        sortBy: 'distance',
        sortOrder: 'asc'
    },
    pinnedWindows: [],
    previousPotCount: 0
};

// --- CORE LOGIC ---

function sendCommand(command) {
    if (state.config.apiMode === 'mock' && window.parent === window) {
        if (command.type === 'notification') {
            console.log(`NOTIFICATION: ${command.text}`);
        } else {
            console.log("MOCK: Sent Command:", command);
        }
        return;
    }
    window.parent.postMessage(command, "*");
}

function handleGameData(data) {
    Object.assign(state.allGameData, data);
    if (DEBUG_MODE) {
        document.getElementById('debug-data').textContent = JSON.stringify(state.allGameData, null, 2);
    }

    let needsUiUpdate = false;

    if (data.job !== undefined) {
        state.isFisherman = data.job === 'fisher';
        document.getElementById('job-name').textContent = data.job_name || 'N/A';
    }

    if (data.vehicleClass !== undefined || data.vehicleName !== undefined) {
        state.isInBoat = data.vehicleClass === 14;
        document.getElementById('vehicle-name').textContent = state.isInBoat ? (data.vehicleName || state.allGameData.vehicleName || 'Unknown Boat') : 'N/A';
    }

    if (data.pos_x !== undefined && data.pos_y !== undefined) {
        state.playerPosition = { x: data.pos_x, y: data.pos_y };
        needsUiUpdate = true;
    }

    if (data['exp_farming_fishing'] !== undefined) {
        state.fishingExp = data['exp_farming_fishing'];
        document.getElementById('fishing-exp').textContent = state.fishingExp.toLocaleString();
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
    if (inventoryKeys.length > 0) {
        updateCombinedInventoryDisplay();
    }

    if (data.trigger_fish_caught && state.config.autoGut) {
        triggerAutoGut();
    }

    if (data.horn === true) {
        checkForPotCollection();
    }

    if (data.focused !== undefined || data.pinned !== undefined) {
        updateWindowVisibility();
    }

    if (needsUiUpdate) {
        updatePotDisplay();
    }
}

async function fetchPotData() {
    const statusEl = document.getElementById('api-status');
    statusEl.textContent = 'Fetching...';
    statusEl.style.backgroundColor = '#555';

    if (state.config.apiMode === 'mock') {
        const mockResponse = [{ "position": { "x": 4890.92, "z": 0.16, "y": -5149.52 }, "type": "crab", "age": 5091 }, { "position": { "x": 4766.66, "z": 0.17, "y": -5172.90 }, "type": "lobster", "age": 79201 }];
        handlePotData(mockResponse);
        localStorage.setItem('cachedPots', JSON.stringify({ timestamp: Date.now(), data: mockResponse }));
        statusEl.textContent = 'Mock data loaded.';
        statusEl.style.backgroundColor = 'var(--success-color)';
        return;
    }

    if (!state.config.apiKey) {
        statusEl.textContent = 'Error: API Key is missing.';
        statusEl.style.backgroundColor = 'var(--error-color)';
        return;
    }

    const apiUrl = `${API_BASE_URL}/deadliest_catch.json`;
    const headers = { 'X-Tycoon-Key': state.config.apiKey };

    try {
        const response = await fetch(apiUrl, { headers });
        if (response.ok) {
            const potsData = await response.json();
            handlePotData(potsData);
            localStorage.setItem('cachedPots', JSON.stringify({ timestamp: Date.now(), data: potsData }));
            statusEl.textContent = `Pots loaded: ${potsData.length}`;
            statusEl.style.backgroundColor = 'var(--success-color)';
        } else {
            statusEl.textContent = `API Error: ${response.status}`;
            statusEl.style.backgroundColor = 'var(--error-color)';
            sendCommand({ type: 'notification', text: `API Error: ${response.status}` });
        }
    } catch (error) {
        statusEl.textContent = 'Network Error';
        statusEl.style.backgroundColor = 'var(--error-color)';
        sendCommand({ type: 'notification', text: `Fetch Error: ${error.message}` });
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

    if (newPots.length > state.lastPotsData.length && state.lastPotsData.length > 0) {
        const collectionDurationHours = state.config.fishingPerkActive ? 11 : 22;
        const readyDate = new Date(now.getTime() + collectionDurationHours * 60 * 60 * 1000);
        const readyTimeStr = readyDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        sendCommand({ type: 'notification', text: `Pot #${newPots.length} placed. Ready at ${readyTimeStr}` });
    }

    state.pots = newPots;
    state.lastPotsData = potsData;
    updatePotDisplay();
}

// --- AUTOMATION ---

function checkForPotCollection() {
    if (state.pots.length === 0 || !state.playerPosition) return;

    const closestPot = state.pots.reduce((closest, pot) => {
        const distance = calculateDistance(state.playerPosition, pot.position);
        if (distance < closest.distance) {
            return { pot, distance };
        }
        return closest;
    }, { pot: null, distance: Infinity });

    if (closestPot.distance > 10) return;

    let currentPotCount = 0;
    const itemsToCount = ['pot_crab', 'pot_lobster'];
    for (const key in state.allGameData) {
        if (key.startsWith('inventory')) {
            try {
                const inventory = JSON.parse(state.allGameData[key]);
                for (const itemName in inventory) {
                    const cleanName = itemName.split('|')[0];
                    if (itemsToCount.includes(cleanName)) {
                        currentPotCount += inventory[itemName].amount;
                    }
                }
            } catch (e) { /* Ignore */ }
        }
    }

    if (currentPotCount > state.previousPotCount) {
        const collectedPotType = closestPot.pot ? closestPot.pot.type : 'pot';
        sendCommand({ type: 'notification', text: `Collected one ${collectedPotType} pot.` });
        
        // Optimistically remove the pot and refetch in the background
        const potIndex = state.pots.findIndex(p => p.id === closestPot.pot.id);
        if (potIndex > -1) {
            state.pots.splice(potIndex, 1);
        }
        updatePotDisplay(); // Update UI immediately
        fetchPotData(); // Fetch fresh data from API
    }
    state.previousPotCount = currentPotCount;
}

function detectNewFish() {
    if (!state.config.autoGut || !state.allGameData.inventory) return;

    try {
        const currentInventory = JSON.parse(state.allGameData.inventory);
        const currentFishCount = Object.keys(currentInventory).filter(item => item.startsWith('fish_')).length;
        const previousFishCount = Object.keys(state.previousInventory || {}).filter(item => item.startsWith('fish_')).length;

        if (currentFishCount > previousFishCount) {
            sendCommand({ type: 'notification', text: 'New fish detected!' });
            triggerAutoGut();
        }
        state.previousInventory = currentInventory;
    } catch (e) { /* ignore parse error */ }
}

function triggerAutoGut() {
    sendCommand({ type: 'notification', text: 'Triggering auto gut...' });
    sendCommand({ type: 'sendCommand', command: 'item gut_knife gut' });
    if (state.config.autoStore) {
        setTimeout(triggerAutoStore, 1500);
    }
}

function triggerAutoStore() {
    if (state.isInBoat) {
        sendCommand({ type: 'notification', text: 'Triggering auto store...' });
        sendCommand({ type: 'sendCommand', command: 'rm_trunk' });
        sendCommand({ type: 'notification', text: 'Trunk opened for fish meat.' });
    }
}

// --- UI UPDATE FUNCTIONS ---

function updateWindowVisibility() {
    const isBrowser = window.parent === window;
    const shouldBeVisible = DEBUG_MODE || isBrowser || !state.config.autoHide || (state.isFisherman && state.isInBoat);

    if (shouldBeVisible) {
        if (!state.uiVisible) {
            state.uiVisible = true;
            document.getElementById('main-container').style.display = 'block';
            document.getElementById('status').textContent = isBrowser ? 'Mock Mode' : 'Active';
        }
    } else {
        if (state.uiVisible) {
            state.uiVisible = false;
            document.getElementById('main-container').style.display = 'none';
            document.getElementById('status').textContent = 'Inactive';
        }
    }

    const isAppFocused = state.allGameData.focused === true;
    const isAppPinnedByGame = state.allGameData.pinned === true;

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

    for (const key in state.allGameData) {
        if (key.startsWith('inventory') || key.startsWith('chest_')) {
            try {
                const inventory = JSON.parse(state.allGameData[key]);
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
    if (!state.uiVisible) return;

    const tableBody = document.querySelector('#pots-table tbody');
    tableBody.innerHTML = '';

    const maxYield = 138;
    const collectionTimePerk = 11 * 3600;
    const collectionTimeNoPerk = 22 * 3600;

    const potsToDisplay = state.pots.map(pot => {
        let potYield, potState;
        const isReadyForCollection = state.config.fishingPerkActive 
            ? pot.age >= collectionTimePerk 
            : pot.age >= collectionTimeNoPerk;

        if (state.config.fishingPerkActive) {
            const hourlyRate = maxYield / 11;
            potYield = Math.min(maxYield, Math.floor((pot.age / 3600) * hourlyRate));
            potState = isReadyForCollection ? 'Ready' : 'Soaking';
        } else {
            const hourlyRate = maxYield / 22;
            const peakCapacityTimeSeconds = 22 * 3600;
            const degradationStartTimeSeconds = peakCapacityTimeSeconds + (24 * 3600); // 46 hours
            const degradationIntervalSeconds = 12 * 3600; // 12 hours
            const degradationSteps = 5; // 5 steps to reach 50% degradation
            const degradationPerStep = (maxYield * 0.5) / degradationSteps; // 10% of max yield (13.8)

            if (pot.age <= peakCapacityTimeSeconds) {
                potYield = Math.floor((pot.age / 3600) * hourlyRate);
                potState = 'Soaking';
            } else if (pot.age <= degradationStartTimeSeconds) {
                potYield = maxYield;
                potState = 'Ready';
            } else {
                const timeSinceDegradationStart = pot.age - degradationStartTimeSeconds;
                const degradationPeriods = Math.floor(timeSinceDegradationStart / degradationIntervalSeconds);

                if (degradationPeriods > 0) {
                    const totalDegradationAmount = degradationPeriods * degradationPerStep;
                    potYield = maxYield - totalDegradationAmount;
                    potYield = Math.max(maxYield * 0.5, potYield); // Cap at 50% loss
                } else {
                    potYield = maxYield;
                }

                if (potYield <= maxYield * 0.5) {
                    potState = 'Degraded';
                } else {
                    potState = 'Degrading';
                }
            }
        }

        return {
            ...pot,
            isReady: isReadyForCollection,
            state: potState,
            yield: Math.floor(potYield),
            distance: calculateDistance(state.playerPosition, pot.position)
        };
    });

    // Sorting logic
    potsToDisplay.sort((a, b) => {
        let compareA = a[state.config.sortBy];
        let compareB = b[state.config.sortBy];

        if (state.config.sortBy === 'state') {
            compareA = a.isReady;
            compareB = b.isReady;
        }

        if (typeof compareA === 'string') {
            return state.config.sortOrder === 'asc' ? compareA.localeCompare(compareB) : compareB.localeCompare(compareA);
        } else {
            return state.config.sortOrder === 'asc' ? compareA - compareB : compareB - compareA;
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
    });
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

    const cleanedName = weatherName.toUpperCase();
    let info = { text: weatherName, rating: 2, bonus: 0 }; // Default

    switch (cleanedName) {
        case 'THUNDER':
            info = { text: 'Stormy', rating: 5, bonus: 40, icon: '⛈️' };
            break;
        case 'RAIN':
            info = { text: 'Rainy', rating: 4, bonus: 20, icon: '🌧️' };
            break;
        case 'OVERCAST':
        case 'CLOUDS':
        case 'CLEARING':
            info = { text: 'Drizzly', rating: 3, bonus: 10, icon: '🌦️' };
            break;
        case 'CLEAR':
        case 'EXTRASUNNY':
            info = { text: 'Sunny', rating: 1, bonus: 0, icon: '☀️' };
            break;
        default:
            info = { text: weatherName.replace(/_/g, ' '), rating: 2, bonus: 0 };
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
        if (!state.pinnedWindows.includes(windowId)) {
            state.pinnedWindows.push(windowId);
        }
    } else {
        const index = state.pinnedWindows.indexOf(windowId);
        if (index > -1) {
            state.pinnedWindows.splice(index, 1);
        }
    }
    localStorage.setItem('pinnedWindows', JSON.stringify(state.pinnedWindows));
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

function initialize() {
    document.querySelectorAll('.window').forEach(makeDraggable);

    // Load settings
    state.config.fishingPerkActive = localStorage.getItem('fishingPerkActive') === 'true';
    state.config.autoGut = localStorage.getItem('autoGut') === 'true';
    state.config.autoStore = localStorage.getItem('autoStore') === 'true';
    state.config.autoHide = localStorage.getItem('autoHide') === 'true';
    state.config.apiMode = localStorage.getItem('apiMode') || 'mock';
    state.config.apiKey = localStorage.getItem('apiKey') || '';
    state.config.sortBy = localStorage.getItem('sortBy') || 'distance';
    state.config.sortOrder = localStorage.getItem('sortOrder') || 'asc';
    state.pinnedWindows = JSON.parse(localStorage.getItem('pinnedWindows') || '[]');

    // Apply settings to UI
    document.getElementById('perk-active').checked = state.config.fishingPerkActive;
    document.getElementById('auto-gut').checked = state.config.autoGut;
    document.getElementById('auto-store').checked = state.config.autoStore;
    document.getElementById('auto-hide').checked = state.config.autoHide;
    document.getElementById('api-mode').value = state.config.apiMode;
    document.getElementById('api-key').value = state.config.apiKey;
    document.getElementById('api-key-container').style.display = state.config.apiMode === 'real' ? 'block' : 'none';
    document.getElementById('sort-by').value = state.config.sortBy;
    document.getElementById('sort-order').value = state.config.sortOrder;

    state.pinnedWindows.forEach(windowId => {
        const windowEl = document.getElementById(windowId);
        if (windowEl) {
            windowEl.classList.add('pinned');
            const pinButton = windowEl.querySelector('.pin-button');
            pinButton.classList.add('pinned');
            pinButton.innerHTML = '&#128205;';
        }
    });

    // Add event listeners
    document.getElementById('save-settings-btn').onclick = () => {
        state.config.fishingPerkActive = document.getElementById('perk-active').checked;
        state.config.autoGut = document.getElementById('auto-gut').checked;
        state.config.autoStore = document.getElementById('auto-store').checked;
        state.config.autoHide = document.getElementById('auto-hide').checked;
        state.config.apiMode = document.getElementById('api-mode').value;
        state.config.apiKey = document.getElementById('api-key').value;
        localStorage.setItem('fishingPerkActive', state.config.fishingPerkActive);
        localStorage.setItem('autoGut', state.config.autoGut);
        localStorage.setItem('autoStore', state.config.autoStore);
        localStorage.setItem('autoHide', state.config.autoHide);
        localStorage.setItem('apiMode', state.config.apiMode);
        localStorage.setItem('apiKey', state.config.apiKey);
        const statusEl = document.getElementById('api-status');
        statusEl.textContent = 'Settings saved!';
        statusEl.style.backgroundColor = 'var(--success-color)';
    };

    const handleSortChange = () => {
        state.config.sortBy = document.getElementById('sort-by').value;
        state.config.sortOrder = document.getElementById('sort-order').value;
        localStorage.setItem('sortBy', state.config.sortBy);
        localStorage.setItem('sortOrder', state.config.sortOrder);
        updatePotDisplay();
    };

    document.getElementById('api-mode').onchange = (e) => {
        document.getElementById('api-key-container').style.display = e.target.value === 'real' ? 'block' : 'none';
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
            sendCommand({ type: 'notification', text: 'Error: Invalid JSON in command sender.' });
        }
    };

    window.addEventListener("message", (event) => {
        if (event.data && event.data.data) {
            handleGameData(event.data.data);
        }
    });

    window.addEventListener('keydown', (e) => { if (e.key === "Escape") sendCommand({ type: "pin" }); });

    setInterval(() => {
        if (state.uiVisible) {
            state.pots.forEach(pot => pot.age++);
            updatePotDisplay();
        }
    }, 1000);

    sendCommand({ type: 'notification', text: 'Advanced Fishing Helper Initialized.' });

    // Load cached pot data on startup
    const cachedPotsRaw = localStorage.getItem('cachedPots');
    if (cachedPotsRaw) {
        try {
            const cachedPots = JSON.parse(cachedPotsRaw);
            const dataAgeHours = (Date.now() - cachedPots.timestamp) / (1000 * 3600);
            const collectionTimeHours = state.config.fishingPerkActive ? 11 : 22;

            if (dataAgeHours > collectionTimeHours) {
                document.getElementById('pot-warning').style.display = 'block';
            }

            // Adjust age based on time passed since last fetch
            cachedPots.data.forEach(pot => {
                pot.age += Math.floor((Date.now() - cachedPots.timestamp) / 1000);
            });
            handlePotData(cachedPots.data);

        } catch (e) {
            sendCommand({ type: 'notification', text: 'Could not load cached pot data.' });
        }
    }

    if (window.parent === window) {
        state.uiVisible = true;
        document.getElementById('main-container').style.display = 'block';
        handleGameData({
            job: 'fisher', job_name: 'Fisher', vehicleClass: 14, vehicleName: 'Tropic',
            pos_x: 4000, pos_y: -5000, 'exp_farming_fishing': 123456,
            inventory: JSON.stringify({ "pot_crab": { "amount": 10 }, "fish_tuna": { "amount": 5 } }),
            "chest_self_storage:12345:home:chest": JSON.stringify({ "pot_lobster": { "amount": 5 } }),
            weather: 'THUNDER',
            weather_forecast: 'RAIN'
        });
        fetchPotData();
    } else {
        sendCommand({ type: "getData" });
    }
}

initialize();