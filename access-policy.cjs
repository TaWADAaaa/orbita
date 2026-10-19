'use strict';

// This is the only automatic-approval policy. Tool proposals cannot supply a level.
const ACCESS_LEVELS = Object.freeze([
  { level: 1, name: 'Restricted', description: 'The AI asks before every action.' },
  { level: 2, name: 'Read files', description: 'It can read and search your folder. It asks before changing anything.' },
  { level: 3, name: 'Create files', description: 'It can also create new files and folders.' },
  { level: 4, name: 'Edit files', description: 'It can also change the contents of your files.' },
  { level: 5, name: 'Use the internet', description: 'It can also search and read public web pages.' },
  { level: 6, name: 'Use the console', description: 'It can also run commands. Commands can change or delete things on your PC.' },
  { level: 7, name: 'Full access', description: 'It can also delete files in your folder without asking.' }
].map(Object.freeze));

function accessLevel(value) {
  if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error('Elegí un nivel de acceso entre 1 y 7.');
  return value;
}

function permissionFor(tool, { level = 1, exists = true } = {}) {
  accessLevel(level);
  const requiredLevels = {
    list_files: 2, read_file: 2, search: 2,
    write_file: exists ? 4 : 3, make_directory: 3, pack_project: exists ? 4 : 3,
    web_search: 5, read_url: 5,
    run_command: 6, start_command: 6, read_terminal: 6, send_terminal: 6, stop_terminal: 6, open_file: 6,
    delete_file: 7, remember: 3, forget: 7
  };
  if (!Object.hasOwn(requiredLevels, tool)) throw new Error('That tool is not available.');
  const required = requiredLevels[tool];
  return Object.freeze({ accessLevel: level, requiredLevel: required, approvalRequired: level < required });
}

module.exports = { ACCESS_LEVELS, accessLevel, permissionFor };
