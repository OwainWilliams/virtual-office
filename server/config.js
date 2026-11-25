import fs from 'node:fs';
import path from 'node:path';

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
  }
};

/**
 * config.json holds the defaults that ship with the app. config.local.json (not committed)
 * holds one person's own settings and wins over it. Staff and routines merge one level
 * deep, so a local file can rename one agent or set one routine without repeating the rest.
 */
export function loadConfig(root, localFile = process.env.OFFICE_LOCAL_CONFIG || path.join(root, 'config.local.json')) {
  const defaults = read(path.join(root, 'config.json'));
  const local = read(localFile);
  const config = { ...defaults, ...local };
  config.routines = { ...defaults.routines, ...local.routines };
  config.agents = {};
  for (const id of new Set([...Object.keys(defaults.agents || {}), ...Object.keys(local.agents || {})])) {
    config.agents[id] = { ...defaults.agents?.[id], ...local.agents?.[id] };
  }
  return config;
}
