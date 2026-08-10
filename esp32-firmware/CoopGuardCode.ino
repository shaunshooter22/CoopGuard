// ============================================================
// ESP32 AUTOMATIC DOOR — CONNECTED VERSION
// (merged: teammate's hardware logic + CoopGuard MQTT/WiFi)
// ============================================================

#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ThreeWire.h>
#include <RtcDS1302.h>

// ============================================================
// L298N MOTOR
// ============================================================
const byte ENA = 25;
const byte IN1 = 26;
const byte IN2 = 27;

// ============================================================
// LIMIT SWITCHES
// ============================================================
const byte LIMIT_OPEN  = 32;
const byte LIMIT_CLOSE = 33;

// ============================================================
// LDR
// ============================================================
const byte LDR_PIN = 34;

// ============================================================
// MANUAL PUSHBUTTONS
// ============================================================
const byte OPEN_BUTTON  = 17;
const byte CLOSE_BUTTON = 13;

// ============================================================
// FUTURE BUZZER (reserved, not wired)
// ============================================================
const byte BUZZER_PIN = 22;

// ============================================================
// DS1302 RTC
// ============================================================
const byte RTC_CLK = 18;
const byte RTC_DAT = 19;
const byte RTC_RST = 21;

ThreeWire rtcWire(RTC_DAT, RTC_CLK, RTC_RST);
RtcDS1302<ThreeWire> Rtc(rtcWire);

// ============================================================
// MOTOR SETTINGS
// ============================================================
const byte OPEN_SPEED  = 150;
const byte CLOSE_SPEED = 150;
const unsigned long MOTOR_TIMEOUT = 15000UL;

// ============================================================
// PUSHBUTTON TRACKING
// ============================================================
bool previousOpenButton  = HIGH;
bool previousCloseButton = HIGH;
bool bothButtonsLatch = false;

// ============================================================
// DOOR STATE
// ============================================================
enum DoorState : byte { DOOR_UNKNOWN, DOOR_OPEN, DOOR_CLOSED, DOOR_MOVING, DOOR_ERROR };
DoorState doorState = DOOR_UNKNOWN;

// ============================================================
// WIFI + MQTT (CoopGuard backend connection)
// ============================================================
const char* mqtt_server = "d17d615b51994b7a80424af5b899f00b.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_username = "coopadmin";
const char* mqtt_password = "CoopDoor2026!Secure";

WiFiClientSecure espClient;
PubSubClient client(espClient);

unsigned long lastSensorPublish = 0;
const unsigned long SENSOR_PUBLISH_INTERVAL = 2000UL;

// ============================================================
// BOOT BUTTON — manual WiFi reset (hold 3s)
// ============================================================
#define BOOT_BUTTON_PIN 0
unsigned long bootButtonPressStart = 0;
bool bootButtonHeld = false;

// ============================================================
// SETUP
// ============================================================
void setup()
{
  Serial.begin(115200);
  delay(500);

  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  pinMode(LIMIT_OPEN, INPUT_PULLUP);
  pinMode(LIMIT_CLOSE, INPUT_PULLUP);

  pinMode(LDR_PIN, INPUT);

  pinMode(OPEN_BUTTON, INPUT_PULLUP);
  pinMode(CLOSE_BUTTON, INPUT_PULLUP);

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  stopMotor();

  setupRTC();

  previousOpenButton = digitalRead(OPEN_BUTTON);
  previousCloseButton = digitalRead(CLOSE_BUTTON);

  Serial.println();
  Serial.println("======================================");
  Serial.println("       ESP32 AUTOMATIC DOOR");
  Serial.println("       CONNECTED (MQTT) VERSION");
  Serial.println("======================================");

  detectDoorPosition();
  printRTC();
  printLimitStatus();

  setup_wifi();

  espClient.setInsecure();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

// ============================================================
// MAIN LOOP
// ============================================================
void loop()
{
  checkManualWifiReset();

  if (!client.connected()) {
    reconnect_mqtt();
  }
  client.loop();

  processManualButtons();
  processSerialCommands();

  if (millis() - lastSensorPublish >= SENSOR_PUBLISH_INTERVAL) {
    lastSensorPublish = millis();
    publishSensorReadings();
  }
}

// ============================================================
// WIFI SETUP
// ============================================================
void setup_wifi()
{
  WiFiManager wm;
  wm.setConnectTimeout(15);
  wm.setConfigPortalTimeout(180);

  bool connected = wm.autoConnect("CoopGuard-Setup");

  if (!connected) {
    Serial.println("Failed to connect, restarting...");
    delay(3000);
    ESP.restart();
  }

  Serial.println("WiFi connected");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
}

// ============================================================
// MQTT RECONNECT
// ============================================================
void reconnect_mqtt()
{
  while (!client.connected()) {
    Serial.print("Connecting to MQTT broker...");
    String clientId = "ESP32Client-" + String(random(0xffff), HEX);

    if (client.connect(clientId.c_str(), mqtt_username, mqtt_password)) {
      Serial.println("connected");
      client.subscribe("coop/door1/command");
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" trying again in 3 seconds");
      delay(3000);
    }
  }
}

