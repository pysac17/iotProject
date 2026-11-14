// Person 1: see include/sensors.h
#include "sensors.h"

#include <Wire.h>
#include <Adafruit_BMP280.h>

namespace {

// ---- MPU-6050 registers (datasheet: RM-MPU-6000A) ----
constexpr uint8_t MPU_REG_SMPLRT_DIV   = 0x19;
constexpr uint8_t MPU_REG_CONFIG       = 0x1A;
constexpr uint8_t MPU_REG_ACCEL_CONFIG = 0x1C;
constexpr uint8_t MPU_REG_ACCEL_XOUT_H = 0x3B;
constexpr uint8_t MPU_REG_PWR_MGMT_1   = 0x6B;
constexpr uint8_t MPU_REG_WHO_AM_I     = 0x75;
constexpr float   ACCEL_LSB_PER_G      = 16384.0f;  // +-2 g full scale

constexpr uint32_t RETRY_PERIOD_MS = 5000;
constexpr uint8_t  MAX_FAILS       = 10;  // consecutive failed reads before a sensor is marked missing

Adafruit_BMP280 bmp(&Wire);
bool    bmpOk = false;
bool    mpuOk = false;
uint8_t bmpFails = 0;
uint8_t mpuFails = 0;
uint32_t lastRetryMs = 0;

bool mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(IoTPins::MPU6050_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(IoTPins::MPU6050_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;  // repeated start
  if (Wire.requestFrom(IoTPins::MPU6050_ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

bool mpuInit() {
  uint8_t who = 0;
  if (!mpuRead(MPU_REG_WHO_AM_I, &who, 1)) return false;
  if (who != 0x68) {
    // Clones often answer 0x70, 0x72 or 0x98 but use the same registers.
    Serial.printf("[sensors] MPU-6050 WHO_AM_I=0x%02X (expected 0x68), continuing\n", who);
  }
  bool ok = mpuWrite(MPU_REG_PWR_MGMT_1, 0x01)     // wake up, clock = gyro X PLL
         && mpuWrite(MPU_REG_CONFIG, 0x03)         // DLPF ~44 Hz -> 1 kHz internal rate
         && mpuWrite(MPU_REG_SMPLRT_DIV, 19)       // 1 kHz / (1 + 19) = 50 Hz
         && mpuWrite(MPU_REG_ACCEL_CONFIG, 0x00);  // +-2 g
  return ok;
}

bool bmpInit() {
  // Some "BMP280" boards are really BME280s (chip id 0x60); both work for temperature.
  if (!bmp.begin(IoTPins::BMP280_ADDR, BMP280_CHIPID) && !bmp.begin(IoTPins::BMP280_ADDR, 0x60)) {
    return false;
  }
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                  Adafruit_BMP280::SAMPLING_X2,    // temperature
                  Adafruit_BMP280::SAMPLING_X16,   // pressure
                  Adafruit_BMP280::FILTER_X16,
                  Adafruit_BMP280::STANDBY_MS_500);
  return true;
}

}  // namespace

void sensorsBegin() {
  Wire.begin(IoTPins::I2C_SDA, IoTPins::I2C_SCL, 400000);
  Wire.setTimeOut(10);  // ms; a missing or stuck device must not hang loop()

  analogReadResolution(12);
  analogSetPinAttenuation(LIGHT_ADC_PIN, ADC_11db);  // full 0..3.3 V range

  bmpOk = bmpInit();
  mpuOk = mpuInit();
  Serial.printf("[sensors] BMP280 %s, MPU-6050 %s\n",
                bmpOk ? "OK" : "MISSING", mpuOk ? "OK" : "MISSING");
}

void sensorsService(uint32_t nowMs) {
  if ((bmpOk && mpuOk) || nowMs - lastRetryMs < RETRY_PERIOD_MS) return;
  lastRetryMs = nowMs;
  if (!bmpOk && (bmpOk = bmpInit())) {
    bmpFails = 0;
    Serial.println("[sensors] BMP280 found");
  }
  if (!mpuOk && (mpuOk = mpuInit())) {
    mpuFails = 0;
    Serial.println("[sensors] MPU-6050 found");
  }
}

bool sensorsBmpOk() { return bmpOk; }
bool sensorsMpuOk() { return mpuOk; }

int sensorsReadLightPct() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(LIGHT_ADC_PIN);  // average out ADC noise
  int pct = (int)((sum / 8) * 100 / 4095);
  if (!LIGHT_BRIGHTER_IS_HIGHER) pct = 100 - pct;
  return constrain(pct, 0, 100);
}

float sensorsReadTempC() {
  if (!bmpOk) return NAN;
  float t = bmp.readTemperature();
  if (isnan(t) || t < -40.0f || t > 85.0f) {  // outside the sensor's range = bad read
    if (++bmpFails >= MAX_FAILS) {
      bmpOk = false;
      Serial.println("[sensors] BMP280 lost");
    }
    return NAN;
  }
  bmpFails = 0;
  return t;
}

bool sensorsReadAccel(AccelSample& out) {
  if (!mpuOk) return false;
  uint8_t b[6];
  if (!mpuRead(MPU_REG_ACCEL_XOUT_H, b, sizeof(b))) {
    if (++mpuFails >= MAX_FAILS) {
      mpuOk = false;
      Serial.println("[sensors] MPU-6050 lost");
    }
    return false;
  }
  mpuFails = 0;
  out.x = (int16_t)((b[0] << 8) | b[1]) / ACCEL_LSB_PER_G;
  out.y = (int16_t)((b[2] << 8) | b[3]) / ACCEL_LSB_PER_G;
  out.z = (int16_t)((b[4] << 8) | b[5]) / ACCEL_LSB_PER_G;
  return true;
}
