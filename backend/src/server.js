require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mqttClient = require('./mqttClient');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  console.log('Website connected via WebSocket');
  clients.add(ws);

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

app.get('/api/door/status', (req, res) => {
  db.get('SELECT * FROM door_state WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.post('/api/door/command', (req, res) => {
  const { command } = req.body;

  if (command !== 'open' && command !== 'close') {
    return res.status(400).json({ error: 'Command must be "open" or "close"' });
  }

  mqttClient.publish('coop/door1/command', command);
  res.json({ message: `Command "${command}" sent to door` });
});

app.get('/api/door/automode', (req, res) => {
  db.get('SELECT auto_mode_enabled, auto_mode_source FROM door_state WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.post('/api/door/automode', (req, res) => {
  const { enabled, source } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '"enabled" must be true or false' });
  }
  if (!['ldr', 'rtc', 'both'].includes(source)) {
    return res.status(400).json({ error: '"source" must be "ldr", "rtc", or "both"' });
  }

  db.run(
    'UPDATE door_state SET auto_mode_enabled = ?, auto_mode_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [enabled ? 1 : 0, source],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      mqttClient.publish('coop/door1/config/automode', JSON.stringify({ enabled, source }));
      res.json({ message: 'Auto mode settings updated', enabled, source });
    }
  );
});

app.get('/api/schedule', (req, res) => {
  db.get('SELECT open_time, close_time FROM schedule WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.post('/api/schedule', (req, res) => {
  const { open_time, close_time } = req.body;

  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timePattern.test(open_time) || !timePattern.test(close_time)) {
    return res.status(400).json({ error: 'Times must be in HH:MM 24-hour format' });
  }

  db.run(
    'UPDATE schedule SET open_time = ?, close_time = ? WHERE id = 1',
    [open_time, close_time],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      mqttClient.publish('coop/door1/config/schedule', JSON.stringify({ open_time, close_time }));
      res.json({ message: 'Schedule updated', open_time, close_time });
    }
  );
});

app.get('/api/settings', (req, res) => {
  db.get('SELECT * FROM settings WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.post('/api/settings', (req, res) => {
  const {
    light_sensitivity,
    wifi_ssid,
    wifi_password,
    notify_open,
    notify_close,
    notify_battery,
    notify_jam,
  } = req.body;

  db.run(
    `UPDATE settings SET
      light_sensitivity = COALESCE(?, light_sensitivity),
      wifi_ssid = COALESCE(?, wifi_ssid),
      wifi_password = COALESCE(?, wifi_password),
      notify_open = COALESCE(?, notify_open),
      notify_close = COALESCE(?, notify_close),
      notify_battery = COALESCE(?, notify_battery),
      notify_jam = COALESCE(?, notify_jam)
    WHERE id = 1`,
    [light_sensitivity, wifi_ssid, wifi_password, notify_open, notify_close, notify_battery, notify_jam],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      mqttClient.publish('coop/door1/config/sensitivity', String(light_sensitivity ?? ''));
      res.json({ message: 'Settings updated' });
    }
  );
});

app.get('/api/sensors/latest', (req, res) => {
  db.get('SELECT * FROM sensor_readings ORDER BY id DESC LIMIT 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || {});
  });
});

app.get('/api/sensors/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  db.all('SELECT * FROM sensor_readings ORDER BY id DESC LIMIT ?', [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  db.all('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?', [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

mqttClient.on('message', (topic, message) => {
  broadcast({ topic, payload: message.toString() });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});