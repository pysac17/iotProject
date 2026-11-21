#pragma once
// Copy this file to secrets.h and fill it in. secrets.h is git-ignored.
#define WIFI_SSID       "your-network"
#define WIFI_PASSWORD   "your-password"
// For now plain HTTP to the laptop running `npm start` (same Wi-Fi). Find the laptop's IP with
// `ipconfig getifaddr en0` on a Mac. Switch to https:// once the server has a certificate.
#define SERVER_URL      "http://192.168.1.10:8080"
#define DEVICE_ID       "g20-desk-01"
#define DEVICE_API_KEY  "change-me"     // must be listed in DEVICE_API_KEYS in server/.env

// Optional, only for an https:// SERVER_URL: the server's root certificate (PEM).
// #define SERVER_ROOT_CA "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
