const sellerForm = document.getElementById('sellerForm');
const sellerInput = document.getElementById('sellerInput');
const sellerList = document.getElementById('sellerList');
const clearSeenBtn = document.getElementById('clearSeenBtn');
const scanIntervalInput = document.getElementById('scanIntervalInput');
const setIntervalBtn = document.getElementById('setIntervalBtn');

// Clear Seen Items
clearSeenBtn.addEventListener('click', async () => {
    const confirmClear = confirm('Are you sure you want to clear all seen items? This cannot be undone.');
    if (confirmClear) {
        await window.api.clearSeenItems();
        alert('Seen items cleared!');
    }
});

// Set Scan Interval
async function loadScanInterval() {
    const interval = await window.api.getScanInterval();
    scanIntervalInput.value = interval || 120; // default 2 mins
}

setIntervalBtn.addEventListener('click', async () => {
    const val = parseInt(scanIntervalInput.value);
    if (isNaN(val) || val < 10) {
        alert('Please enter a valid number (>=10 seconds)');
        return;
    }
    await window.api.setScanInterval(val);
    alert(`Scan interval updated to ${val} seconds`);
});

// Load current interval on start
loadScanInterval();

async function refreshSellers() {
    const sellers = await window.api.getSellers();
    sellerList.innerHTML = '';
    sellers.forEach(seller => {
        const li = document.createElement('li');
        li.textContent = seller + ' ';

        const btn = document.createElement('button');
        btn.textContent = 'Remove';
        btn.addEventListener('click', async () => {
            await window.api.removeSeller(seller);
            refreshSellers();
        });

        li.appendChild(btn);
        sellerList.appendChild(li);
    });
}


sellerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const seller = sellerInput.value.trim();
    if (seller) {
        await window.api.addSeller(seller);
        sellerInput.value = '';
        refreshSellers();
    }
});

refreshSellers();
