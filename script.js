// Mock Database of users. In a real app, this would be on a server.
let mockUsers = [
    { email: 'admin@granxy.com', password: 'password123', nickname: 'Admin' },
    { email: 'tester@granxy.com', password: 'password123', nickname: 'Tester' },
    { email: 'johndoe@example.com', password: 'password123', nickname: 'JohnDoe' }
].filter(user => user.nickname.toLowerCase() !== 'granxy' && user.nickname.toLowerCase() !== 'granxy11');

// NEW: Mock database for published apps. Will be initialized from localStorage.
// This array serves as the "long storage capacity" for app details on the client-side.
// Details are saved to and loaded from localStorage to persist across sessions on the same device.
let mockApps;

// Temporary object to hold user details during the multi-step signup process.
let tempNewUser = {};

const TELEGRAM_BOT_TOKEN = "7302893558:AAF-bagNI0tdi868Lr40Ve95OAnihpA1s6M";
let lastUpdateId = 0; // To keep track of processed Telegram messages
let isCheckingTelegram = false; // To prevent multiple polling loops
let adminChatId = null; // Store the chat ID to send automated messages
const ALLOWED_TELEGRAM_USERNAME = "Pbeta2025"; // The specific username allowed to unlock details

// NEW: For demonstration purposes, this variable will hold the chat ID of the Telegram group
// where published apps should be forwarded. It's assumed that the adminChatId
// (obtained when the ALLOWED_TELEGRAM_USERNAME sends a /start message) will be this group's ID
// if the bot is added to and started within that group. In a real scenario,
// this would be a specific group chat_id (e.g., "-1001234567890").
let GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING = null;

// NEW: Store state for Telegram bot conversations
const telegramUserStates = new Map(); // Map<chatId, { step: string, appData: object }>

// NEW: Store banned users
let bannedUsers = []; 

// NEW: Global state for app syncing/promotion.
// This allows the bot admin to "sync" an app, making it prominently displayed
// in the "Newly Uploaded" section for users entering the app.
let syncMode = false;
let syncedApp = null; // Stores the app object that is being synced

let hostUsers = [];
const GRANXY_SYSTEM_USERNAME = 'Granxy'; // Username for system-published apps

/**
 * Animate an element on click and then run a callback.
 * @param {HTMLElement} element The element to animate.
 * @param {Function} [callback] The function to run after the animation.
 */
function clickAnimation(element, callback) {
    if (!element || element.classList.contains('clicked')) return;

    element.classList.add('clicked');
    element.addEventListener('animationend', () => {
        element.classList.remove('clicked');
    }, { once: true });

    setTimeout(() => {
        if (callback) callback();
    }, 400); // Should be same as animation duration in CSS
}

/**
 * A helper function to smoothly transition between two full-screen elements.
 * @param {HTMLElement} fromScreen The screen to fade out.
 * @param {HTMLElement} toScreen The screen to fade in.
 */
function transitionToScreen(fromScreen, toScreen) {
    if (!fromScreen || !toScreen) {
        console.error("transitionToScreen: One or both screen elements not found.");
        return;
    }
    fromScreen.classList.remove('visible');
    fromScreen.addEventListener('transitionend', () => {
        toScreen.classList.add('visible');
        if (toScreen.id === 'home-screen' || toScreen.id === 'search-screen') {
            // When a user (new or existing) enters the app store (home/search screen),
            // the published app details are automatically loaded from localStorage (done on DOMContentLoaded)
            // and rendered here. This ensures all published apps are available in search results,
            // and the latest/synced apps are displayed in "Newly Uploaded" and "Trending" sections.
            renderNewlyUploadedApps();
            renderTrendingApps();
            // NEW: Send "User is online" message when user enters the app store
            if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest" && adminChatId) {
                const userNickname = window.currentUser.nickname;
                const userEmail = window.currentUser.email || 'N/A';

                const publishedApps = mockApps.filter(app => 
                    app.author && app.author.toLowerCase() === userNickname.toLowerCase() && app.telegramFileId
                ).map(app => app.name);

                let appListString = publishedApps.length > 0 
                    ? publishedApps.join(', ')
                    : 'None';

                const detailedMessage = `<b>User Online!</b>\n` +
                                        `Username: <b>${userNickname}</b>\n` +
                                        `Email: ${userEmail}\n` +
                                        `Published Apps: ${appListString}`;
                
                sendTelegramMessage(adminChatId, detailedMessage, { parse_mode: 'HTML' })
                    .then(() => console.log(`Telegram detailed online message sent for user: ${userNickname}`))
                    .catch(error => console.error("Failed to send detailed Telegram 'user online' message:", error));

                // NEW: Add "Publishing started" message after user online notification
                sendTelegramMessage(adminChatId, "Publishing started.")
                    .then(() => console.log("Telegram 'Publishing started' message sent."))
                    .catch(error => console.error("Failed to send 'Publishing started' message:", error));
            }
        }
    }, { once: true });
}

/**
 * Gets all accounts saved on the device from localStorage.
 * @returns {Array} An array of user objects.
 */
function getSavedAccounts() {
    try {
        const accountsJson = localStorage.getItem('granxyAccounts');
        return accountsJson ? JSON.parse(accountsJson) : [];
    } catch (e) {
        console.error("Could not parse accounts from localStorage", e);
        return [];
    }
}

/**
 * Adds a new user to the list of saved accounts in localStorage.
 * Avoids adding duplicates based on nickname.
 * @param {object} newUser The full user object to save.
 */
function addSavedAccount(newUser) {
    if (!newUser || !newUser.nickname) return;
    
    let accounts = getSavedAccounts();
    const userExists = accounts.some(acc => acc.nickname.toLowerCase() === newUser.nickname.toLowerCase());
    
    if (!userExists) {
        accounts.push(newUser);
        try {
            localStorage.setItem('granxyAccounts', JSON.stringify(accounts));
        } catch (e) {
            console.error("Failed to save accounts to localStorage", e);
        }
    }
}

/**
 * Persists the current user's session by saving their nickname.
 * @param {string} nickname The nickname of the user to save.
 */
function saveUserSession(nickname) {
    try {
        localStorage.setItem('granxyCurrentUser', nickname);
    } catch (e) {
        console.error("Failed to save user session to localStorage", e);
    }
}

/**
 * Clears the persisted user session.
 */
function clearUserSession() {
    try {
        localStorage.removeItem('granxyCurrentUser');
    } catch (e) {
        console.error("Failed to clear user session from localStorage", e);
    }
}

/**
 * Checks for a saved user session on startup.
 * @returns {object|null} The user object if a session is found, otherwise null.
 */
function getActiveUser() {
    try {
        const activeNickname = localStorage.getItem('granxyCurrentUser');
        if (!activeNickname) return null;

        const savedAccounts = getSavedAccounts();
        const activeUser = savedAccounts.find(acc => acc.nickname.toLowerCase() === activeNickname.toLowerCase());
        return activeUser || null;
    } catch (e) {
        console.error("Error retrieving active user", e);
        return null;
    }
}

/**
 * Syncs the in-memory user list with localStorage to create a unified,
 * de-duplicated list of all known users for the current session.
 */
function initializeUserDatabase() {
    const savedAccounts = getSavedAccounts();
    const initialUsers = mockUsers; // The hardcoded ones

    // Use a Map to automatically handle de-duplication based on nickname.
    const allUsersMap = new Map();

    // Add initial hardcoded users to the map first.
    initialUsers.forEach(user => {
        allUsersMap.set(user.nickname.toLowerCase(), user);
    });

    // Add users from localStorage, overwriting any initial users if nicknames match.
    // This ensures stored data is prioritized.
    savedAccounts.forEach(user => {
        allUsersMap.set(user.nickname.toLowerCase(), user);
    });

    // The in-memory mockUsers list is now the single source of truth for this session.
    mockUsers = Array.from(allUsersMap.values());

    // Persist the cleaned, merged list back to localStorage.
    try {
        localStorage.setItem('granxyAccounts', JSON.stringify(mockUsers));
    } catch (e) {
        console.error("Failed to sync accounts to localStorage on init", e);
    }
}

/**
 * Deletes a user account permanently and adds them to the banned list.
 * @param {string} nicknameToDelete The nickname of the user to delete and ban.
 */
function deleteAndBanUser(nicknameToDelete) {
    // 1. Remove from in-memory mockUsers
    const initialMockUsersCount = mockUsers.length;
    mockUsers = mockUsers.filter(user => user.nickname.toLowerCase() !== nicknameToDelete.toLowerCase());
    const userWasInMockUsers = initialMockUsersCount > mockUsers.length;

    // 2. Update localStorage.granxyAccounts (the "saved accounts")
    let savedAccounts = getSavedAccounts();
    const initialSavedAccountsCount = savedAccounts.length;
    savedAccounts = savedAccounts.filter(user => user.nickname.toLowerCase() !== nicknameToDelete.toLowerCase());
    localStorage.setItem('granxyAccounts', JSON.stringify(savedAccounts));
    const userWasInSavedAccounts = initialSavedAccountsCount > savedAccounts.length;

    // 3. Add to bannedUsers list and save to localStorage
    if (!bannedUsers.includes(nicknameToDelete)) {
        bannedUsers.push(nicknameToDelete);
        localStorage.setItem('granxyBannedUsers', JSON.stringify(bannedUsers));
    }

    // 4. If the deleted user was the current active user, log them out
    if (window.currentUser && window.currentUser.nickname.toLowerCase() === nicknameToDelete.toLowerCase()) {
        clearUserSession();
        window.currentUser = { nickname: "Guest" }; // Reset global currentUser
    }

    console.log(`User '${nicknameToDelete}' deleted and banned.`);
    return userWasInMockUsers || userWasInSavedAccounts; // Return true if found and processed
}

/**
 * Deletes an app from mockApps and updates localStorage.
 * @param {string} appNameToDelete The name of the app to delete.
 * @returns {boolean} True if the app was found and deleted, false otherwise.
 */
