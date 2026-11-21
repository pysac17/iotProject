#!/usr/bin/env node
// Person 2: writes the reliability section's numbers from the logs.
//
//   npm run report                                   whole log, device g20-desk-01
//   npm run report -- --from 2026-11-20T18:00:00Z --to 2026-11-23T18:00:00Z
//   npm run report -- --device g20-desk-01 --interval 10
//
// Prints the report and saves data/reliability_report.md, data/reliability_report.json
// and data/gaps.csv (paste the tables straight into the Final Report).
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { analyze, toMarkdown, gapsCsv } = require('./reliability');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const device = args.device || 'g20-desk-01';
const intervalS = Number(args.interval || 10);
const from = args.from ? Date.parse(args.from) : undefined;
const to = args.to ? Date.parse(args.to) : undefined;
if ((args.from && Number.isNaN(from)) || (args.to && Number.isNaN(to))) {
  console.error('--from / --to must be ISO times, e.g. 2026-11-20T18:00:00Z');
  process.exit(1);
}

const result = analyze({
  telemetry: db.readLines(db.TELEMETRY_FILE),
  events: db.readLines(db.EVENTS_FILE),
  serverLog: db.readLines(db.SERVER_FILE),
  device, from, to, intervalS,
});

const md = toMarkdown(result);
fs.mkdirSync(db.DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(db.DATA_DIR, 'reliability_report.md'), md);
fs.writeFileSync(path.join(db.DATA_DIR, 'reliability_report.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(db.DATA_DIR, 'gaps.csv'), gapsCsv(result));
console.log(md);
console.log(`Saved data/reliability_report.md, data/reliability_report.json and data/gaps.csv`);
