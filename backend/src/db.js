const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database', 'coop.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to database:', err.message);
  } else {
    console.log('Connected to SQLite database at', dbPath);
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS door_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'closed',
    auto_mode_enabled BOOLEAN NOT NULL DEFAULT 1,
    auto_mode_source TEXT NOT NULL DEFAULT 'both',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    open_time TEXT NOT NULL DEFAULT '06:00',
    close_time TEXT NOT NULL DEFAULT '18:30'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    light_sensitivity INTEGER NOT NULL DEFAULT 500,
    wifi_ssid TEXT,
    wifi_password TEXT,
    notify_open BOOLEAN DEFAULT 1,
    notify_close BOOLEAN DEFAULT 1,
    notify_battery BOOLEAN DEFAULT 1,
    notify_jam BOOLEAN DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ldr_value INTEGER,
    rtc_time TEXT,
    limit_top TEXT,
    limit_bottom TEXT,
    battery_voltage REAL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`INSERT OR IGNORE INTO door_state (id) VALUES (1)`);
  db.run(`INSERT OR IGNORE INTO schedule (id) VALUES (1)`);
  db.run(`INSERT OR IGNORE INTO settings (id) VALUES (1)`);
});

module.exports = db;