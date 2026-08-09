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
    case 'coop/door1/status':
      db.run(
        'UPDATE door_state SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [payload]
      );
      break;

    case 'coop/door1/sensors/ldr':
      latestSensorData.ldr_value = parseInt(payload);
      saveSensorSnapshot();
      evaluateAutoMode('ldr', payload);
      break;

    case 'coop/door1/sensors/rtc':
      latestSensorData.rtc_time = payload;
      saveSensorSnapshot();
      evaluateAutoMode('rtc', payload);
      break;

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

// Converts "HH:MM" (24hr) into total minutes since midnight
function to24HourMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Converts "hh:mm:ss AM/PM" (from the ESP32's RTC) into total minutes since midnight
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

// Decides whether to auto-open/close the door based on the latest sensor reading,
// current door status, and the saved automatic-mode settings.
function evaluateAutoMode(source, payload) {
  db.get('SELECT * FROM door_state WHERE id = 1', (err, doorRow) => {
    if (err || !doorRow) return;

    const { auto_mode_enabled, auto_mode_source, status } = doorRow;

    if (!auto_mode_enabled) return;
    if (auto_mode_source !== source && auto_mode_source !== 'both') return;

    if (source === 'ldr') {
      const isLight = payload === '1';

      if (isLight && status === 'closed') {
        console.log('Auto mode: light detected, opening door');
        client.publish('coop/door1/command', 'open');
      } else if (!isLight && status === 'open') {
        console.log('Auto mode: dark detected, closing door');
        client.publish('coop/door1/command', 'close');
      }
    }

    if (source === 'rtc') {
      db.get('SELECT open_time, close_time FROM schedule WHERE id = 1', (err2, scheduleRow) => {
        if (err2 || !scheduleRow) return;

        const nowMinutes = rtcPayloadToMinutes(payload);
        if (nowMinutes === null) return;

        const openMinutes = to24HourMinutes(scheduleRow.open_time);
        const closeMinutes = to24HourMinutes(scheduleRow.close_time);

        const shouldBeOpen = nowMinutes >= openMinutes && nowMinutes < closeMinutes;

        if (shouldBeOpen && status === 'closed') {
          console.log('Auto mode: schedule says open, opening door');
          client.publish('coop/door1/command', 'open');
        } else if (!shouldBeOpen && status === 'open') {
          console.log('Auto mode: schedule says closed, closing door');
          client.publish('coop/door1/command', 'close');
        }
      });
    }
  });
}

module.exports = client;