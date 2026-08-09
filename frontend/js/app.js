const API_BASE = 'http://localhost:3000/api';
const WS_URL = 'ws://localhost:3000';

// ===== Notification banner =====
const banner = document.getElementById('notification-banner');
let bannerTimeout;

function showNotification(message, isError = false) {
  banner.textContent = message;
  banner.classList.toggle('danger', isError);
  banner.classList.remove('hidden');

  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, 4000);
}

// ===== Door status =====
const doorStatusEl = document.getElementById('door-status');
const openBtn = document.getElementById('open-btn');
const closeBtn = document.getElementById('close-btn');

let currentDoorStatus = null;

function setDoorStatus(status) {
  currentDoorStatus = status;
  doorStatusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  doorStatusEl.className = 'status-value ' + status;
}

async function loadDoorStatus() {
  try {
    const res = await fetch(`${API_BASE}/door/status`);
    const data = await res.json();
    setDoorStatus(data.status);

    automodeToggle.checked = !!data.auto_mode_enabled;
    automodeSource.value = data.auto_mode_source;
    updateAutomodeSourceState();
  } catch (err) {
    doorStatusEl.textContent = 'Unable to load';
    console.error('Failed to load door status:', err);
  }
}

// ===== Remote control buttons =====
openBtn.addEventListener('click', () => {
  if (currentDoorStatus === 'open' || currentDoorStatus === 'opening') {
    showNotification('Door is already open');
    return;
  }
  sendCommand('open');
});

closeBtn.addEventListener('click', () => {
  if (currentDoorStatus === 'closed' || currentDoorStatus === 'closing') {
    showNotification('Door is already closed');
    return;
  }
  sendCommand('close');
});

async function sendCommand(command) {
  try {
    const res = await fetch(`${API_BASE}/door/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) throw new Error('Command failed');
    showNotification(`Command sent: ${command}`);
  } catch (err) {
    showNotification('Failed to send command', true);
    console.error(err);
  }
}

// ===== Automatic mode =====
const automodeToggle = document.getElementById('automode-toggle');
const automodeSource = document.getElementById('automode-source');

function updateAutomodeSourceState() {
  automodeSource.disabled = !automodeToggle.checked;
}

automodeToggle.addEventListener('change', () => {
  updateAutomodeSourceState();
  saveAutoMode();
});
automodeSource.addEventListener('change', saveAutoMode);

async function saveAutoMode() {
  try {
    const res = await fetch(`${API_BASE}/door/automode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: automodeToggle.checked,
        source: automodeSource.value,
      }),
    });
    if (!res.ok) throw new Error('Failed to update auto mode');
    showNotification('Automatic mode updated');
  } catch (err) {
    showNotification('Failed to update automatic mode', true);
    console.error(err);
  }
}

// ===== Schedule (custom dropdown time picker) =====
function populateTimeDropdowns() {
  const hourOptions = Array.from({ length: 12 }, (_, i) => i + 1);
  const minuteOptions = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

  ['open-hour', 'close-hour'].forEach((id) => {
    const select = document.getElementById(id);
    hourOptions.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      select.appendChild(opt);
    });
  });

  ['open-minute', 'close-minute'].forEach((id) => {
    const select = document.getElementById(id);
    minuteOptions.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.appendChild(opt);
    });
  });
}

function set12HourPicker(prefix, time24) {
  const [hour24, minute] = time24.split(':').map(Number);
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  document.getElementById(`${prefix}-hour`).value = hour12;
  document.getElementById(`${prefix}-minute`).value = String(minute).padStart(2, '0');
  document.getElementById(`${prefix}-ampm`).value = ampm;
}

function get24HourValue(prefix) {
  let hour = parseInt(document.getElementById(`${prefix}-hour`).value);
  const minute = document.getElementById(`${prefix}-minute`).value;
  const ampm = document.getElementById(`${prefix}-ampm`).value;

  if (ampm === 'AM' && hour === 12) hour = 0;
  if (ampm === 'PM' && hour !== 12) hour += 12;

  return `${String(hour).padStart(2, '0')}:${minute}`;
}

async function loadSchedule() {
  try {
    const res = await fetch(`${API_BASE}/schedule`);
    const data = await res.json();
    set12HourPicker('open', data.open_time);
    set12HourPicker('close', data.close_time);
  } catch (err) {
    console.error('Failed to load schedule:', err);
  }
}

const saveScheduleBtn = document.getElementById('save-schedule-btn');
saveScheduleBtn.addEventListener('click', async () => {
  const open_time = get24HourValue('open');
  const close_time = get24HourValue('close');

  saveScheduleBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open_time, close_time }),
    });
    if (!res.ok) throw new Error('Failed to save schedule');
    showNotification('Schedule saved');
  } catch (err) {
    showNotification('Failed to save schedule', true);
    console.error(err);
  } finally {
    saveScheduleBtn.disabled = false;
  }
});

