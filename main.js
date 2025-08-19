const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
// const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const axios = require('axios');

let win;
// let POLL_INTERVAL = 1000 * 60 * 2; // every 2 minutes
const PLAYER_FILE = path.join(__dirname, 'player.json');
const SEEN_FILE = path.join(__dirname, 'seenItems.json');
let seenItems = new Set();
let errorNotified = false; // track if we already showed an error
let scanIntervalTimer;
async function startScanInterval(seconds) {
  if (scanIntervalTimer) clearTimeout(scanIntervalTimer);

  async function tick() {
    await checkSellers();
    scanIntervalTimer = setTimeout(tick, seconds * 1000);
  }

  tick(); // start first tick immediately
}
// Create window
function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');
}

async function refreshToken(clientId, clientSecret, refreshToken) {
  try {
    new Notification({
      title: 'eBay Scanner',
      body: `Refreshing Token...`
    }).show();
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    console.log(auth);

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('scope', 'https://api.ebay.com/oauth/api_scope');

    const res = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        }
      }
    );

    return res.data.access_token;
  } catch (err) {
    console.error('Failed to refresh eBay token:', err.response?.data || err.message);
    return null; // so calling function can handle it
  }
}


async function getAccessToken() {
  const config = await readConfig();
  // optionally check expiry here
  const token = await refreshToken(config.clientId, config.clientSecret, config.refreshToken);
  return token;
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
  if (!fs.existsSync(PLAYER_FILE)) {
    // create a default if missing
    const defaultConfig = { authToken: '', clientSecret: '', clientId: '', refreshToken: '', sellers: [], scanIntervalInSeconds: 120 };
    fs.writeFileSync(PLAYER_FILE, JSON.stringify(defaultConfig, null, 2));
  }
  return JSON.parse(fs.readFileSync(PLAYER_FILE, 'utf-8'));
}

function writeConfig(config) {
  fs.writeFileSync(PLAYER_FILE, JSON.stringify(config, null, 2));
}

function getSellers() {
  return readConfig().sellers || [];
}

function addSeller(seller) {
  const config = readConfig();
  if (!config.sellers.includes(seller)) {
    config.sellers.push(seller);
    writeConfig(config);
  }
}

function removeSeller(seller) {
  const config = readConfig();
  config.sellers = config.sellers.filter(s => s !== seller);
  writeConfig(config);
}

// Poll eBay Browse API
async function checkSellers() {
  const accessToken = await getAccessToken();
  const config = readConfig();
  const { sellers } = config;

  if (!accessToken || sellers.length === 0) return;

  // "scanning started"
  new Notification({
    title: 'eBay Scanner',
    body: `Scanning ${sellers.length} seller(s) for new listings...`
  }).show();

  for (let seller of sellers) {
    try {
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?filter=sellers:{${seller}}&q=lego&sort=newlyListed&limit=50`;
      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = res.data;
      if (!data.itemSummaries) continue;

      // 🔔 Test notification when results are retrieved
      // new Notification({
      //   title: 'eBay Scanner',
      //   body: `Retrieved ${data.itemSummaries.length} items for ${seller}`
      // }).show();

      let newItemsFound = false

      data.itemSummaries.forEach(item => {
        if (!seenItems.has(item.itemId)) {
          seenItems.add(item.itemId);
          new Notification({
            title: `New item by ${seller}`,
            body: item.title
          }).show();
          newItemsFound = true
        }
      });

      if (newItemsFound) saveSeenItems()

      errorNotified = false;
    } catch (err) {
      console.error(`Error checking seller ${seller}`, err);
      if (!errorNotified) {
        if (err.status && err.status == 429) {
          new Notification({
            title: 'eBay Scanner - Error',
            body: `You have exceeded the eBay rate limit for today. Recommend adjusting interval settings.`
          }).show();
          errorNotified = true;
        } else {
          new Notification({
            title: 'eBay Scanner - Error',
            body: `An error occurred while scanning sellers. Check logs.`
          }).show();
          errorNotified = true;
        }

      }
    }

  }
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
  return config.scanIntervalInSeconds || 120;
});

ipcMain.handle('set-scan-interval', async (_, sec) => {
  const config = readConfig();
  config.scanIntervalInSeconds = sec;
  await fs.promises.writeFile(PLAYER_FILE, JSON.stringify(config, null, 2));

  startScanInterval(sec);
});



app.whenReady().then(() => {
  createWindow();

  const config = readConfig();
  const sellers = Array.isArray(config.sellers) ? config.sellers : [];
  const intervalSec = !isNaN(config.scanIntervalInSeconds) ? config.scanIntervalInSeconds : 120;

  new Notification({
    title: 'eBay Scanner',
    body: `Scanner started successfully. Tracking ${sellers.length} seller(s).`
  }).show();

  // Start interval
  startScanInterval(intervalSec);

  // Kick off first scan immediately
  checkSellers();
});


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
