require('dotenv').config({ path: '../backend/.env' });
const mqtt = require('mqtt');

const options = {
  port: process.env.MQTT_PORT,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  protocol: 'mqtts',
};

const client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

let doorStatus = 'closed';

client.on('connect', () => {
  console.log('Fake ESP32 connected to HiveMQ broker');

  // Publish fake sensor readings every 5 seconds
  setInterval(() => {
    const ldr = Math.floor(Math.random() * 1000);
    const battery = (3.0 + Math.random() * 1.2).toFixed(2);
    const rtcTime = new Date().toLocaleTimeString();

    client.publish('coop/door1/sensors/ldr', String(ldr));
    client.publish('coop/door1/sensors/rtc', rtcTime);
    client.publish('coop/door1/battery', battery);
    client.publish('coop/door1/sensors/limitswitch/top', doorStatus === 'open' ? 'pressed' : 'released');
    client.publish('coop/door1/sensors/limitswitch/bottom', doorStatus === 'closed' ? 'pressed' : 'released');

    console.log(`Published fake sensors: LDR=${ldr}, battery=${battery}V, time=${rtcTime}`);
  }, 5000);

  // Listen for commands from the backend, just like a real ESP32 would
  client.subscribe('coop/door1/command');
});

client.on('message', (topic, message) => {
  if (topic === 'coop/door1/command') {
    const command = message.toString();
    console.log(`Received command: ${command}`);

    if (command === 'open') {
      doorStatus = 'opening';
      client.publish('coop/door1/status', doorStatus);

      setTimeout(() => {
        doorStatus = 'open';
        client.publish('coop/door1/status', doorStatus);
        client.publish('coop/door1/events', JSON.stringify({ event: 'door_opened', message: 'Door opened successfully.' }));
      }, 3000); // simulate 3 seconds of motor movement
    }

    if (command === 'close') {
      doorStatus = 'closing';
      client.publish('coop/door1/status', doorStatus);

      setTimeout(() => {
        doorStatus = 'closed';
        client.publish('coop/door1/status', doorStatus);
        client.publish('coop/door1/events', JSON.stringify({ event: 'door_closed', message: 'Door closed successfully.' }));
      }, 3000);
    }
  }
});