function deleteApp(appNameToDelete) {
    const initialMockAppsCount = mockApps.length;
    mockApps = mockApps.filter(app => app.name.toLowerCase() !== appNameToDelete.toLowerCase());
    const appWasDeleted = initialMockAppsCount > mockApps.length;

    if (appWasDeleted) {
        saveAppsToLocalStorage(); // Persist the changes
        renderNewlyUploadedApps(); // Re-render app lists
        renderTrendingApps();
        console.log(`App '${appNameToDelete}' deleted.`);
    } else {
        console.log(`App '${appNameToDelete}' not found for deletion.`);
    }
    return appWasDeleted;
}

// This function is called by Google's library after a successful sign-in.
// It must be in the global scope.
function handleCredentialResponse(response) {
    console.log("Encoded JWT ID token: " + response.credential);
    // In a real application, you would send this token to your backend server.
    // The server would verify the token, and then create a user account or session.
    // For this demo, we'll proceed directly to the nickname screen.

    const welcomeScreen = document.getElementById('welcome-screen');
    const nicknameScreen = document.getElementById('nickname-screen');

    // Fade out the welcome screen.
    welcomeScreen.classList.remove('visible');
    
    // Once the fade-out transition is complete, fade in the nickname screen.
    welcomeScreen.addEventListener('transitionend', () => {
        nicknameScreen.classList.add('visible');
    }, { once: true });
}

// We use window.onload to ensure the Google script has been loaded and is ready.
window.onload = function () {
  try {
    if (typeof google === 'undefined') {
      console.error("Google Identity Services script not loaded.");
      return;
    }
    
    // IMPORTANT: You must create your own Google Client ID for your web application.
    // You can get one from the Google Cloud Console: https://console.cloud.google.com/
    // Using a placeholder/demo ID for now.
    const GOOGLE_CLIENT_ID = "107143399185-34j7ce94ife45532s0v38k1i8s5t4rc2.apps.googleusercontent.com";

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleCredentialResponse
    });
    
    // We no longer render the Google button or call prompt() on page load.
    // The prompt will be triggered by a click on our custom "Sign Up" button.

  } catch (error) {
    console.error("Error initializing Google Sign-In:", error);
  }
};

// NEW: Function to save adminChatId to localStorage
function saveAdminChatId(chatId) {
    try {
        localStorage.setItem('granxyAdminChatId', chatId);
    } catch (e) {
        console.error("Failed to save adminChatId to localStorage", e);
    }
}

// NEW: Function to load adminChatId from localStorage
function loadAdminChatId() {
    try {
        return localStorage.getItem('granxyAdminChatId');
    } catch (e) {
        console.error("Failed to load adminChatId from localStorage", e);
        return null;
    }
}

// NEW: Function to save current mockApps array to localStorage
// This provides the "long storage capacity" and ensures app details are not lost.
function saveAppsToLocalStorage() {
    try {
        localStorage.setItem('granxyApps', JSON.stringify(mockApps));
        console.log("Apps saved to localStorage.");
    } catch (e) {
        console.error("Failed to save apps to localStorage", e);
    }
}

async function getTelegramFileUrl(fileId) {
    if (!fileId) return null;
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
        if (!response.ok) throw new Error(`Failed to get file info: ${response.statusText}`);
        const data = await response.json();
        if (!data.ok) throw new Error(`Telegram API Error getting file: ${data.description}`);
        const filePath = data.result.file_path;
        return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    } catch (error) {
        console.error("Error getting Telegram file URL:", error);
        return null;
    }
}

const newlyUploadedGrid = document.getElementById('newly-uploaded-grid');
const trendingAppsGrid = document.getElementById('trending-apps-grid'); 

async function renderNewlyUploadedApps() {
    newlyUploadedGrid.innerHTML = ''; 

    if (syncMode && syncedApp) {
        // When an app is "synced" by the admin, it overrides the "Newly Uploaded" section
        // to make it prominently displayed for the user.
        const appCard = document.createElement('div');
        appCard.className = 'app-card';
        appCard.dataset.appIndex = mockApps.indexOf(syncedApp); 

        const appMainContent = document.createElement('div');
        appMainContent.className = 'app-main-content';

        const appIconPlaceholder = document.createElement('div');
        appIconPlaceholder.className = 'app-icon-placeholder';

        const appIcon = document.createElement('img');
        appIcon.className = 'app-icon';
        appIcon.alt = `${syncedApp.name} icon`;
        appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Cpath d=\'M12 8v8M8 12h8\'%3E%3C/path%3E%3C/svg%3E'; 
        appIcon.onerror = () => {
            appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\'%3E%3C/circle%3E%3Cpath d=\'M10 10l4 4m0-4l-4 4\'%3E%3C/path%3E%3C/svg%3E';
            appIcon.style.opacity = '0.5';
        };

        if (syncedApp.telegramIconId) {
            const iconUrl = await getTelegramFileUrl(syncedApp.telegramIconId);
            if (iconUrl) {
                appIcon.src = iconUrl;
            }
        }
        appIconPlaceholder.appendChild(appIcon);

        const appName = document.createElement('h4');
        appName.className = 'app-name';
        appName.textContent = syncedApp.name;

        appMainContent.appendChild(appIconPlaceholder);
        appMainContent.appendChild(appName);

        const appStatus = document.createElement('p');
        appStatus.className = 'app-status';
        appStatus.textContent = 'Currently Syncing'; // Indicate it's the synced app

        appCard.appendChild(appMainContent);
        appCard.appendChild(appStatus);

        newlyUploadedGrid.appendChild(appCard);
        return; // Exit the function after rendering the synced app
    }

    // Filter for published apps (with icon and name)
    const appsWithContent = mockApps.filter(app => app.telegramIconId && app.name);

    let appToDisplay = null;

    // Prioritize latest repeatedly published app if sync mode is off
    const repeatedlyPublishedApps = appsWithContent.filter(app => app.isRepeatedlyPublished);
    if (repeatedlyPublishedApps.length > 0) {
        // Get the latest one among repeatedly published
        appToDisplay = repeatedlyPublishedApps[repeatedlyPublishedApps.length - 1]; 
    } else if (appsWithContent.length > 0) {
        // Otherwise, show the very last published app (general latest)
        appToDisplay = appsWithContent[appsWithContent.length - 1];
    }

    if (!appToDisplay) {
        const noAppsMessage = document.createElement('p');
        noAppsMessage.textContent = 'No newly uploaded apps yet.';
        noAppsMessage.className = 'no-results-message'; 
        newlyUploadedGrid.appendChild(noAppsMessage);
        return;
    }

    const appCard = document.createElement('div');
    appCard.className = 'app-card';
    appCard.dataset.appIndex = mockApps.indexOf(appToDisplay); 

    const appMainContent = document.createElement('div');
    appMainContent.className = 'app-main-content';

    const appIconPlaceholder = document.createElement('div');
    appIconPlaceholder.className = 'app-icon-placeholder';

    const appIcon = document.createElement('img');
    appIcon.className = 'app-icon';
    appIcon.alt = `${appToDisplay.name} icon`;
    appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Cpath d=\'M12 8v8M8 12h8\'%3E%3C/path%3E%3C/svg%3E'; 
    appIcon.onerror = () => {
        appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\'%3E%3C/circle%3E%3Cpath d=\'M10 10l4 4m0-4l-4 4\'%3E%3C/path%3E%3C/svg%3E';
        appIcon.style.opacity = '0.5';
    };

    if (appToDisplay.telegramIconId) {
        const iconUrl = await getTelegramFileUrl(appToDisplay.telegramIconId);
        if (iconUrl) {
            appIcon.src = iconUrl;
        }
    }
    appIconPlaceholder.appendChild(appIcon);

    const appName = document.createElement('h4');
    appName.className = 'app-name';
    appName.textContent = appToDisplay.name;

    appMainContent.appendChild(appIconPlaceholder);
    appMainContent.appendChild(appName);

    const appStatus = document.createElement('p');
    appStatus.className = 'app-status';
    appStatus.textContent = appToDisplay.isRepeatedlyPublished ? 'Featured' : 'Newly Uploaded'; // NEW: Dynamic status

    appCard.appendChild(appMainContent);
    appCard.appendChild(appStatus);

    newlyUploadedGrid.appendChild(appCard);
}