// ============================================================
// MQTT CALLBACK — receives commands from the website/backend
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int length)
{
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.print("MQTT command received: ");
  Serial.println(message);

  if (String(topic) == "coop/door1/command") {
    if (message == "open") {
      openDoor();
    } else if (message == "close") {
      closeDoor();
    }
  }
}

// ============================================================
// PUBLISH LIVE SENSOR READINGS
// ============================================================
void publishSensorReadings()
{
  client.publish("coop/door1/sensors/ldr", isLight() ? "1" : "0");
  client.publish("coop/door1/sensors/limitswitch/top", openLimitPressed() ? "pressed" : "released");
  client.publish("coop/door1/sensors/limitswitch/bottom", closeLimitPressed() ? "pressed" : "released");

  if (Rtc.IsDateTimeValid()) {
    RtcDateTime now = Rtc.GetDateTime();
    int hour12 = now.Hour() % 12;
    if (hour12 == 0) hour12 = 12;
    const char* ampm = (now.Hour() >= 12) ? "PM" : "AM";

    char timeStr[12];
    snprintf(timeStr, sizeof(timeStr), "%02u:%02u:%02u %s", hour12, now.Minute(), now.Second(), ampm);
    client.publish("coop/door1/sensors/rtc", timeStr);
  }
}

// ============================================================
// MANUAL WIFI RESET (hold BOOT 3s)
// ============================================================
void checkManualWifiReset()
{
  if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (!bootButtonHeld) {
      bootButtonHeld = true;
      bootButtonPressStart = millis();
    } else if (millis() - bootButtonPressStart > 3000) {
      Serial.println("BOOT held 3+ seconds — resetting WiFi settings...");
      WiFiManager wm;
      wm.resetSettings();
      delay(500);
      ESP.restart();
    }
  } else {
    bootButtonHeld = false;
  }
}

// ============================================================
// MANUAL PUSHBUTTON CONTROL
// ============================================================
void processManualButtons()
{
  bool openState = digitalRead(OPEN_BUTTON);
  bool closeState = digitalRead(CLOSE_BUTTON);

  if (openState == LOW && closeState == LOW) {
    if (!bothButtonsLatch) {
      bothButtonsLatch = true;
      stopMotor();
      Serial.println("BOTH MANUAL BUTTONS PRESSED — MOTOR STOPPED FOR SAFETY");
    }
    previousOpenButton = openState;
    previousCloseButton = closeState;
    return;
  } else {
    bothButtonsLatch = false;
  }

  if (openState == LOW && previousOpenButton == HIGH) {
    delay(25);
    if (digitalRead(OPEN_BUTTON) == LOW) {
      previousOpenButton = LOW;
      Serial.println("PHYSICAL OPEN BUTTON PRESSED");
      openDoor();
      return;
    }
  }

  if (closeState == LOW && previousCloseButton == HIGH) {
    delay(25);
    if (digitalRead(CLOSE_BUTTON) == LOW) {
      previousCloseButton = LOW;
      Serial.println("PHYSICAL CLOSE BUTTON PRESSED");
      closeDoor();
      return;
    }
  }

  previousOpenButton = openState;
  previousCloseButton = closeState;
}

