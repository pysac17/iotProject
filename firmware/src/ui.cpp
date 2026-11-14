// Person 1: see include/ui.h
#include "ui.h"

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "iot_pins.h"

namespace {

constexpr uint32_t DEBOUNCE_MS          = 30;
constexpr uint32_t OLED_OFF_AFTER_AWAY  = 10UL * 60 * 1000;  // power saving
constexpr uint32_t ALERT_TIMEOUT_MS     = 60UL * 1000;
constexpr uint32_t ALERT_REPEAT_MS      = 15UL * 1000;       // replay the buzzer while unacked

Adafruit_SSD1306 oled(128, 64, &SPI, IoTPins::OLED_DC, IoTPins::OLED_RST, IoTPins::OLED_CS);
bool oledOk   = false;
bool screenOn = true;

// ---- buttons ----
struct Button {
  uint8_t  pin;
  bool     stable;
  bool     lastRaw;
  uint32_t changedMs;
};
Button buttons[2];

ButtonEvent queue[4];
uint8_t qHead = 0, qLen = 0;

void pushEvent(ButtonEvent e) {
  if (qLen == sizeof(queue) / sizeof(queue[0])) return;  // drop if full
  queue[(qHead + qLen) % 4] = e;
  qLen++;
}

// ---- buzzer patterns ----
struct Note {
  uint16_t freq;  // 0 = silence
  uint16_t ms;
};
const Note BREAK_TUNE[]   = {{1760, 150}, {0, 100}, {1760, 150}, {0, 100}, {2093, 350}};
const Note START_TUNE[]   = {{1319, 60}, {0, 40}, {1760, 90}};
const Note STOP_TUNE[]    = {{1760, 60}, {0, 40}, {1319, 90}};
const Note DISTRACT_TUNE[] = {{880, 90}};

const Note* tune = nullptr;
uint8_t  tuneLen = 0, tuneIdx = 0;
uint32_t noteStartMs = 0;

void playNote(uint16_t f) {
  if (f) tone(IoTPins::BUZZER, f);
  else   noTone(IoTPins::BUZZER);
}

void startTune(const Note* t, uint8_t len, uint32_t nowMs) {
  tune = t;
  tuneLen = len;
  tuneIdx = 0;
  noteStartMs = nowMs;
  playNote(t[0].freq);
}

void serviceTune(uint32_t nowMs) {
  if (!tune || nowMs - noteStartMs < tune[tuneIdx].ms) return;
  if (++tuneIdx >= tuneLen) {
    noTone(IoTPins::BUZZER);
    tune = nullptr;
    return;
  }
  noteStartMs = nowMs;
  playNote(tune[tuneIdx].freq);
}

// ---- alert / state / screen ----
bool       alertActive  = false;
uint32_t   alertStartMs = 0;
uint32_t   alertTuneMs  = 0;
FocusState curState     = FocusState::Away;
uint32_t   awaySinceMs  = 0;

void setScreen(bool on) {
  if (on == screenOn || !oledOk) return;
  screenOn = on;
  oled.ssd1306_command(on ? SSD1306_DISPLAYON : SSD1306_DISPLAYOFF);
}

void setLeds(bool red, bool yellow, bool green) {
  digitalWrite(IoTPins::LED_1, red);
  digitalWrite(IoTPins::LED_2, yellow);
  digitalWrite(IoTPins::LED_3, green);
}

void onPress(int idx, uint32_t nowMs) {
  if (!screenOn) {  // first press only wakes the screen
    setScreen(true);
    awaySinceMs = nowMs;
    return;
  }
  if (alertActive) {  // first press only silences the alert
    alertActive = false;
    noTone(IoTPins::BUZZER);
    tune = nullptr;
    return;
  }
  pushEvent(idx == 0 ? ButtonEvent::SessionToggle : ButtonEvent::Distraction);
}

void pollButtons(uint32_t nowMs) {
  for (int i = 0; i < 2; i++) {
    Button& b = buttons[i];
    bool raw = digitalRead(b.pin);
    if (raw != b.lastRaw) {
      b.lastRaw = raw;
      b.changedMs = nowMs;
    } else if (raw != b.stable && nowMs - b.changedMs >= DEBOUNCE_MS) {
      b.stable = raw;
      if (raw == LOW) onPress(i, nowMs);  // INPUT_PULLUP: pressed = LOW
    }
  }
}

const char* stateLabel(FocusState s) {
  switch (s) {
    case FocusState::Focused:  return "FOCUSED";
    case FocusState::Restless: return "RESTLESS";
    default:                   return "AWAY";
  }
}

void fmtDuration(char* buf, size_t n, uint32_t s) {
  unsigned long h = s / 3600, m = (s / 60) % 60, sec = s % 60;
  if (h) snprintf(buf, n, "%lu:%02lu:%02lu", h, m, sec);
  else   snprintf(buf, n, "%02lu:%02lu", m, sec);
}

}  // namespace