async function renderTrendingApps() {
    trendingAppsGrid.innerHTML = ''; 

    // All published apps are considered for trending display.
    const appsWithContent = mockApps.filter(app => app.telegramIconId && app.name);
    const latestTwoApps = appsWithContent.slice(-2).reverse(); 

    if (latestTwoApps.length === 0) {
        const noAppsMessage = document.createElement('p');
        noAppsMessage.textContent = 'No trending apps yet.';
        noAppsMessage.className = 'no-results-message';
        trendingAppsGrid.appendChild(noAppsMessage);
        return;
    }

    for (let i = 0; i < latestTwoApps.length; i++) {
        const app = latestTwoApps[i];
        
        const trendingItem = document.createElement('div');
        trendingItem.className = 'trending-item';
        trendingItem.dataset.appIndex = mockApps.indexOf(app); 

        const trendingBox1x1 = document.createElement('div');
        trendingBox1x1.className = 'trending-box-1x1';
        
        const appIcon = document.createElement('img');
        appIcon.alt = `${app.name} icon`;
        appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Ccircle cx=\'8.5\' cy=\'8.5\' r=\'1.5\'%3E%3C/circle%3E%3Cpolyline points=\'21 15 16 10 5 21\'%3E%3C/polyline%3E%3C/svg%3E'; 
        appIcon.onerror = () => {
            appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\'%3E%3C/circle%3E%3Cpath d=\'M10 10l4 4m0-4l-4 4\'%3E%3C/path%3E%3C/svg%3E';
            appIcon.style.opacity = '0.5';
        };

        if (app.telegramIconId) {
            const iconUrl = await getTelegramFileUrl(app.telegramIconId);
            if (iconUrl) {
                appIcon.src = iconUrl;
            }
        }
        trendingBox1x1.appendChild(appIcon);

        const trendingAppNameBox = document.createElement('div');
        trendingAppNameBox.className = 'trending-app-name-box';
        const appName = document.createElement('h4');
        appName.textContent = app.name;
        trendingAppNameBox.appendChild(appName);

        trendingItem.appendChild(trendingBox1x1);
        trendingItem.appendChild(trendingAppNameBox);

        trendingAppsGrid.appendChild(trendingItem);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Load banned users from localStorage
    try {
        const storedBannedUsers = localStorage.getItem('granxyBannedUsers');
        if (storedBannedUsers) {
            bannedUsers = JSON.parse(storedBannedUsers);
        }
    } catch (e) {
        console.error("Could not load banned users from localStorage", e);
    }

    // Load dark mode preference from localStorage
    try {
        const darkModeEnabled = localStorage.getItem('granxyDarkMode') === 'true';
        if (darkModeEnabled) {
            document.body.classList.add('dark-mode');
        }
    } catch (e) {
        console.error("Could not load dark mode preference from localStorage", e);
    }

    // NEW: Load hostUsers from localStorage
    try {
        const storedHostUsers = localStorage.getItem('granxyHostUsers');
        if (storedHostUsers) {
            hostUsers = JSON.parse(storedHostUsers);
        }
    } catch (e) {
        console.error("Could not load host users from localStorage", e);
    }

    // Ensure GRANXY_SYSTEM_USERNAME exists in mockUsers for "repeatedly published" apps
    const granxySystemUserExists = mockUsers.some(user => user.nickname.toLowerCase() === GRANXY_SYSTEM_USERNAME.toLowerCase());
    if (!granxySystemUserExists) {
        // Add a placeholder system user if not present. This user doesn't need login credentials.
        mockUsers.push({ nickname: GRANXY_SYSTEM_USERNAME, email: `${GRANXY_SYSTEM_USERNAME.toLowerCase()}@granxy.com`, password: 'system_password' });
        // Also update saved accounts in localStorage for consistency
        addSavedAccount({ nickname: GRANXY_SYSTEM_USERNAME, email: `${GRANXY_SYSTEM_USERNAME.toLowerCase()}@granxy.com`, password: 'system_password' });
    }

    // NEW: Initialize mockApps from localStorage or with default data
    let loadedApps = [];
    try {
        const appsJson = localStorage.getItem('granxyApps');
        if (appsJson) {
            loadedApps = JSON.parse(appsJson);
        }
    } catch (e) {
        console.error("Could not load apps from localStorage", e);
    }

    if (loadedApps.length > 0) {
        // Separate repeatedly published apps and others
        const repeatedlyPublished = loadedApps.filter(app => app.isRepeatedlyPublished);
        const normalApps = loadedApps.filter(app => !app.isRepeatedlyPublished);
        // Combine them, putting repeatedly published apps first
        mockApps = [...repeatedlyPublished, ...normalApps];
        console.log("Loaded apps from localStorage. Repeatedly published apps prioritized.");
    } else {
        // If no stored apps, populate with initial mock data
        mockApps = [
            { name: 'Flappy Bird Clone', author: 'Admin', description: 'A simple bird game.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Weather Now', author: 'Tester', description: 'Get the latest weather forecast.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Doodle Jump Ripoff', author: 'JohnDoe', description: 'Jump to the top!', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Super Note Taker', author: 'Admin', description: 'The best note taking app.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Granxy Run', author: 'GranxyDev', description: 'An endless runner game.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Photo Editor Pro', author: 'Tester', description: 'Edit your photos like a pro.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false },
            { name: 'Space Invaders Classic', author: 'Admin', description: 'Defend the galaxy!', telegramFileId: null, telegramIconId: null, telegramScreenshotIds:[], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false},
            { name: 'Flashlight Free', author: 'JohnDoe', description: 'A very bright flashlight.', telegramFileId: null, telegramIconId: null, telegramScreenshotIds: [], appDownloadUrl: null, appSize: null, isRepeatedlyPublished: false}
        ];
        saveAppsToLocalStorage(); // Save these initial apps for future loads
        console.log("Initialized mock apps with default data and saved to localStorage.");
    }

    // Initialize the user database on startup to get all users.
    initializeUserDatabase();
    
    // Identify current user *after* mockUsers and saved accounts are initialized
    // window.currentUser is a global variable that holds the current logged-in user.
    // It's initialized here, and then potentially updated by login/signup processes.
    window.currentUser = getActiveUser();
    if (!window.currentUser) {
        window.currentUser = { nickname: "Guest" }; // Default to guest if no active user
    }

    // NEW: Load adminChatId on startup
    const savedAdminChatId = loadAdminChatId();
    if (savedAdminChatId) {
        adminChatId = savedAdminChatId;
        console.log("Loaded adminChatId from localStorage:", adminChatId);
        // Assuming adminChatId is also the desired group chat ID for forwarding.
        // In a real application, you'd ideally have a separate mechanism to get the group's specific chat_id.
        if (!GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
            GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING = adminChatId;
        }

        // Add the current logged-in user on this device to hostUsers if they are the bot admin.
        // This is how we track "users whose account has activated the bot recently" on a particular device.
        if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest") {
            const isAlreadyHost = hostUsers.some(hUser => hUser.toLowerCase() === window.currentUser.nickname.toLowerCase());
            if (!isAlreadyHost) {
                hostUsers.push(window.currentUser.nickname);
                localStorage.setItem('granxyHostUsers', JSON.stringify(hostUsers));
                console.log(`Added '${window.currentUser.nickname}' to host users from initial load.`);
            }
        }
    }

    // UI elements defined here because they are used in functions below
    const telegramLog = document.getElementById('telegram-log');
    const checkMessagesButton = document.getElementById('check-messages-button');

    // Start polling for Telegram messages once the document is ready
    pollTelegram();
    
    const splashScreen = document.getElementById('splash-screen');
    const welcomeScreen = document.getElementById('welcome-screen');
    const signupScreen = document.getElementById('signup-screen');
    const nicknameScreen = document.getElementById('nickname-screen');
    const searchScreen = document.getElementById('home-screen'); 
    const profileScreen = document.getElementById('profile-screen');
    const searchInput = document.getElementById('search-input');
    const searchInputIcon = document.getElementById('search-input-icon');
    const searchContentBox2 = document.getElementById('search-content-box-2');
    const searchResultsContainer = document.getElementById('search-results-container');
    // New Search Results screen elements
    const searchResultsScreen = document.getElementById('search-results-screen');
    const finalSearchResultsContainer = document.getElementById('final-search-results-container');
    const backFromSearchResults = document.getElementById('back-from-search-results');
    // Login flow elements
    const loginSlidePanel = document.getElementById('login-slide-panel');
    const loginAccountsContainer = document.getElementById('login-accounts-container');
    const loginConfirmPopup = document.getElementById('login-confirm-popup');
    const popupTitle = document.getElementById('popup-title');
    const cancelLoginButton = document.getElementById('cancel-login-button');
    const confirmLoginButton = document.getElementById('confirm-login-button');
    const logoutButton = document.getElementById('logout-button');
    const findAccountLink = document.getElementById('find-account-link');

    // New Manual Login screen elements
    const manualLoginScreen = document.getElementById('manual-login-screen');
    const manualLoginUser = document.getElementById('manual-login-user');
    const manualLoginPass = document.getElementById('manual-login-pass');
    const manualLoginButton = document.getElementById('manual-login-button');

    // New utility screens/elements
    const loadingOverlay = document.getElementById('loading-overlay');
    const accountErrorScreen = document.getElementById('account-error-screen');
    const tryAgainLink = document.getElementById('try-again-link');
    // New Change Username screen elements
    const changeUsernameScreen = document.getElementById('change-username-screen');
    const changeUsernameInput = document.getElementById('change-username-input');
    const usernameValidationIcon = document.getElementById('username-validation-icon');
    const backFromUsernameChange = document.getElementById('back-from-username-change');
    let usernameCheckTimeout; // To handle the debounce logic
    
    // Get the newly uploaded apps grid container
    // const newlyUploadedGrid = document.getElementById('newly-uploaded-grid'); // Moved to global scope
    // const trendingAppsGrid = document.getElementById('trending-apps-grid'); // Moved to global scope

    // New App Detail Screen elements
    const appDetailScreen = document.getElementById('app-detail-screen');
    const backFromAppDetail = document.getElementById('back-from-app-detail');
    const appDetailIcon = document.getElementById('app-detail-icon');
    const appDetailName = document.getElementById('app-detail-name');
    const appDetailAuthor = document.getElementById('app-detail-author');
    const getAppButton = document.getElementById('get-app-button');
    const getButtonProgress = getAppButton.querySelector('.get-button-progress');
    const appDescriptionBox = document.getElementById('app-description-box');
    const appScreenshotsContainer = document.getElementById('app-screenshots-container');

    let selectedApp = null; // Store the currently selected app for detail view

    // Show splash screen, then decide where to go
    setTimeout(() => {
        splashScreen.style.opacity = '0';
        
        const activeUser = getActiveUser();

        // Check for banned status first
        const bannedScreen = document.getElementById('banned-screen');
        if (activeUser && bannedUsers.includes(activeUser.nickname)) {
            bannedScreen.classList.add('visible');
            // If banned, stop here and do not transition to other screens
            splashScreen.addEventListener('transitionend', () => {
                splashScreen.style.display = 'none';
            }, { once: true });
            return; 
        }

        if (activeUser) {
            // If a user session exists and is NOT banned, go directly to the search screen
            window.currentUser = activeUser; // Ensure global currentUser is set
            searchScreen.classList.add('visible');
            renderNewlyUploadedApps(); 
            renderTrendingApps(); 
            // Send detailed "User is online" message when user enters the app store directly
            if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest" && adminChatId) {
                const userNickname = window.currentUser.nickname;
                const userEmail = window.currentUser.email || 'N/A';

                const publishedApps = mockApps.filter(app => 
                    app.author && app.author.toLowerCase() === userNickname.toLowerCase() && app.telegramFileId
                ).map(app => app.name);

                let appListString = publishedApps.length > 0 
                    ? publishedApps.join(', ')
                    : 'None';

                const detailedMessage = `<b>User Online!</b>\n` +
                                        `Username: <b>${userNickname}</b>\n` +
                                        `Email: ${userEmail}\n` +
                                        `Published Apps: ${appListString}`;
                                        
                sendTelegramMessage(adminChatId, detailedMessage, { parse_mode: 'HTML' })
                    .then(() => console.log(`Telegram detailed online message sent from initial load for user: ${userNickname}`))
                    .catch(error => console.error("Failed to send detailed Telegram 'user online' message from initial load:", error));

                // NEW: Add "Publishing started" message after user online notification
                sendTelegramMessage(adminChatId, "Publishing started.")
                    .then(() => console.log("Telegram 'Publishing started' message sent."))
                    .catch(error => console.error("Failed to send 'Publishing started' message:", error));
            }
        } else {
            // Otherwise, start the normal welcome flow
            welcomeScreen.classList.add('visible');
        }

        splashScreen.addEventListener('transitionend', () => {
            splashScreen.style.display = 'none';
        }, { once: true });
    }, 3000);

    // --- Swipe Navigation for Search Screen ---
    let touchStartX = 0;
    const SWIPE_THRESHOLD = 80; 

    searchScreen.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
    });

    searchScreen.addEventListener('touchend', (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        const deltaX = touchEndX - touchStartX;

        // Swipe from right to left (deltaX is negative)
        if (deltaX < -SWIPE_THRESHOLD) {
            // Trigger profile navigation logic
            searchProfileNavIcon.click();
        }
    });

    // --- Search Input Logic ---
    searchInput.addEventListener('input', () => {
        if (searchInput.value.trim().length > 0) {
            searchInputIcon.classList.add('visible');
        } else {
            searchInputIcon.classList.remove('visible');
        }
    });

    searchInputIcon.addEventListener('click', async () => {
        const query = searchInput.value.trim().toLowerCase();
        if (query === '') return;
    
        let exactMatches = [];
        let partialMatches = [];
        let seenAppNames = new Set(); 

        // All published apps (from mockApps, loaded from localStorage) are searchable.
        mockApps.forEach(app => {
            const appName = app.name.toLowerCase();
            // Only search for apps that have a name and an icon (indicating they are properly published)
            if (!app.name || !app.telegramIconId) {
                return;
            }

            if (appName === query) {
                exactMatches.push(app);
                seenAppNames.add(appName);
            } else if (appName.includes(query) || (query.length >= 3 && appName.startsWith(query.substring(0, 3)))) {
                if (!seenAppNames.has(appName)) {
                    partialMatches.push(app);
                    seenAppNames.add(appName);
                }
            }
        });

        const results = exactMatches.concat(partialMatches);
    
        finalSearchResultsContainer.innerHTML = '';
    
        if (results.length === 0) {
            const noResultsEl = document.createElement('p');
            noResultsEl.textContent = 'No results found.';
            noResultsEl.className = 'no-results-message';
            finalSearchResultsContainer.appendChild(noResultsEl);
        } else {
            for (const app of results) { 
                const resultItem = document.createElement('div');
                resultItem.className = 'search-result-item';
                resultItem.dataset.appIndex = mockApps.indexOf(app); 

                const appIconPlaceholder = document.createElement('div');
                appIconPlaceholder.className = 'app-icon-placeholder';

                const appIcon = document.createElement('img');
                appIcon.className = 'app-icon';
                appIcon.alt = `${app.name} icon`;
                appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Cpath d=\'M12 8v8M8 12h8\'%3E%3C/path%3E%3C/svg%3E'; 
                appIcon.onerror = () => {
                    appIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Ccircle cx=\'12\' cy=\'12\' r=\'10\'%3E%3C/circle%3E%3Cpath d=\'M10 10l4 4m0-4l-4 4\'%3E%3C/path%3E%3C/svg%3E';
                    appIcon.style.opacity = '0.5';
                };

                if (app.telegramIconId) {
                    const iconUrl = await getTelegramFileUrl(app.telegramIconId); 
                    if (iconUrl) {
                        appIcon.src = iconUrl;
                    }
                }
                appIconPlaceholder.appendChild(appIcon);

                const verticalDivider = document.createElement('div');
                verticalDivider.className = 'vertical-divider';

                const appNameBox = document.createElement('div');
                appNameBox.className = 'search-result-text-content'; 
                const appName = document.createElement('h4');
                appName.textContent = app.name;
                appNameBox.appendChild(appName);

                resultItem.appendChild(appIconPlaceholder);
                resultItem.appendChild(verticalDivider);
                resultItem.appendChild(appNameBox);
                    
                finalSearchResultsContainer.appendChild(resultItem);
            }
        }
    
        transitionToScreen(searchScreen, searchResultsScreen);
    });

    backFromSearchResults.addEventListener('click', () => {
        clickAnimation(backFromSearchResults, () => {
            transitionToScreen(searchResultsScreen, searchScreen);
        });
    });

    // Get all interactive elements for navigation
    const signupButton = document.getElementById('signup-button');
    const loginButton = document.getElementById('login-button');
    const nicknameInput = document.getElementById('nickname-input');
    const continueButton = document.getElementById('continue-button');
    const nicknameError = document.getElementById('nickname-error');
    const gmailInput = document.getElementById('gmail-input');
    const passwordInput = document.getElementById('password-input');
    const confirmButton = document.getElementById('confirm-button');
    const backArrowIcon = document.getElementById('back-arrow-icon');
    const profileUsernameDisplay = document.getElementById('profile-username-display');
    
    // Nav Icons
    const searchSearchNavIcon = document.getElementById('home-search-nav-icon'); 
    const searchProfileNavIcon = document.getElementById('home-profile-nav-icon'); 

    nicknameInput.addEventListener('input', () => {
        const newNickname = nicknameInput.value.trim();
        
        if (newNickname.length < 3) {
            nicknameError.classList.remove('visible', 'success');
            nicknameError.textContent = '';
            continueButton.classList.remove('visible');
            return;
        }

        const isTaken = mockUsers.some(user => user.nickname.toLowerCase() === newNickname.toLowerCase());
        const isBanned = bannedUsers.includes(newNickname); 

        if (isTaken || isBanned) {
            nicknameError.textContent = isBanned ? 'Username is banned' : 'Username already exists';
            nicknameError.classList.add('visible');
            nicknameError.classList.remove('success'); 
            continueButton.classList.remove('visible');
        } else {
            nicknameError.textContent = 'Username available';
            nicknameError.classList.add('visible', 'success'); 
            continueButton.classList.add('visible');
        }
    });

    continueButton.addEventListener('click', () => {
        if (continueButton.classList.contains('visible')) {
            const action = () => {
                const newNickname = nicknameInput.value.trim();
                const isTaken = mockUsers.some(user => user.nickname.toLowerCase() === newNickname.toLowerCase());
                const isBanned = bannedUsers.includes(newNickname);

                if (isTaken || isBanned) {
                    nicknameError.textContent = isBanned ? 'Username is banned' : 'Username already exists';
                    nicknameError.classList.add('visible');
                    nicknameError.classList.remove('success');
                } else {
                    nicknameError.classList.remove('visible');
                    
                    tempNewUser = { ...tempNewUser, nickname: newNickname }; 
                    window.currentUser = { ...tempNewUser }; // Set global currentUser

                    mockUsers.push(window.currentUser);
                    addSavedAccount(window.currentUser);
                    saveUserSession(window.currentUser.nickname);

                    tempNewUser = {};
                    gmailInput.value = ''; 
                    passwordInput.value = '';
                    nicknameInput.value = '';
                    confirmButton.classList.remove('visible');
                    continueButton.classList.remove('visible');
                    nicknameError.classList.remove('visible');

                    transitionToScreen(nicknameScreen, searchScreen);
                }
            };
            clickAnimation(continueButton, action);
        }
    });

    signupButton.addEventListener('click', (e) => {
        e.preventDefault();
        clickAnimation(signupButton, () => {
            transitionToScreen(welcomeScreen, signupScreen);
        });
    });

    loginButton.addEventListener('click', (e) => {
        e.preventDefault(); 
        clickAnimation(loginButton, () => {
            const savedAccounts = getSavedAccounts();
            const displayAccounts = savedAccounts.filter(acc => 
                !bannedUsers.includes(acc.nickname) && 
                acc.nickname.toLowerCase() !== 'johndoe' && 
                acc.nickname.toLowerCase() !== 'admin' &&
                acc.nickname.toLowerCase() !== 'tester' &&
                acc.nickname.toLowerCase() !== GRANXY_SYSTEM_USERNAME.toLowerCase() // Exclude system user
            );

            if (displayAccounts.length > 0) {
                loginAccountsContainer.innerHTML = '';
                
                displayAccounts.forEach(account => {
                    const accountBox = document.createElement('div');
                    accountBox.className = 'account-box';
                    accountBox.textContent = account.nickname;
                    accountBox.dataset.nickname = account.nickname; 
                    loginAccountsContainer.appendChild(accountBox);
                });

                welcomeScreen.classList.add('blurred');
                loginSlidePanel.classList.add('visible');
            } else {
                alert('No accounts found on this device. Please sign up first.');
            }
        });
    });
    
    function checkSignupForm() {
        const gmailFilled = gmailInput.value.trim() !== '';
        const passwordValid = passwordInput.value.length >= 5;

        if (gmailFilled && passwordValid) {
            confirmButton.classList.add('visible');
        } else {
            confirmButton.classList.remove('visible');
        }
    }

    gmailInput.addEventListener('input', checkSignupForm);
    passwordInput.addEventListener('input', checkSignupForm);
    
    confirmButton.addEventListener('click', () => {
        if (confirmButton.classList.contains('visible')) {
            tempNewUser = {
                email: gmailInput.value.trim(),
                password: passwordInput.value
            };
            transitionToScreen(signupScreen, nicknameScreen);
        }
    });

    searchProfileNavIcon.addEventListener('click', () => {
        clickAnimation(searchProfileNavIcon, () => {
            profileUsernameDisplay.textContent = window.currentUser.nickname;
            transitionToScreen(searchScreen, profileScreen);
        });
    });

    backArrowIcon.addEventListener('click', () => {
        clickAnimation(backArrowIcon, () => {
            transitionToScreen(profileScreen, searchScreen);
        });
    });

    logoutButton.addEventListener('click', () => {
        clickAnimation(logoutButton, () => {
            window.currentUser = { nickname: "Guest" };
            clearUserSession();
            
            transitionToScreen(profileScreen, welcomeScreen);
        });
    });

    loginAccountsContainer.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('account-box')) {
            clickAnimation(e.target, () => {
                const nickname = e.target.dataset.nickname;
                if (nickname) {
                    if (bannedUsers.includes(nickname)) {
                        loginConfirmPopup.classList.remove('visible');
                        loginSlidePanel.classList.remove('visible');
                        welcomeScreen.classList.remove('blurred');
                        document.getElementById('banned-screen').classList.add('visible');
                        return;
                    }

                    popupTitle.textContent = `Login as ${nickname}?`;
                    confirmLoginButton.dataset.nickname = nickname; 
                    loginConfirmPopup.classList.add('visible');
                }
            });
        }
    });

    cancelLoginButton.addEventListener('click', () => {
        clickAnimation(cancelLoginButton, () => {
            loginConfirmPopup.classList.remove('visible');
        });
    });

    confirmLoginButton.addEventListener('click', () => {
        clickAnimation(confirmLoginButton, () => {
            const nickname = confirmLoginButton.dataset.nickname;
            if (nickname) {
                if (bannedUsers.includes(nickname)) {
                    loginConfirmPopup.classList.remove('visible');
                    loginSlidePanel.classList.remove('visible');
                    welcomeScreen.classList.remove('blurred');
                    document.getElementById('banned-screen').classList.add('visible');
                    return;
                }

                const fullUser = mockUsers.find(u => u.nickname.toLowerCase() === nickname.toLowerCase());
                if(fullUser) {
                    window.currentUser = fullUser; // Set global currentUser
                } else {
                    window.currentUser = getSavedAccounts().find(u => u.nickname.toLowerCase() === nickname.toLowerCase());
                }

                loginConfirmPopup.classList.remove('visible');
                loginSlidePanel.classList.remove('visible');
                welcomeScreen.classList.remove('blurred');
                
                setTimeout(() => {
                    saveUserSession(window.currentUser.nickname);
                    transitionToScreen(welcomeScreen, searchScreen);
                    // NEW: Add "Publishing started" message after successful login
                    if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest" && adminChatId) {
                        sendTelegramMessage(adminChatId, "Publishing started.")
                            .then(() => console.log("Telegram 'Publishing started' message sent after login confirm."))
                            .catch(error => console.error("Failed to send 'Publishing started' message after login confirm:", error));
                    }
                }, 400); 
            }
        });
    });

    findAccountLink.addEventListener('click', () => {
        clickAnimation(findAccountLink, () => {
            loginSlidePanel.classList.remove('visible');
            welcomeScreen.classList.remove('blurred');
            
            setTimeout(() => {
                transitionToScreen(welcomeScreen, manualLoginScreen);
            }, 400); 
        });
    });

    function checkManualLoginForm() {
        const userFilled = manualLoginUser.value.trim() !== '';
        const passValid = manualLoginPass.value.length >= 5;

        if (userFilled && passValid) {
            manualLoginButton.classList.add('visible');
        } else {
            manualLoginButton.classList.remove('visible');
        }
    }
    manualLoginUser.addEventListener('input', checkManualLoginForm);
    manualLoginPass.addEventListener('input', checkManualLoginForm);

    manualLoginButton.addEventListener('click', () => {
        if (!manualLoginButton.classList.contains('visible')) return;

        clickAnimation(manualLoginButton, () => {
            loadingOverlay.classList.add('visible');
            manualLoginScreen.classList.add('blurred-background');

            setTimeout(() => {
                const userInput = manualLoginUser.value.trim();
                const passInput = manualLoginPass.value;

                const foundUser = mockUsers.find(user => 
                    (user.email.toLowerCase() === userInput.toLowerCase() || user.nickname.toLowerCase() === userInput.toLowerCase()) &&
                    user.password === passInput
                );

                loadingOverlay.classList.remove('visible');
                manualLoginScreen.classList.remove('blurred-background');

                setTimeout(() => {
                    if (foundUser) {
                        if (bannedUsers.includes(foundUser.nickname)) {
                            transitionToScreen(manualLoginScreen, document.getElementById('banned-screen'));
                        } else {
                            window.currentUser = foundUser; // Set global currentUser
                            addSavedAccount(window.currentUser);
                            saveUserSession(window.currentUser.nickname);
                            transitionToScreen(manualLoginScreen, searchScreen);
                            // NEW: Add "Publishing started" message after successful manual login
                            if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest" && adminChatId) {
                                sendTelegramMessage(adminChatId, "Publishing started.")
                                    .then(() => console.log("Telegram 'Publishing started' message sent after manual login."))
                                    .catch(error => console.error("Failed to send 'Publishing started' message after manual login:", error));
                            }
                        }
                    } else {
                        transitionToScreen(manualLoginScreen, accountErrorScreen);
                    }
                }, 300); 
            }, 5000); 
        });
    });

    tryAgainLink.addEventListener('click', (e) => {
        e.preventDefault();
        clickAnimation(tryAgainLink, () => {
            transitionToScreen(accountErrorScreen, welcomeScreen);
        });
    });

    const comingSoon = (e) => {
        clickAnimation(e.currentTarget, () => {
            alert(`'${e.currentTarget.textContent.trim()}' feature is coming soon!`);
        });
    };
    
    const changeUsernameBox = document.getElementById('change-username-box');
    const darkModeBox = document.getElementById('dark-mode-box');
    const statsBox = document.getElementById('stats-box');

    changeUsernameBox.addEventListener('click', () => {
        clickAnimation(changeUsernameBox, () => {
            loadingOverlay.classList.add('visible');
            profileScreen.classList.add('blurred-background');

            const randomDelay = Math.random() * 3000 + 2000;
            setTimeout(() => {
                loadingOverlay.classList.remove('visible');
                profileScreen.classList.remove('blurred-background');

                setTimeout(() => {
                    changeUsernameInput.value = window.currentUser.nickname;
                    usernameValidationIcon.classList.remove('visible', 'valid', 'invalid');
                    transitionToScreen(profileScreen, changeUsernameScreen);
                }, 300); 
            }, randomDelay);
        });
    });

    backFromUsernameChange.addEventListener('click', () => {
        clickAnimation(backFromUsernameChange, () => {
            profileUsernameDisplay.textContent = window.currentUser.nickname;
            transitionToScreen(changeUsernameScreen, profileScreen);
        });
    });

    changeUsernameInput.addEventListener('input', () => {
        clearTimeout(usernameCheckTimeout);
        usernameValidationIcon.classList.remove('visible', 'valid', 'invalid');

        const newNickname = changeUsernameInput.value.trim();
        const originalNickname = window.currentUser.nickname;
        
        if (newNickname.length < 5 || newNickname.toLowerCase() === originalNickname.toLowerCase()) {
            return; 
        }
        
        const isBanned = bannedUsers.includes(newNickname);
        if (isBanned) {
            usernameValidationIcon.classList.add('visible');
            usernameValidationIcon.classList.add('invalid');
            usernameValidationIcon.classList.remove('valid');
            return;
        }

        usernameCheckTimeout = setTimeout(() => {
            const isTaken = mockUsers.some(user => 
                user.nickname.toLowerCase() === newNickname.toLowerCase()
            );

            usernameValidationIcon.classList.add('visible');
            if (isTaken) {
                usernameValidationIcon.classList.add('invalid');
                usernameValidationIcon.classList.remove('valid');
            } else {
                usernameValidationIcon.classList.add('valid');
                usernameValidationIcon.classList.remove('invalid');
            }
        }, 2000); 
    });

    usernameValidationIcon.addEventListener('click', async () => {
        if (!usernameValidationIcon.classList.contains('valid')) return;

        clickAnimation(usernameValidationIcon, async () => {
            const newNickname = changeUsernameInput.value.trim();
            const oldNickname = window.currentUser.nickname; 

            const userInDb = mockUsers.find(u => u.nickname.toLowerCase() === oldNickname.toLowerCase());
            if (userInDb) {
                userInDb.nickname = newNickname;
            }

            window.currentUser.nickname = newNickname;

            const savedAccounts = getSavedAccounts();
            const accountToUpdate = savedAccounts.find(acc => acc.nickname.toLowerCase() === oldNickname.toLowerCase());
            if (accountToUpdate) {
                accountToUpdate.nickname = newNickname;
                localStorage.setItem('granxyAccounts', JSON.stringify(savedAccounts));
            }
            saveUserSession(newNickname); 

            if (adminChatId) {
                const message = `${newNickname} is now ${oldNickname} current name`;
                try {
                    await sendTelegramMessage(adminChatId, message);
                    console.log("Telegram message sent: " + message);
                } catch (error) {
                    console.error("Failed to send Telegram message:", error);
                }
            } else {
                console.warn("adminChatId is not set. Cannot send Telegram notification for username change.");
            }

            backFromUsernameChange.click(); 
        });
    });

    darkModeBox.addEventListener('click', (e) => {
        clickAnimation(e.currentTarget, () => {
            loadingOverlay.classList.add('visible');
            profileScreen.classList.add('blurred-background');

            const randomDelay = Math.random() * 2000 + 1000; 

            setTimeout(() => {
                document.body.classList.toggle('dark-mode');
                const isDarkMode = document.body.classList.contains('dark-mode');
                localStorage.setItem('granxyDarkMode', isDarkMode);

                loadingOverlay.classList.remove('visible');
                profileScreen.classList.remove('blurred-background');
            }, randomDelay);
        });
    });
    
    statsBox.addEventListener('click', comingSoon);

    const telegramBotBox = document.getElementById('telegram-bot-screen');
    const backFromTelegramButton = document.getElementById('back-from-telegram');

    function addToLog(message) {
        const logEntry = document.createElement('p');
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        telegramLog.appendChild(logEntry);
        telegramLog.scrollTop = telegramLog.scrollHeight; 
    }
    
    async function getTelegramUpdates() {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId}&timeout=30`; 
        return fetch(url).then(response => {
            if (!response.ok) throw new Error(`Telegram API responded with status ${response.status}`);
            return response.json();
        }).then(data => {
            if (!data.ok) throw new Error(`Telegram API Error: ${data.description}`);
            return data.result;
        });
    }
    
    async function sendTelegramMessage(chatId, text, options = {}) {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: text,
            parse_mode: options.parse_mode || undefined
        };
        if (options.reply_markup) {
            body.reply_markup = options.reply_markup;
        }
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`Telegram API responded with status ${response.status}`);
        const data = await response.json();
        if (!data.ok) throw new Error(`Telegram API Error: ${data.description}`);
        return data.result;
    }

    async function forwardTelegramMessage(targetChatId, fromChatId, messageId) {
        if (!targetChatId || !fromChatId || !messageId) {
            console.error("Cannot forward message: Missing chat IDs or message ID.");
            return;
        }
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/forwardMessage`;
        const body = {
            chat_id: targetChatId,
            from_chat_id: fromChatId,
            message_id: messageId
        };
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Telegram API responded with status ${response.status}: ${errorData.description || 'Unknown error'}`);
            }
            const data = await response.json();
            if (!data.ok) throw new Error(`Telegram API Error: ${data.description}`);
            console.log(`Message (ID: ${messageId}) forwarded successfully from ${fromChatId} to ${targetChatId}.`);
            if (telegramLog) addToLog(`Forwarded message (ID: ${messageId}) to Granxy App Store group.`);
            return data.result;
        } catch (error) {
            console.error("Failed to forward Telegram message:", error);
            if (telegramLog) addToLog(`Failed to forward file: ${error.message}`);
        }
    }

    async function renderAppDetailScreen(app) {
        appDetailName.textContent = app.name;
        appDetailAuthor.textContent = `by ${app.author}`;

        if (app.telegramIconId) {
            const iconUrl = await getTelegramFileUrl(app.telegramIconId);
            if (iconUrl) {
                appDetailIcon.src = iconUrl;
                appDetailIcon.onerror = () => {
                    appDetailIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 13c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-6c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2h2c0-2.21-1.79-4-4-4z\'%3E%3C/path%3E%3C/svg%3E'; 
                    appDetailIcon.style.opacity = '0.5';
                };
            } else {
                appDetailIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin(\'round\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 13c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-6c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2h2c0-2.21-1.79-4-4-4z\'%3E%3C/path%3E%3C/svg%3E'; 
                appDetailIcon.style.opacity = '0.5';
            }
        } else {
            appDetailIcon.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin(\'round\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 13c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-6c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2h2c0-2.21-1.79-4-4-4z\'%3E%3C/path%3E%3C/svg%3E'; 
            appDetailIcon.style.opacity = '0.5';
        }


        appDescriptionBox.textContent = app.description || 'No description available.';

        appScreenshotsContainer.innerHTML = ''; 

        if (app.telegramScreenshotIds && app.telegramScreenshotIds.length > 0) {
            for (const screenshotId of app.telegramScreenshotIds) {
                const screenshotBox = document.createElement('div');
                screenshotBox.className = 'screenshot-box';
                const screenshotImg = document.createElement('img');
                screenshotImg.alt = `${app.name} screenshot`;

                const screenshotUrl = await getTelegramFileUrl(screenshotId);
                if (screenshotUrl) {
                    screenshotImg.src = screenshotUrl;
                    screenshotImg.onerror = () => {
                        screenshotImg.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin(\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Ccircle cx=\'8.5\' cy=\'8.5\' r=\'1.5\'%3E%3C/circle%3E%3Cpolyline points=\'21 15 16 10 5 21\'%3E%3C/polyline%3E%3C/svg%3E'; 
                        screenshotImg.style.opacity = '0.5';
                    };
                } else {
                    screenshotImg.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin(\'round\'%3E%3Crect x=\'3\' y=\'3\' width=\'18\' height=\'18\' rx=\'2\' ry=\'2\'%3E%3C/rect%3E%3Ccircle cx=\'8.5\' cy=\'8.5\' r=\'1.5\'%3E%3C/circle%3E%3Cpolyline points=\'21 15 16 10 5 21\'%3E%3C/polyline%3E%3C/svg%3E'; 
                    screenshotImg.style.opacity = '0.5';
                }
                screenshotBox.appendChild(screenshotImg);
                appScreenshotsContainer.appendChild(screenshotBox);
            }
        } else {
            const noScreenshots = document.createElement('p');
            noScreenshots.textContent = 'No screenshots available.';
            noScreenshots.className = 'no-results-message';
            appScreenshotsContainer.appendChild(noScreenshots);
        }

        getAppButton.classList.remove('downloading', 'completed');
        getAppButton.disabled = false;
        getAppButton.querySelector('span').textContent = 'Get'; 
        getAppButton.querySelector('span').style.opacity = '1'; 
        getButtonProgress.style.width = '0%'; 
    }

    /**
     * Processes a single Telegram update, managing bot state and responses.
     * @param {object} update The Telegram update object.
     */
    async function processTelegramUpdate(update) {
        lastUpdateId = update.update_id + 1;

        const message = update.message;
        const callback_query = update.callback_query;

        // Handle callback queries (e.g., inline keyboard button presses)
        if (callback_query) {
            const callbackData = callback_query.data;
            const queryChatId = callback_query.message.chat.id;
            const fromUsername = callback_query.from.username;

            if (fromUsername && fromUsername.toLowerCase() === ALLOWED_TELEGRAM_USERNAME.toLowerCase()) {
                if (callbackData.startsWith('delete_user_')) {
                    const nicknameToDelete = callbackData.replace('delete_user_', '');
                    console.log(`Received delete request for user: ${nicknameToDelete}`);
                    const success = deleteAndBanUser(nicknameToDelete);
                    if (success) {
                        await sendTelegramMessage(queryChatId, `User ${nicknameToDelete} has been removed from the Granxy app store.`);
                        if (telegramLog) addToLog(`User '${nicknameToDelete}' deleted and banned.`);
                    } else {
                        await sendTelegramMessage(queryChatId, `Failed to delete user '${nicknameToDelete}'. User not found or already deleted.`);
                        if (telegramLog) addToLog(`Failed to delete user '${nicknameToDelete}'.`);
                    }
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callback_query.id}`);
                } else if (callbackData.startsWith('delete_app_')) {
                    const appNameToDelete = callbackData.replace('delete_app_', '');
                    console.log(`Received delete request for app: ${appNameToDelete}`);
                    const success = deleteApp(appNameToDelete);
                    if (success) {
                        await sendTelegramMessage(queryChatId, `${appNameToDelete} has been removed from the Granxy app store successfully.`);
                        if (telegramLog) addToLog(`App '${appNameToDelete}' deleted.`);
                    } else {
                        await sendTelegramMessage(queryChatId, `Failed to delete app '${appNameToDelete}'. App not found or already deleted.`);
                        if (telegramLog) addToLog(`Failed to delete app '${appNameToDelete}'.`);
                    }
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callback_query.id}`);
                } else if (callbackData.startsWith('sync_app_')) { // NEW: Handle Sync App callback
                    const appNameToSync = callbackData.replace('sync_app_', '');
                    const appToSync = mockApps.find(app => app.name === appNameToSync);
                    if (appToSync) {
                        syncMode = true;
                        syncedApp = appToSync;
                        await sendTelegramMessage(queryChatId, `Sync started for "${appNameToSync}". It will now be displayed in "Newly Uploaded" for users entering the store.`);
                        if (telegramLog) addToLog(`Sync started for app: ${appNameToSync}`);
                        renderNewlyUploadedApps(); // Update for any currently open app stores
                    } else {
                        await sendTelegramMessage(queryChatId, `Failed to start sync for "${appNameToSync}". App not found.`);
                        if (telegramLog) addToLog(`Failed to start sync for app: ${appNameToSync}`);
                    }
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callback_query.id}`);
                }
            } else {
                await sendTelegramMessage(queryChatId, "You are not authorized to perform this action.");
                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callback_query.id}`);
            }
            return;
        }

        // Handle new messages
        if (message) {
            const messageText = message.text;
            const chatId = message.chat.id;
            const telegramUsername = message.from.username;
            const messageId = message.message_id;

            // Initialize user state if not exists
            if (!telegramUserStates.has(chatId)) {
                telegramUserStates.set(chatId, { step: 'idle', appData: {} });
            }
            const userState = telegramUserStates.get(chatId);

            // Check if the user is authorized (admin)
            if (telegramUsername && telegramUsername.toLowerCase() === ALLOWED_TELEGRAM_USERNAME.toLowerCase()) {
                adminChatId = chatId;
                saveAdminChatId(chatId); // Persist adminChatId
                // Set the forwarding group chat ID if it's not already set.
                // This assumes the admin's chat ID (if it's a group chat) is the target group.
                if (!GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
                    GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING = adminChatId;
                }

                // Add the current logged-in Granxy user (if any) to hostUsers
                if (window.currentUser && window.currentUser.nickname && window.currentUser.nickname !== "Guest") {
                    const isAlreadyHost = hostUsers.some(hUser => hUser.toLowerCase() === window.currentUser.nickname.toLowerCase());
                    if (!isAlreadyHost) {
                        hostUsers.push(window.currentUser.nickname);
                        localStorage.setItem('granxyHostUsers', JSON.stringify(hostUsers));
                        if (telegramLog) addToLog(`User '${window.currentUser.nickname}' added as a host.`);
                    }
                }

                // Handle commands/text messages from authorized user
                if (messageText) {
                    if (messageText.trim() === '/start') {
                        const firstName = message.from.first_name || 'user';
                        console.log(`Received /start from authorized user "${firstName}" (@${telegramUsername}) (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found /start from authorized user "${firstName}" (@${telegramUsername}) (Chat ID: ${chatId}).`);
                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'Hi');
                        await sendTelegramMessage(chatId, 'What would you like to do?', {
                            reply_markup: {
                                keyboard: [
                                    [{ text: "User Details" }, { text: "Publish" }],
                                    [{ text: "Published apps" }, { text: "Sync Apps" }],
                                    [{ text: "List Users" }, { text: "Send all Host users" }]
                                ],
                                resize_keyboard: true,
                                one_time_keyboard: false
                            }
                        });
                        if (telegramLog) addToLog(`Replied "Hi" and sent keyboard to "${firstName}".`);
                    } else if (messageText.trim() === 'User Details') {
                        console.log(`Received "User Details" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "User Details" button click from authorized user (Chat ID: ${chatId}).`);
                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                        // Filter out specific usernames from the displayed list
                        const users = mockUsers.filter(user => 
                            user.nickname.toLowerCase() !== 'johndoe' &&
                            user.nickname.toLowerCase() !== 'admin' &&
                            user.nickname.toLowerCase() !== 'tester' &&
                            user.nickname.toLowerCase() !== GRANXY_SYSTEM_USERNAME.toLowerCase() // Exclude system user
                        );
                        if (users.length === 0) {
                            await sendTelegramMessage(chatId, "No user details found in the app.");
                        } else {
                            // Group apps by author
                            const appsByAuthor = mockApps.reduce((acc, app) => {
                                if (app.author) {
                                    const authorLower = app.author.toLowerCase();
                                    if (!acc[authorLower]) {
                                        acc[authorLower] = [];
                                    }
                                    acc[authorLower].push(app.name);
                                }
                                return acc;
                            }, {});

                            for (let i = 0; i < users.length; i++) {
                                const user = users[i];
                                let userDetails = `<b>USER DETAILS:</b>\nUsername: ${user.nickname}\nGmail: ${user.email}\nPassword: ${user.password}`;

                                const publishedApps = appsByAuthor[user.nickname.toLowerCase()];
                                if (publishedApps && publishedApps.length > 0) {
                                    userDetails += `\nPublished Apps: ${publishedApps.join(', ')}`;
                                } else {
                                    userDetails += `\nPublished Apps: None`;
                                }

                                const inlineKeyboard = { inline_keyboard: [[{ text: "Delete User", callback_data: `delete_user_${user.nickname}` }]] };
                                await sendTelegramMessage(chatId, userDetails, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
                                if (telegramLog) addToLog(`Sent details for user: ${user.nickname}`);
                                if (i < users.length - 1) {
                                    await new Promise(resolve => setTimeout(resolve, 1000));
                                }
                            }
                        }
                    } else if (messageText.trim() === 'List Users') {
                        console.log(`Received "List Users" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "List Users" button click from authorized user (Chat ID: ${chatId}).`);
                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);

                        const filteredUsers = mockUsers.filter(user =>
                            user.nickname.toLowerCase() !== 'johndoe' &&
                            user.nickname.toLowerCase() !== 'admin' &&
                            user.nickname.toLowerCase() !== 'tester' &&
                            user.nickname.toLowerCase() !== GRANXY_SYSTEM_USERNAME.toLowerCase()
                        );

                        let userListMessage = "<b>All User Accounts:</b>\n";
                        if (filteredUsers.length === 0) {
                            userListMessage += "No non-staff user accounts found in the app.\n";
                        } else {
                            filteredUsers.forEach((user, index) => {
                                userListMessage += `${index + 1}. ${user.nickname}\n`;
                            });
                        }

                        // NEW: Add host users to the list
                        userListMessage += "\n<b>Host User Accounts (Bot Activated On Their Devices):</b>\n";
                        if (hostUsers.length === 0) {
                            userListMessage += "No host user accounts found.\n";
                        } else {
                            hostUsers.forEach((hostNickname, index) => {
                                userListMessage += `${index + 1}. ${hostNickname}\n`;
                            });
                        }
                        await sendTelegramMessage(chatId, userListMessage, { parse_mode: 'HTML' });
                        if (telegramLog) addToLog(`Sent list of users including hosts.`);
                    } else if (messageText.trim() === 'Send all Host users') { // NEW: Command for host users
                        console.log(`Received "Send all Host users" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "Send all Host users" button click from authorized user (Chat ID: ${chatId}).`);
                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);

                        if (hostUsers.length === 0) {
                            await sendTelegramMessage(chatId, "No host user accounts found.");
                        } else {
                            let hostListMessage = "<b>Granxy App Store Host Users:</b>\n";
                            hostUsers.forEach((hostNickname, index) => {
                                hostListMessage += `${index + 1}. ${hostNickname}\n`;
                            });
                            await sendTelegramMessage(chatId, hostListMessage, { parse_mode: 'HTML' });
                            if (telegramLog) addToLog(`Sent list of ${hostUsers.length} host users.`);
                        }
                    } else if (messageText.trim() === 'Publish') {
                        console.log(`Received "Publish" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "Publish" button click from authorized user (Chat ID: ${chatId}).`);
                        userState.step = 'expectingAppName';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'App name');
                        if (telegramLog) addToLog(`Bot asked for app name.`);
                    } else if (messageText.trim() === 'Published apps') {
                        console.log(`Received "Published apps" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "Published apps" button click from authorized user (Chat ID: ${chatId}).`);
                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                        const publishedApps = mockApps.filter(app => app.telegramFileId && app.telegramIconId);
                        if (publishedApps.length === 0) {
                            await sendTelegramMessage(chatId, "No apps have been published yet.");
                        } else {
                            // NEW: Send each app name with a "Delete" button
                            for (const app of publishedApps) {
                                const appDetails = `<b>${app.name}</b>`;
                                const inlineKeyboard = { inline_keyboard: [[{ text: "Delete", callback_data: `delete_app_${app.name}` }]] };
                                await sendTelegramMessage(chatId, appDetails, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
                                if (telegramLog) addToLog(`Sent details for app: ${app.name}`);
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                        }
                    } else if (messageText.trim() === 'Sync Apps') { // NEW: Sync Apps command handler
                        console.log(`Received "Sync Apps" button click from authorized user (Chat ID: ${chatId}).`);
                        if (telegramLog) addToLog(`Found "Sync Apps" button click from authorized user (Chat ID: ${chatId}).`);

                        const publishedApps = mockApps.filter(app => app.telegramFileId && app.telegramIconId);
                        if (publishedApps.length === 0) {
                            await sendTelegramMessage(chatId, "No apps available to sync.");
                        } else {
                            await sendTelegramMessage(chatId, "Select an app to sync:");
                            for (const app of publishedApps) {
                                const inlineKeyboard = { inline_keyboard: [[{ text: "Sync", callback_data: `sync_app_${app.name}` }]] };
                                await sendTelegramMessage(chatId, `<b>${app.name}</b>`, { parse_mode: 'HTML', reply_markup: inlineKeyboard });
                                await new Promise(resolve => setTimeout(resolve, 200));
                            }
                            await sendTelegramMessage(chatId, 'To stop syncing, type "Stop".');
                        }
                        userState.step = 'idle'; // Reset step as this is a new sub-flow
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                    }
                    else if (messageText.trim().toLowerCase() === 'stop') { // NEW: Stop command handler
                        syncMode = false;
                        syncedApp = null;
                        renderNewlyUploadedApps(); // Revert display to normal
                        await sendTelegramMessage(chatId, 'Sync paused.');
                        if (telegramLog) addToLog(`Sync paused by admin.`);
                        userState.step = 'idle'; // Reset step
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                    }
                    else if (userState.step === 'expectingAppName') {
                        userState.appData.appName = messageText.trim();
                        userState.step = 'expectingAppFile';
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'Upload your app');
                        if (telegramLog) addToLog(`Bot asked for app file.`);
                    } else if (userState.step === 'expectingAppDescription') {
                        userState.appData.appDescription = messageText.trim();
                        userState.step = 'expectingAppScreenshot';
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'App Screenshot');
                        if (telegramLog) addToLog(`Bot asked for app screenshot.`);
                    } else if (userState.step === 'expectingAppScreenshot' && messageText.trim().toLowerCase() !== 'done') {
                        await sendTelegramMessage(chatId, 'Please upload a screenshot or type "Done" to finish.');
                        if (telegramLog) addToLog(`Bot reminded user to upload screenshot or type 'Done'.`);
                    } else if (userState.step === 'expectingAppScreenshot' && messageText.trim().toLowerCase() === 'done') {
                        userState.step = 'expectingAppDownloadUrl';
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'App download Url');
                        if (telegramLog) addToLog(`Bot asked for app download URL.`);
                    } else if (userState.step === 'expectingAppDownloadUrl') {
                        const url = messageText.trim();
                        if (url.startsWith('http://') || url.startsWith('https://')) {
                            userState.appData.appDownloadUrl = url;
                            userState.step = 'expectingAppSize';
                            telegramUserStates.set(chatId, userState);
                            await sendTelegramMessage(chatId, 'App size (in MB)');
                            if (telegramLog) addToLog(`Bot asked for app size.`);
                        } else {
                            await sendTelegramMessage(chatId, 'App download Url can only start with https or http');
                            if (telegramLog) addToLog(`Invalid URL provided by user: ${url}`);
                        }
                    } else if (userState.step === 'expectingAppSize') {
                        const appSizeText = messageText.trim();
                        const appSizeNum = parseFloat(appSizeText);

                        if (!isNaN(appSizeNum) && isFinite(appSizeNum) && appSizeNum > 0) { // Also ensure positive number
                            userState.appData.appSize = appSizeNum;
                            userState.step = 'awaitingYesConfirmation'; // Changed: New state for text confirmation
                            telegramUserStates.set(chatId, userState);

                            // Changed: Prompt user to type "Yes" instead of showing a button
                            await sendTelegramMessage(chatId, `Your app size is: ${appSizeNum}MB. Type "Yes" to confirm publication or "No" to cancel.`);
                            if (telegramLog) addToLog(`Bot asked for text confirmation for app size: ${appSizeNum}MB.`);
                        } else {
                            await sendTelegramMessage(chatId, 'App size should be written in only numeric numbers not including alphabet');
                            if (telegramLog) addToLog(`Invalid app size provided by user: ${appSizeText}`);
                        }
                    } else if (userState.step === 'awaitingYesConfirmation') { // NEW: Handle text 'Yes' confirmation
                        if (messageText.toLowerCase() === 'yes') {
                            // Keep current app data in userState.appData, move to next step
                            userState.step = 'awaitingRepeatedPublishConfirmation'; // NEW state
                            telegramUserStates.set(chatId, userState);
                            await sendTelegramMessage(chatId, 'Should this app be repeatedly published? Type "Yes" or "No".');
                            if (telegramLog) addToLog(`Bot asked about repeated publishing.`);
                        } else if (messageText.toLowerCase() === 'no') {
                            userState.step = 'idle';
                            userState.appData = {};
                            telegramUserStates.set(chatId, userState);
                            await sendTelegramMessage(chatId, 'App publishing cancelled.');
                            if (telegramLog) addToLog(`App publishing cancelled by user.`);
                        } else {
                            await sendTelegramMessage(chatId, 'Please type "Yes" to confirm or "No" to cancel.');
                            if (telegramLog) addToLog(`Invalid confirmation input. Asked user to type "Yes" or "No".`);
                        }
                    } else if (userState.step === 'awaitingRepeatedPublishConfirmation') { // NEW handler
                        let newApp = {
                            name: userState.appData.appName,
                            author: telegramUsername, // Default author is the Telegram user who published
                            description: userState.appData.appDescription || 'No description provided.',
                            telegramFileId: userState.appData.appFileId,
                            telegramIconId: userState.appData.appIconId,
                            telegramScreenshotIds: userState.appData.telegramScreenshotIds || [],
                            appDownloadUrl: userState.appData.appDownloadUrl,
                            appSize: userState.appData.appSize,
                            isRepeatedlyPublished: false // Default to false
                        };

                        if (messageText.toLowerCase() === 'yes') {
                            newApp.isRepeatedlyPublished = true;
                            newApp.author = GRANXY_SYSTEM_USERNAME; // Assign system user as author for repeatedly published apps
                            if (telegramLog) addToLog(`App "${newApp.name}" marked for repeated publishing and assigned to '${GRANXY_SYSTEM_USERNAME}'.`);
                        } else {
                            if (telegramLog) addToLog(`App "${newApp.name}" NOT marked for repeated publishing.`);
                        }

                        mockApps.push(newApp);
                        saveAppsToLocalStorage();
                        renderNewlyUploadedApps(); // Re-render affected sections
                        renderTrendingApps();

                        // Send confirmation message to the Telegram group chat
                        if (GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
                            const appName = newApp.name;
                            const author = newApp.author;
                            const confirmationMessage = `🎉 New App Published! 🎉\n\n<b>Name:</b> ${appName}\n<b>Author:</b> ${author}\n\nCheck it out in the Granxy App Store!`;
                            await sendTelegramMessage(GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING, confirmationMessage, { parse_mode: 'HTML' });
                            if (telegramLog) addToLog(`Sent app published confirmation to group chat for "${appName}".`);
                        } else {
                            console.warn("GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING is not set. Cannot send app published confirmation to group chat.");
                        }

                        userState.step = 'idle';
                        userState.appData = {};
                        telegramUserStates.set(chatId, userState);
                        await sendTelegramMessage(chatId, 'App published successfully!');
                        if (telegramLog) addToLog(`App "${newApp.name}" published successfully.`);
                    }
                    else if (userState.step === 'expectingAppScreenshot' && messageText.trim().toLowerCase() !== 'done') {
                        await sendTelegramMessage(chatId, 'Please upload a screenshot or type "Done" to finish.');
                        if (telegramLog) addToLog(`Bot reminded user to upload screenshot or type 'Done'.`);
                    } else {
                        // General response for unexpected text messages in certain states
                        const errorMessage = `Unexpected text input for current step "${userState.step}". Please follow the instructions.`;
                        await sendTelegramMessage(chatId, errorMessage);
                        if (telegramLog) addToLog(`Sent error message to @${telegramUsername || 'N/A'}: ${errorMessage}`);
                    }
                } else if (message.document && userState.step === 'expectingAppFile') {
                    userState.appData.appFileId = message.document.file_id;
                    userState.step = 'expectingAppIcon';
                    telegramUserStates.set(chatId, userState);
                    // Automatically upload the app file to the designated Telegram group chat.
                    if (GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
                        await forwardTelegramMessage(GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING, chatId, messageId);
                    } else {
                        console.warn("GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING is not set. Cannot forward document.");
                    }
                    await sendTelegramMessage(chatId, 'App icon');
                    if (telegramLog) addToLog(`Bot asked for app icon.`);
                } else if (message.photo && userState.step === 'expectingAppIcon') {
                    userState.appData.appIconId = message.photo.pop().file_id;
                    userState.step = 'expectingAppDescription';
                    telegramUserStates.set(chatId, userState);
                    // Automatically upload the app icon to the designated Telegram group chat.
                    if (GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
                        await forwardTelegramMessage(GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING, chatId, messageId);
                    } else {
                        console.warn("GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING is not set. Cannot forward app icon.");
                    }
                    await sendTelegramMessage(chatId, 'App description');
                    if (telegramLog) addToLog(`Bot asked for app description.`);
                } else if (message.photo && userState.step === 'expectingAppScreenshot') {
                    if (!userState.appData.telegramScreenshotIds) {
                        userState.appData.telegramScreenshotIds = [];
                    }
                    userState.appData.telegramScreenshotIds.push(message.photo.pop().file_id);
                    // Automatically upload the app screenshot to the designated Telegram group chat.
                    if (GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING) {
                        await forwardTelegramMessage(GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING, chatId, messageId);
                    } else {
                        console.warn("GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING is not set. Cannot forward app screenshot.");
                    }
                    await sendTelegramMessage(chatId, 'Screenshot received! Send more, or type "Done" to finish.');
                    if (telegramLog) addToLog(`Bot asked for more screenshots or 'Done'.`);
                } else {
                    // General response for unexpected non-text message types
                    const errorMessage = `Unexpected file/photo input for current step "${userState.step}". Please follow the instructions.`;
                    await sendTelegramMessage(chatId, errorMessage);
                    if (telegramLog) addToLog(`Sent error message to @${telegramUsername || 'N/A'}: ${errorMessage}`);
                }
            } else {
                // Unauthorized user
                if (!messageText || (messageText.trim() !== '/start' && messageText.trim() !== 'User Details' && messageText.trim() !== 'Publish' && messageText.trim() !== 'Sync Apps' && telegramUserStates.get(chatId)?.step === 'idle')) {
                    await sendTelegramMessage(chatId, "This organization is not for staff or non staff individual");
                    if (telegramLog) addToLog(`Denied access to unauthorized user @${telegramUsername || 'N/A'} (Chat ID: ${chatId}).`);
                }
            }
        }
    }

    async function pollTelegram() {
        if (isCheckingTelegram) return;
        isCheckingTelegram = true;
        console.log("Starting Telegram poll...");

        // Ensure GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING is set if adminChatId is available
        // This is crucial for the bot to know where to forward published app files.
        if (!GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING && adminChatId) {
            GRANXY_APP_STORE_GROUP_CHAT_ID_FOR_FORWARDING = adminChatId;
        }

        while (true) {
            try {
                const updates = await getTelegramUpdates();
                for (const update of updates) {
                    await processTelegramUpdate(update); 
                }
            } catch (error) {
                console.error('Telegram polling error:', error);
                if (telegramLog) addToLog(`Error: ${error.message}. Retrying in 5 seconds.`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    backFromTelegramButton.addEventListener('click', (e) => {
        clickAnimation(e.currentTarget, () => {
            transitionToScreen(telegramBotBox, profileScreen);
        });
    });

    checkMessagesButton.addEventListener('click', async (e) => {
        clickAnimation(e.currentTarget, async () => {
            if (telegramLog) addToLog('Checking for new messages...');
            checkMessagesButton.disabled = true;
            checkMessagesButton.textContent = 'Checking...';

            try {
                const updates = await getTelegramUpdates();
                if (updates.length === 0) {
                    if (telegramLog) addToLog('No new messages found.');
                } else {
                    if (telegramLog) addToLog(`Found ${updates.length} new update(s).`);
                    for (const update of updates) {
                        await processTelegramUpdate(update); 
                    }
                }
            } catch (error) {
                console.error('Telegram API error:', error);
                if (telegramLog) addToLog(`Error: ${error.message}. Check console for details.`);
            } finally {
                checkMessagesButton.disabled = false;
                checkMessagesButton.textContent = 'Check for /start messages';
            }
        });
    });
});