// ============================================================
// OPEN DOOR — OPEN = CLOCKWISE
// ============================================================
void openDoor()
{
  Serial.println("OPEN COMMAND — Direction: CLOCKWISE");
  client.publish("coop/door1/status", "opening");

  if (bothLimitsPressed()) {
    stopMotor();
    doorState = DOOR_ERROR;
    Serial.println("ERROR: BOTH LIMIT SWITCHES ACTIVE");
    return;
  }

  if (openLimitPressed()) {
    stopMotor();
    doorState = DOOR_OPEN;
    client.publish("coop/door1/status", "open");
    Serial.println("Door already OPEN.");
    return;
  }

  doorState = DOOR_MOVING;
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, OPEN_SPEED);

  unsigned long startTime = millis();

  while (!openLimitPressed()) {
    client.loop();

    if (digitalRead(CLOSE_BUTTON) == LOW) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("CLOSE BUTTON PRESSED DURING OPENING — MOTOR STOPPED");
      waitForButtonsReleased();
      detectDoorPosition();
      return;
    }

    if (bothLimitsPressed()) {
      stopMotor();
      doorState = DOOR_ERROR;
      Serial.println("ERROR: BOTH LIMITS ACTIVE");
      return;
    }

    if (serialStopRequested()) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("*** SERIAL STOP ***");
      detectDoorPosition();
      return;
    }

    if (millis() - startTime >= MOTOR_TIMEOUT) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("ERROR: OPEN TIMEOUT — Motor stopped for safety.");
      return;
    }
  }

  stopMotor();
  delay(30);

  if (openLimitPressed() && !closeLimitPressed()) {
    doorState = DOOR_OPEN;
    client.publish("coop/door1/status", "open");
    client.publish("coop/door1/events", "{\"event\":\"door_opened\",\"message\":\"Door opened successfully.\"}");
    Serial.println("OPEN LIMIT TRIGGERED — Door fully OPEN");
  } else {
    doorState = DOOR_UNKNOWN;
    Serial.println("WARNING: OPEN switch unstable.");
  }
}

// ============================================================
// CLOSE DOOR — CLOSE = ANTI-CLOCKWISE
// ============================================================
void closeDoor()
{
  Serial.println("CLOSE COMMAND — Direction: ANTI-CLOCKWISE");
  client.publish("coop/door1/status", "closing");

  if (bothLimitsPressed()) {
    stopMotor();
    doorState = DOOR_ERROR;
    Serial.println("ERROR: BOTH LIMIT SWITCHES ACTIVE");
    return;
  }

  if (closeLimitPressed()) {
    stopMotor();
    doorState = DOOR_CLOSED;
    client.publish("coop/door1/status", "closed");
    Serial.println("Door already CLOSED.");
    return;
  }

  doorState = DOOR_MOVING;
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, CLOSE_SPEED);

  unsigned long startTime = millis();

  while (!closeLimitPressed()) {
    client.loop();

    if (digitalRead(OPEN_BUTTON) == LOW) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("OPEN BUTTON PRESSED DURING CLOSING — MOTOR STOPPED");
      waitForButtonsReleased();
      detectDoorPosition();
      return;
    }

    if (bothLimitsPressed()) {
      stopMotor();
      doorState = DOOR_ERROR;
      Serial.println("ERROR: BOTH LIMITS ACTIVE");
      return;
    }

    if (serialStopRequested()) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("*** SERIAL STOP ***");
      detectDoorPosition();
      return;
    }

    if (millis() - startTime >= MOTOR_TIMEOUT) {
      stopMotor();
      doorState = DOOR_UNKNOWN;
      Serial.println("ERROR: CLOSE TIMEOUT — Motor stopped for safety.");
      return;
    }
  }

  stopMotor();
  delay(30);

  if (closeLimitPressed() && !openLimitPressed()) {
    doorState = DOOR_CLOSED;
    client.publish("coop/door1/status", "closed");
    client.publish("coop/door1/events", "{\"event\":\"door_closed\",\"message\":\"Door closed successfully.\"}");
    Serial.println("CLOSE LIMIT TRIGGERED — Door fully CLOSED");
  } else {
    doorState = DOOR_UNKNOWN;
    Serial.println("WARNING: CLOSE switch unstable.");
  }
}

// ============================================================
// WAIT FOR BOTH MANUAL BUTTONS RELEASED
// ============================================================
void waitForButtonsReleased()
{
  while (digitalRead(OPEN_BUTTON) == LOW || digitalRead(CLOSE_BUTTON) == LOW) {
    delay(10);
  }
  delay(30);
  previousOpenButton = HIGH;
  previousCloseButton = HIGH;
}

