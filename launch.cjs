'use strict';
const { spawn } = require('node:child_process');
const { prepareElectron } = require('./prepare-electron.cjs');
(async () => {
  const executable = await prepareElectron();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [__dirname], { detached: true, windowsHide: true, stdio: 'ignore', env });
  child.on('error', error => { console.error(`Could not open Órbita: ${error.message}`); process.exitCode = 1; });
  child.unref();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
