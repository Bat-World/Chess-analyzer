const keyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

// Load saved key (masked)
chrome.storage.sync.get('openaiApiKey', ({ openaiApiKey }) => {
  if (openaiApiKey) {
    keyInput.value = openaiApiKey;
    keyInput.type = 'password';
  }
});

saveBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key.startsWith('sk-')) {
    status.style.color = '#f44336';
    status.textContent = 'Invalid key — should start with sk-';
    return;
  }

  chrome.storage.sync.set({ openaiApiKey: key }, () => {
    status.style.color = '#8bc34a';
    status.textContent = 'Saved!';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});
