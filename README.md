
# Advanced Fishing Helper
The Advanced Fishing Helper is a web-based tool designed to assist players in the fishing job. It provides real-time information, automates repetitive tasks, and helps track fishing pot locations and statuses to maximize efficiency and yield.
The application runs as an overlay and provides several windows to display crucial information without obstructing the gameplay.

Application URL: `https://lityumgh.github.io/ttFishingApp/`

Created and Developed by: Lityum

Special thanks to Hagfog for developing and testing some features.


## Features

### Real-time Information Panels:
- **Info Window:** Displays your current job status, fishing experience, boat information, and weather conditions that affect net fishing.
- **Inventory Window:** Shows a combined view of all your fishing-related items from your personal inventory, storages and vehicle trunks.
- **Pots Window:** Tracks your deployed pots, showing their location, age, current yield, and status (Soaking, Ready, Degrading, Degraded).
- **Draggable, Pinnable, and Minimizable Windows:** Customize your UI layout to your preference.
Press **ESC** to pin windows, press **H** to hide all windows.

### Pot Management:
- **Fetch pot data** directly from the server's API.
- **Set waypoints** to pots with a single click on pots list.
- **Sort pots** by various criteria like distance, age, or yield.
- Optional in-game **blips** for pot locations.

### Automation:
- **Auto-Gut Fish:** Automatically guts fish when you receive them.
- **Auto-Store Fish:** Automatically stores gutted fish meat into a nearby vehicle's trunk. Takes Pots back to inventory.
- **Auto-Place Pots:** Automatically places a new pot when you are in a suitable location.

### Settings:
- Enable or disable the **Fishing Perk** setting to adjust pot timers.
- Toggle automation features and UI preferences.
- Enable or disable the **Pot Blips** to track your pot status in map and radar.
- Enable **Auto Hide App** to hide app related stuff when you are not a "Fisher".
- Configure your private API key for data fetching.

# How to Use
- Open the Settings Window.
- Select API Mode:
  - Mock API: For testing or development without a live connection. It uses sample data.
  - Real API: For using your pot data.
- Enter API Key: If you select Real API, you must enter your private API key. This key is required to fetch your personal pot data.
- Select Options that you prefer to use now.
- Save Settings: Click the "Save Settings" button to save changes.
- Click "Fetch Pot Data" button in "Fishing Pots" window to retrieve your pot data using one API charge.

# Limitations:
- Make sure to uncheck "Activate Blips" before unloading or reloading the app. Otherwise, blips will be stuck until you restart the game.
- Blip layering is not consistent, so don't be surprised when a blip is not showing custom color. That is why there is a checkmark that is visible under default blip.
- Make sure to click "Fetch Pot Data" button before starting to collect pots. This ensures reliable operation.
- Do not collect pot before fish gutting bar on bottom right disappears for smoother experience.
- "All Fishing Items" updates with client side updates of storages. For example; if you do not see your inventory, open another storage (such as backpack) to retrieve values from server.
- Only **Crab Pots** are tested. If you happen to use another type of pot, the app may not work properly. The support for other pots are planned.

# Development
- If you would like to see the code, visit [GitHub](https://github.com/LityumGH/ttFishingApp/).