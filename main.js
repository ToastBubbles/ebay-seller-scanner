const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

let win;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SEEN_FILE = path.join(__dirname, 'seenItems.json');
let seenItems = new Set();
let errorNotified = false;
let scanIntervalTimer;
let accessToken;
let tokenExpiry = 0;
let callCounter = 0;
let currentSellerIndex = 0; // Track current seller to scan
const defaultInterval = 30

async function startScanInterval(seconds) {
  if (scanIntervalTimer) clearTimeout(scanIntervalTimer);

  async function tick() {
    await checkSellers();
    scanIntervalTimer = setTimeout(tick, seconds * 1000);
  }

  tick(); // Start first tick immediately
}

// Create window
function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    },
    icon:'images/icon.ico'
  });


  win.loadFile('index.html');
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken; // Reuse if not expired
  }

  const config = readConfig();
  const { clientId, clientSecret } = config;

  if (!clientId || !clientSecret) {
    console.error('Missing clientId or clientSecret in config');
    return null;
  }

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('scope', 'https://api.ebay.com/oauth/api_scope');

    console.log('refreshing token...');

    const res = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        }
      }
    );

    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000; // Buffer 1 min
    return accessToken;
  } catch (err) {
    console.error('Failed to get eBay access token:', err.response?.data || err.message);
    return null;
  }
}

function loadSeenItems() {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
    return new Set(data);
  } catch (err) {
    console.error('Failed to load seen items:', err);
    return new Set();
  }
}

seenItems = loadSeenItems();

function saveSeenItems() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenItems], null, 2));
  } catch (err) {
    console.error('Failed to save seen items:', err);
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = { clientId: '', clientSecret: '', sellers: [], scanIntervalInSeconds: defaultInterval };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getSellers() {
  return readConfig().sellers || [];
}

function addSeller(seller) {
  const config = readConfig();
  if (!config.sellers.includes(seller)) {
    config.sellers.push(seller);
    writeConfig(config);
    currentSellerIndex = 0; // Reset index on seller list change
  }
}

function removeSeller(seller) {
  const config = readConfig();
  config.sellers = config.sellers.filter(s => s !== seller);
  writeConfig(config);
  currentSellerIndex = 0; // Reset index on seller list change
}

// Poll eBay Browse API for one seller per interval
async function checkSellers() {
  const token = await getAccessToken();
  const config = readConfig();
  const { sellers } = config;

  if (!token || sellers.length === 0) {
    if (!token && !errorNotified) {
      new Notification({
        title: 'eBay Scanner - Error',
        body: 'Failed to obtain access token. Check clientId/clientSecret in config.json.'
      }).show();
      errorNotified = true;
    }
    return;
  }

  // Get the current seller to scan
  const seller = sellers[currentSellerIndex];
  new Notification({
    title: 'eBay Scanner',
    body: `Scanning seller ${seller} for new listings...`
  }).show();

  try {
    callCounter++;
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?filter=sellers:{${seller}}&q=lego&sort=newlyListed&limit=50`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = res.data;
    if (data.itemSummaries) {
      let newItemsFound = false;
      data.itemSummaries.forEach(item => {
        if (!seenItems.has(item.itemId)) {
          seenItems.add(item.itemId);
          new Notification({
            title: `New item by ${seller}`,
            body: item.title
          }).show();
          newItemsFound = true;
        }
      });

      if (newItemsFound) saveSeenItems();
    }

    errorNotified = false;
  } catch (err) {
    console.error(`Error checking seller ${seller}`, err);
    if (!errorNotified) {
      if (err.response?.status === 429) {
        new Notification({
          title: 'eBay Scanner - Error',
          body: 'Exceeded eBay rate limit. Adjust scan interval.'
        }).show();
      } else {
        new Notification({
          title: 'eBay Scanner - Error',
          body: `Scan error for ${seller}. Check logs.`
        }).show();
      }
      errorNotified = true;
    }
  }

  // Move to next seller, loop back if at the end
  currentSellerIndex = (currentSellerIndex + 1) % sellers.length;
  console.log(`${callCounter} calls made, next seller index: ${currentSellerIndex}`);
}

// IPC events
ipcMain.handle('get-sellers', () => getSellers());
ipcMain.handle('add-seller', (_, seller) => {
  addSeller(seller);
  return getSellers();
});
ipcMain.handle('remove-seller', (_, seller) => {
  removeSeller(seller);
  return getSellers();
});

ipcMain.handle('clear-seen-items', () => {
  seenItems.clear();
  fs.writeFileSync(SEEN_FILE, JSON.stringify([], null, 2));
});

ipcMain.handle('get-scan-interval', () => {
  const config = readConfig();
  return config.scanIntervalInSeconds || defaultInterval;
});

ipcMain.handle('set-scan-interval', async (_, sec) => {
  const config = readConfig();
  config.scanIntervalInSeconds = sec;
  await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  startScanInterval(sec);
});

app.whenReady().then(() => {
  createWindow();

  const config = readConfig();
  const sellers = Array.isArray(config.sellers) ? config.sellers : [];
  const intervalSec = !isNaN(config.scanIntervalInSeconds) ? config.scanIntervalInSeconds : defaultInterval;

  new Notification({
    title: 'eBay Scanner',
    body: `Scanner started. Tracking ${sellers.length} seller(s).`
  }).show();

  startScanInterval(intervalSec);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});