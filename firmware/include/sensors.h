#pragma once
// Person 1: photoresistor, BMP280 and MPU-6050.
#include <Arduino.h>
#include "iot_pins.h"

// Photoresistor voltage divider. Must be an ADC1 pin (ADC2 stops working while
// Wi-Fi is on). GPIO 34 is the kit's pot slot; change this if you wired it elsewhere.
constexpr uint8_t LIGHT_ADC_PIN = IoTPins::POT_ADC;
// true if the reading goes UP when the room gets brighter (LDR on the 3.3 V side).
// Flip to false if covering the sensor makes light_pct go up.
constexpr bool LIGHT_BRIGHTER_IS_HIGHER = true;

struct AccelSample {
  float x, y, z;  // acceleration in g
};

void  sensorsBegin();                 // starts I2C + ADC, probes BMP280 and MPU-6050
void  sensorsService(uint32_t nowMs); // call every loop; re-probes missing sensors every 5 s

bool  sensorsBmpOk();
bool  sensorsMpuOk();

int   sensorsReadLightPct();          // 0..100
float sensorsReadTempC();             // NAN if the BMP280 is missing or the read failed
bool  sensorsReadAccel(AccelSample& out);  // register-level MPU-6050 read; false on failure
