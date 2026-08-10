require('dotenv').config();
const mqtt = require('mqtt');
const db = require('./db');

const options = {
  port: process.env.MQTT_PORT,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: 'mqtts',
};

const client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

let latestSensorData = {
  ldr_value: null,
  rtc_time: null,
  limit_top: null,
  limit_bottom: null,
  battery_voltage: null,
};

// Tracks the last auto-command sent, to prevent rapid-fire toggling
let lastAutoCommand = null;
let lastAutoCommandTime = 0;
const AUTO_COMMAND_COOLDOWN_MS = 10000; // don't re-fire within 10s

client.on('connect', () => {
  console.log('Connected to HiveMQ broker');

  client.subscribe('coop/door1/status');
  client.subscribe('coop/door1/sensors/ldr');
  client.subscribe('coop/door1/sensors/rtc');
  client.subscribe('coop/door1/sensors/limitswitch/top');
  client.subscribe('coop/door1/sensors/limitswitch/bottom');
  client.subscribe('coop/door1/battery');
  client.subscribe('coop/door1/events');
});

client.on('error', (err) => {
  console.error('MQTT connection error:', err.message);
});

client.on('message', (topic, message) => {
  const payload = message.toString();
  console.log(`Received on ${topic}:`, payload);

  switch (topic) {
    // Telemetry only — NEVER publishes a command from here
    case 'coop/door1/status':
      db.run(
        'UPDATE door_state SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [payload]
      );
      break;

    case 'coop/door1/sensors/ldr':
      latestSensorData.ldr_value = parseInt(payload);
      saveSensorSnapshot();
      evaluateAutoMode();
      break;

    case 'coop/door1/sensors/rtc':
      latestSensorData.rtc_time = payload;
      saveSensorSnapshot();
      evaluateAutoMode();
      break;

    // Telemetry only — limit switches NEVER trigger a command here
    case 'coop/door1/sensors/limitswitch/top':
      latestSensorData.limit_top = payload;
      saveSensorSnapshot();
      break;

    case 'coop/door1/sensors/limitswitch/bottom':
      latestSensorData.limit_bottom = payload;
      saveSensorSnapshot();
      break;

    case 'coop/door1/battery':
      latestSensorData.battery_voltage = parseFloat(payload);
      saveSensorSnapshot();
      break;

    case 'coop/door1/events':
      try {
        const data = JSON.parse(payload);
        db.run(
          'INSERT INTO activity_log (event_type, message) VALUES (?, ?)',
          [data.event, data.message || null]
        );
      } catch (e) {
        console.error('Failed to parse event payload:', e.message);
      }
      break;
  }
});

function saveSensorSnapshot() {
  const { ldr_value, rtc_time, limit_top, limit_bottom, battery_voltage } = latestSensorData;
  db.run(
    `INSERT INTO sensor_readings (ldr_value, rtc_time, limit_top, limit_bottom, battery_voltage)
     VALUES (?, ?, ?, ?, ?)`,
    [ldr_value, rtc_time, limit_top, limit_bottom, battery_voltage]
  );
}

function to24HourMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function rtcPayloadToMinutes(payload) {
  const match = payload.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  let [, hour, minute, , ampm] = match;
  hour = parseInt(hour);
  minute = parseInt(minute);

  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;

  return hour * 60 + minute;
}

// Sends a command through a single controlled path, with logging + cooldown
function sendDoorCommand(command, source) {
  const now = Date.now();

  // Cooldown: don't re-send the same auto-command within the window
  if (command === lastAutoCommand && now - lastAutoCommandTime < AUTO_COMMAND_COOLDOWN_MS) {
    return;
  }

  lastAutoCommand = command;
  lastAutoCommandTime = now;

  console.log('[MOTOR COMMAND]', {
    command,
    source,
    timestamp: new Date().toISOString(),
    retain: false,
  });

  client.publish('coop/door1/command', command, { qos: 1, retain: false });
}

// Single, combined decision — evaluates LDR and/or RTC together,
// depending on auto_mode_source, and only sends ONE command if needed.
function evaluateAutoMode() {
  db.get('SELECT * FROM door_state WHERE id = 1', (err, doorRow) => {
    if (err || !doorRow) return;

    const { auto_mode_enabled, auto_mode_source, status } = doorRow;
    if (!auto_mode_enabled) return;

    // Only act once the door has settled into a stable state
    // (avoid firing new commands while it's mid-movement)
    if (status !== 'open' && status !== 'closed') return;

    let ldrDesiredOpen = null;
    let rtcDesiredOpen = null;

    if (auto_mode_source === 'ldr' || auto_mode_source === 'both') {
      if (latestSensorData.ldr_value !== null) {
        ldrDesiredOpen = latestSensorData.ldr_value === 1;
      }
    }

    proceedWithSchedule();

    function proceedWithSchedule() {
      if (auto_mode_source === 'rtc' || auto_mode_source === 'both') {
        db.get('SELECT open_time, close_time FROM schedule WHERE id = 1', (err2, scheduleRow) => {
          if (err2 || !scheduleRow || !latestSensorData.rtc_time) {
            finalizeDecision();
            return;
          }

          const nowMinutes = rtcPayloadToMinutes(latestSensorData.rtc_time);
          if (nowMinutes !== null) {
            const openMinutes = to24HourMinutes(scheduleRow.open_time);
            const closeMinutes = to24HourMinutes(scheduleRow.close_time);

            rtcDesiredOpen = openMinutes <= closeMinutes
              ? (nowMinutes >= openMinutes && nowMinutes < closeMinutes)
              : (nowMinutes >= openMinutes || nowMinutes < closeMinutes); // handles overnight windows
          }

          finalizeDecision();
        });
      } else {
        finalizeDecision();
      }
    }

    function finalizeDecision() {
      let desiredOpen;

      if (auto_mode_source === 'both') {
        // Both must be known and AGREE before acting — prevents the
        // exact conflict loop that caused the safety bug.
        if (ldrDesiredOpen === null || rtcDesiredOpen === null) return;
        if (ldrDesiredOpen !== rtcDesiredOpen) {
          // LDR and schedule disagree — do nothing, don't fight.
          return;
        }
        desiredOpen = ldrDesiredOpen;
      } else if (auto_mode_source === 'ldr') {
        if (ldrDesiredOpen === null) return;
        desiredOpen = ldrDesiredOpen;
      } else if (auto_mode_source === 'rtc') {
        if (rtcDesiredOpen === null) return;
        desiredOpen = rtcDesiredOpen;
      } else {
        return;
      }

      if (desiredOpen && status === 'closed') {
        sendDoorCommand('open', auto_mode_source);
      } else if (!desiredOpen && status === 'open') {
        sendDoorCommand('close', auto_mode_source);
      }
      // If desiredOpen already matches status, do nothing — no repeat command.
    }
  });
}

module.exports = client;