void uiBegin() {
  pinMode(IoTPins::LED_1, OUTPUT);
  pinMode(IoTPins::LED_2, OUTPUT);
  pinMode(IoTPins::LED_3, OUTPUT);
  setLeds(false, false, false);
  pinMode(IoTPins::BUZZER, OUTPUT);

  const uint8_t pins[2] = {IoTPins::BUTTON_1, IoTPins::BUTTON_2};
  for (int i = 0; i < 2; i++) {
    pinMode(pins[i], INPUT_PULLUP);
    buttons[i] = {pins[i], HIGH, HIGH, 0};
  }

  SPI.begin(IoTPins::SPI_SCK, IoTPins::SPI_MISO, IoTPins::SPI_MOSI);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC);
  if (!oledOk) {
    Serial.println("[ui] OLED init failed");
    return;
  }
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(2);
  oled.setCursor(0, 0);
  oled.println("Focus");
  oled.println("Timer");
  oled.setTextSize(1);
  oled.println("\nGroup 20 - starting");
  oled.display();
}

void uiLoop(uint32_t nowMs) {
  pollButtons(nowMs);
  serviceTune(nowMs);

  if (alertActive) {
    if (nowMs - alertStartMs >= ALERT_TIMEOUT_MS) {
      alertActive = false;
    } else if (!tune && nowMs - alertTuneMs >= ALERT_REPEAT_MS) {
      alertTuneMs = nowMs;
      startTune(BREAK_TUNE, sizeof(BREAK_TUNE) / sizeof(Note), nowMs);
    }
  }

  // Screen off after a long time away (saves ~15 mA, see power budget).
  if (screenOn && !alertActive && curState == FocusState::Away &&
      nowMs - awaySinceMs >= OLED_OFF_AFTER_AWAY) {
    setScreen(false);
  }

  if (!screenOn) {
    setLeds(false, false, false);
  } else if (alertActive) {
    setLeds((nowMs / 250) % 2, false, false);  // flash red at 2 Hz
  } else {
    setLeds(curState == FocusState::Away,
            curState == FocusState::Restless,
            curState == FocusState::Focused);
  }
}

ButtonEvent uiTakeButton() {
  if (!qLen) return ButtonEvent::None;
  ButtonEvent e = queue[qHead];
  qHead = (qHead + 1) % 4;
  qLen--;
  return e;
}

void uiSetState(FocusState s, uint32_t nowMs) {
  if (s == FocusState::Away && curState != FocusState::Away) awaySinceMs = nowMs;
  if (s != FocusState::Away) setScreen(true);
  curState = s;
}

void uiPlay(Sound s, uint32_t nowMs) {
  if (alertActive) return;  // don't cut off the break alert
  switch (s) {
    case Sound::SessionStart: startTune(START_TUNE, sizeof(START_TUNE) / sizeof(Note), nowMs); break;
    case Sound::SessionStop:  startTune(STOP_TUNE, sizeof(STOP_TUNE) / sizeof(Note), nowMs); break;
    case Sound::Distraction:  startTune(DISTRACT_TUNE, sizeof(DISTRACT_TUNE) / sizeof(Note), nowMs); break;
  }
}

void uiStartBreakAlert(uint32_t nowMs) {
  alertActive  = true;
  alertStartMs = nowMs;
  alertTuneMs  = nowMs;
  setScreen(true);
  startTune(BREAK_TUNE, sizeof(BREAK_TUNE) / sizeof(Note), nowMs);
}

bool uiAlertActive() { return alertActive; }

void uiDraw(const UiView& v) {
  if (!oledOk || !screenOn) return;
  char buf[24];
  oled.clearDisplay();

  if (alertActive) {
    oled.fillScreen(SSD1306_WHITE);
    oled.setTextColor(SSD1306_BLACK);
    oled.setTextSize(2);
    oled.setCursor(28, 6);
    oled.print("TAKE A");
    oled.setCursor(28, 26);
    oled.print("BREAK!");
    oled.setTextSize(1);
    fmtDuration(buf, sizeof(buf), v.sessionS);
    oled.setCursor(4, 50);
    oled.printf("Focused %s  [btn]", buf);
    oled.display();
    return;
  }

  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(2);
  oled.setCursor(0, 0);
  oled.print(stateLabel(v.state));

  oled.setCursor(0, 18);
  if (v.sessionActive) {
    fmtDuration(buf, sizeof(buf), v.sessionS);
    oled.print(buf);
  } else {
    oled.print("--:--");
  }
  oled.setTextSize(1);
  oled.setCursor(98, 22);
  oled.printf("D:%d", v.distractions);

  oled.setCursor(0, 38);
  if (isnan(v.tempC)) oled.printf("Light %3d%%  T --", v.lightPct);
  else                oled.printf("Light %3d%%  %.1fC", v.lightPct, v.tempC);

  oled.setCursor(0, 47);
  if (v.motionOk) oled.printf("Motion %.3fg sp %d", v.motionRmsG, v.motionSpikes);
  else            oled.print("Motion: no IMU");

  oled.setCursor(0, 56);
  if (v.sessionActive) oled.printf("Break in %lum", (unsigned long)((v.secondsToBreak + 59) / 60));
  else                 oled.print("BTN1: start session");

  oled.display();
}