// ============================================================
// STOP MOTOR
// ============================================================
void stopMotor()
{
  analogWrite(ENA, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
}

// ============================================================
// SERIAL STOP (debug/testing)
// ============================================================
bool serialStopRequested()
{
  if (Serial.available() > 0) {
    char command = Serial.read();
    if (command >= 'a' && command <= 'z') command -= 32;
    if (command == 'S') return true;
  }
  return false;
}

// ============================================================
// LIMIT SWITCH FUNCTIONS
// ============================================================
bool openLimitPressed()  { return digitalRead(LIMIT_OPEN) == LOW; }
bool closeLimitPressed() { return digitalRead(LIMIT_CLOSE) == LOW; }
bool bothLimitsPressed() { return openLimitPressed() && closeLimitPressed(); }

// ============================================================
// LDR — confirmed: LIGHT = LOW, DARK = HIGH
// ============================================================
bool isLight() { return digitalRead(LDR_PIN) == LOW; }
bool isDark()  { return digitalRead(LDR_PIN) == HIGH; }

// ============================================================
// RTC SETUP
// ============================================================
void setupRTC()
{
  Rtc.Begin();
  Serial.println("Starting DS1302 RTC...");

  if (Rtc.GetIsWriteProtected()) {
    Rtc.SetIsWriteProtected(false);
  }

  if (!Rtc.GetIsRunning()) {
    Rtc.SetIsRunning(true);
  }

  if (!Rtc.IsDateTimeValid()) {
    RtcDateTime compiled = RtcDateTime(__DATE__, __TIME__);
    Rtc.SetDateTime(compiled);
    Serial.println("RTC time was invalid — set to compile time.");
  }
}

// ============================================================
// PRINT RTC
// ============================================================
void printRTC()
{
  Serial.println("--------- RTC ---------");
  if (!Rtc.IsDateTimeValid()) {
    Serial.println("RTC INVALID");
    return;
  }
  RtcDateTime now = Rtc.GetDateTime();
  Serial.print(now.Year()); Serial.print('/');
  printTwoDigits(now.Month()); Serial.print('/');
  printTwoDigits(now.Day());
  Serial.print("   TIME: ");
  printTwoDigits(now.Hour()); Serial.print(':');
  printTwoDigits(now.Minute()); Serial.print(':');
  printTwoDigits(now.Second());
  Serial.println();
  Serial.println("-----------------------");
}

void printTwoDigits(uint8_t number)
{
  if (number < 10) Serial.print('0');
  Serial.print(number);
}

// ============================================================
// DETECT DOOR POSITION
// ============================================================
void detectDoorPosition()
{
  bool openSW = openLimitPressed();
  bool closeSW = closeLimitPressed();

  if (openSW && !closeSW) {
    doorState = DOOR_OPEN;
    client.publish("coop/door1/status", "open");
    Serial.println("Door position: OPEN");
  } else if (!openSW && closeSW) {
    doorState = DOOR_CLOSED;
    client.publish("coop/door1/status", "closed");
    Serial.println("Door position: CLOSED");
  } else if (openSW && closeSW) {
    doorState = DOOR_ERROR;
    stopMotor();
    Serial.println("ERROR: BOTH LIMIT SWITCHES ACTIVE");
  } else {
    doorState = DOOR_UNKNOWN;
    Serial.println("Door position: BETWEEN LIMITS");
  }
}

// ============================================================
// LIMIT STATUS (debug print)
// ============================================================
void printLimitStatus()
{
  Serial.println("----- LIMIT TEST -----");
  Serial.print("OPEN  : "); Serial.println(openLimitPressed() ? "PRESSED / LOW" : "OFF / HIGH");
  Serial.print("CLOSE : "); Serial.println(closeLimitPressed() ? "PRESSED / LOW" : "OFF / HIGH");
  Serial.println("----------------------");
}

// ============================================================
// SERIAL COMMANDS (debug/testing only)
// ============================================================
void processSerialCommands()
{
  if (Serial.available() <= 0) return;

  char command = Serial.read();
  if (command == '\n' || command == '\r') return;
  if (command >= 'a' && command <= 'z') command -= 32;

  switch (command) {
    case 'O': openDoor(); break;
    case 'C': closeDoor(); break;
    case 'S': stopMotor(); Serial.println("*** MOTOR STOPPED ***"); break;
    case 'T': printLimitStatus(); break;
    case 'R': printRTC(); break;
  }
}