#!/usr/bin/env node
// Moves a Claude Code session into the running Virtual Office, as the guest at the extra desk.
//
//   node scripts/adopt.mjs                      the session you are in (the newest one for this folder)
//   node scripts/adopt.mjs --session <id>       a particular session
//   node scripts/adopt.mjs --model sonnet       the model the guest should use
//   node scripts/adopt.mjs --message "..."      what to tell them first
//   node scripts/adopt.mjs --no-message         move them in and say nothing
//
// Run it from the project folder (or its worktree). The office copies the conversation, so the
// session in your terminal is left alone. The office must already be running on this machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (text) => {
  console.error(text);
  process.exit(1);
};

const cwd = process.cwd();
const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Claude Code keeps each folder's conversations in a folder named after it, every other character a dash.
function newestSession() {
  const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let files;
  try {
    files = fs.readdirSync(folder).filter((name) => name.endsWith('.jsonl'));
  } catch {
    fail(`No Claude Code sessions found for ${cwd}\n(looked in ${folder}). Run this from the folder the session is in, or pass --session <id>.`);
  }
  if (!files.length) fail(`No Claude Code sessions found in ${folder}.`);
  const newest = files
    .map((name) => ({ name, modified: fs.statSync(path.join(folder, name)).mtimeMs }))
    .sort((first, second) => second.modified - first.modified)[0];
  return newest.name.replace(/\.jsonl$/, '');
}

const sessionId = option('session') || newestSession();
const config = loadConfig(root);
const port = Number(option('port')) || Number(process.env.PORT) || config.port || 4700;
const dataDirectory = process.env.OFFICE_DATA || path.join(root, 'data');
let token;
try {
  token = fs.readFileSync(path.join(dataDirectory, 'adopt-token'), 'utf8').trim();
} catch {
  fail(`Could not read the office's token in ${dataDirectory}. Start the office once (npm start) so it creates one.`);
}

const body = { sessionId, cwd };
const model = option('model');
if (model) body.model = model;
if (!args.includes('--no-message')) {
  body.message =
    option('message') ||
    'You have been moved into the virtual office from Claude Code. In a couple of sentences say where you got to and what is left, then carry on.';
}

let response;
try {
  response = await fetch(`http://127.0.0.1:${port}/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-token': token },
    body: JSON.stringify(body),
  });
} catch {
  fail(`Could not reach the office on port ${port}. Is it running (npm start)?`);
}
const result = await response.json().catch(() => ({}));
if (!result.ok) fail(`The office said no: ${result.error || response.status}`);
console.log(`${result.name} has taken over a copy of this session${result.branch ? ` (branch ${result.branch})` : ''}.`);
console.log(`Session ${sessionId}. This terminal session is untouched: you can close it, or keep it as a backup.`);