// ===== Settings =====
async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    const data = await res.json();
    document.getElementById('wifi-ssid').value = data.wifi_ssid || '';
    document.getElementById('light-sensitivity').value = data.light_sensitivity;
    document.getElementById('notify-open').checked = !!data.notify_open;
    document.getElementById('notify-close').checked = !!data.notify_close;
    document.getElementById('notify-battery').checked = !!data.notify_battery;
    document.getElementById('notify-jam').checked = !!data.notify_jam;
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

const saveSettingsBtn = document.getElementById('save-settings-btn');
saveSettingsBtn.addEventListener('click', async () => {
  const wifi_ssid = document.getElementById('wifi-ssid').value;
  const wifi_password = document.getElementById('wifi-password').value;
  const light_sensitivity = parseInt(document.getElementById('light-sensitivity').value);
  const notify_open = document.getElementById('notify-open').checked;
  const notify_close = document.getElementById('notify-close').checked;
  const notify_battery = document.getElementById('notify-battery').checked;
  const notify_jam = document.getElementById('notify-jam').checked;

  saveSettingsBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wifi_ssid: wifi_ssid || undefined,
        wifi_password: wifi_password || undefined,
        light_sensitivity: isNaN(light_sensitivity) ? undefined : light_sensitivity,
        notify_open,
        notify_close,
        notify_battery,
        notify_jam,
      }),
    });
    if (!res.ok) throw new Error('Failed to save settings');
    showNotification('Settings saved');
  } catch (err) {
    showNotification('Failed to save settings', true);
    console.error(err);
  } finally {
    saveSettingsBtn.disabled = false;
  }
});

// ===== Sensors =====
function updateSensorDisplay(data) {
  if (data.ldr_value !== undefined && data.ldr_value !== null) {
    const ldrText = (data.ldr_value == 1 || data.ldr_value === '1') ? 'Light' : 'Dark';
    document.getElementById('ldr-value').textContent = ldrText;
  }
  if (data.rtc_time) {
    document.getElementById('rtc-value').textContent = data.rtc_time;
  }
  if (data.limit_top) {
    document.getElementById('limit-top').textContent = data.limit_top;
  }
  if (data.limit_bottom) {
    document.getElementById('limit-bottom').textContent = data.limit_bottom;
  }
  if (data.battery_voltage !== undefined && data.battery_voltage !== null) {
    const batteryEl = document.getElementById('battery-value');
    batteryEl.textContent = `${data.battery_voltage} V`;
    batteryEl.classList.toggle('battery-low', parseFloat(data.battery_voltage) < 3.3);
  }
}

async function loadLatestSensors() {
  try {
    const res = await fetch(`${API_BASE}/sensors/latest`);
    const data = await res.json();
    updateSensorDisplay(data);
  } catch (err) {
    console.error('Failed to load sensor data:', err);
  }
}

// ===== History =====
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/history`);
    const data = await res.json();
    renderHistory(data);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function renderHistory(entries) {
  const list = document.getElementById('history-list');
  list.innerHTML = '';

  if (entries.length === 0) {
    list.innerHTML = '<li>No activity yet</li>';
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement('li');
    const time = new Date(entry.created_at).toLocaleString();
    li.textContent = `${time} — ${entry.message || entry.event_type}`;
    list.appendChild(li);
  });
}

// ===== WebSocket: live updates =====
function connectWebSocket() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => console.log('WebSocket connected');

  ws.onmessage = (event) => {
    const { topic, payload } = JSON.parse(event.data);

    switch (topic) {
      case 'coop/door1/status':
        setDoorStatus(payload);
        break;

      case 'coop/door1/sensors/ldr':
        updateSensorDisplay({ ldr_value: payload });
        break;

      case 'coop/door1/sensors/rtc':
        updateSensorDisplay({ rtc_time: payload });
        break;

      case 'coop/door1/sensors/limitswitch/top':
        updateSensorDisplay({ limit_top: payload });
        break;

      case 'coop/door1/sensors/limitswitch/bottom':
        updateSensorDisplay({ limit_bottom: payload });
        break;

      case 'coop/door1/battery':
        updateSensorDisplay({ battery_voltage: payload });
        break;

      case 'coop/door1/events':
        try {
          const eventData = JSON.parse(payload);
          const prefMap = {
            door_opened: 'notify-open',
            door_closed: 'notify-close',
            battery_low: 'notify-battery',
            motor_jammed: 'notify-jam',
          };
          const prefId = prefMap[eventData.event];
          const shouldNotify = !prefId || document.getElementById(prefId).checked;

          if (shouldNotify) {
            const isWarning = eventData.event === 'motor_jammed' || eventData.event === 'battery_low';
            showNotification(eventData.message || eventData.event, isWarning);
          }
          loadHistory();
        } catch (e) {
          console.error('Failed to parse event payload:', e);
        }
        break;
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected, retrying in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// ===== Initial load =====
populateTimeDropdowns();
loadDoorStatus();
loadSchedule();
loadSettings();
loadLatestSensors();
loadHistory();
connectWebSocket();