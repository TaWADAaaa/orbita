'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directories = [root, path.join(root, 'ui'), __dirname, path.join(root, 'tests')];
let count = 0;
for (const directory of directories) for (const name of fs.readdirSync(directory)) {
  if (!/\.(c?js)$/.test(name)) continue;
  const filename = path.join(directory, name);
  if (!fs.statSync(filename).isFile()) continue;
  const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  count++;
}
console.log(`Syntax checked ${count} JavaScript files.`);
