import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Office } from './office.js';
import { loadConfig } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.OFFICE_DATA || path.join(root, 'data');
const config = loadConfig(root);
const port = Number(process.env.PORT) || config.port || 4700;
const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

// ---- projects ---------------------------------------------------------------
// The list lives in data/projects.json so projects added in the app are remembered.
// "projects" in config.local.json only seeds it on first run; with none, the app asks for one.

const projectsFile = path.join(dataDirectory, 'projects.json');
let registry;
try {
  registry = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
} catch {
  registry = { active: null, projects: config.projects || [] };
}
if (!registry.projects.some((project) => project.id === registry.active)) registry.active = registry.projects[0]?.id ?? null;

function saveRegistry() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(projectsFile, JSON.stringify(registry, null, 1));
}

// Windows and macOS file systems ignore case by default; Linux does not.
const sameFolder = (a, b) => {
  const [one, two] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'linux' ? one === two : one.toLowerCase() === two.toLowerCase();
};

function addProject(name, folder, jiraKey) {
  const resolved = path.resolve(folder);
  if (!name) return 'Give the project a name.';
  if (!path.isAbsolute(folder) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return `"${folder}" is not a folder on this machine. Use the full path.`;
  }
  if (registry.projects.some((project) => sameFolder(project.path, resolved))) {
    return 'That folder is already a project.';
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  let id = slug;
  for (let count = 2; registry.projects.some((project) => project.id === id); count += 1) id = `${slug}-${count}`;
  registry.projects.push({ id, name, path: resolved, jiraKey: jiraKey || '' });
  if (!office) registry.active = id;
  saveRegistry();
  if (!office) office = openOffice();
  return null;
}

// ---- server -------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(root, 'public')));
// Browsers ask for /favicon.ico on their own; answer with the same icon.
app.get('/favicon.ico', (_request, response) => response.type('image/svg+xml').sendFile(path.join(root, 'public', 'favicon.svg')));
const server = http.createServer(app);

// Only pages served by this app may open the socket: it can direct agents on this machine.
const sockets = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }) => allowedOrigins.has(origin),
});

const broadcast = (message) => {
  const data = JSON.stringify(message);
  for (const client of sockets.clients) if (client.readyState === 1) client.send(data);
};

const openOffice = () =>
  new Office(config, registry.projects.find((project) => project.id === registry.active), dataDirectory, broadcast);
// With no project yet the office stays closed and the page asks for the first one.
let office = registry.active ? openOffice() : null;

const setupSnapshot = () => ({
  officeName: config.officeName || null,
  latitude: config.latitude,
  owner: config.ownerName,
  setup: true,
  project: null,
  demo: process.env.OFFICE_DEMO === '1',
  agents: [],
  chat: [],
  questions: [],
  logs: {},
  board: null,
  backlog: null,
});

const snapshot = () => ({
  type: 'snapshot',
  payload: { ...(office ? office.snapshot() : setupSnapshot()), projects: registry.projects.map(({ id, name }) => ({ id, name })) },
});

function switchProject(id) {
  if (!office || id === registry.active || !registry.projects.some((project) => project.id === id)) return null;
  if (office.busy()) return 'The team is still working. Wait until everyone is idle (or stop everyone) before switching project.';
  office.flush();
  registry.active = id;
  saveRegistry();
  office = openOffice();
  return null;
}

sockets.on('connection', (socket) => {
  socket.send(JSON.stringify(snapshot()));
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const field = (name, limit) => (typeof message[name] === 'string' ? message[name].trim().slice(0, limit) : '');
    const text = field('text', 8000);
    const notice = (problem) => socket.send(JSON.stringify({ type: 'notice', payload: problem }));

    if (!office && !['addProject'].includes(message.type)) return notice('Add your first project to open the office.');
    if (message.type === 'chat' && text) office.ownerMessage(text);
    if (message.type === 'answer' && text && field('id', 64)) office.ownerAnswer(field('id', 64), text);
    if (message.type === 'direct' && text && field('id', 64)) office.directMessage(field('id', 64), text);
    if (message.type === 'stop') office.stopAll();
    if (message.type === 'stopAgent' && field('id', 64)) office.stopAgent(field('id', 64));
    if (message.type === 'routine' && ['standup', 'endOfDay'].includes(message.kind)) office.routine(message.kind);
    if (message.type === 'project') {
      const problem = switchProject(field('id', 64));
      if (problem) notice(problem);
      else broadcast(snapshot());
    }
    if (message.type === 'addProject') {
      const problem = addProject(field('name', 60), field('path', 400), field('jiraKey', 20));
      if (problem) notice(problem);
      else broadcast(snapshot());
    }
  });
});

// Optional daily routines for the active project, at the times set in config.json ("09:00").
// Each runs once a day, within the hour after its time, so opening the office late does not fire it.
setInterval(() => {
  if (!office) return;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const [kind, setting] of [['standup', 'standupTime'], ['endOfDay', 'endOfDayTime']]) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(config.routines?.[setting] || '');
    if (!match) continue;
    const due = Number(match[1]) * 60 + Number(match[2]);
    if (minutes >= due && minutes < due + 60 && office.lastRoutine[kind] !== office.today()) office.routine(kind);
  }
}, 30000);

server.listen(port, '127.0.0.1', () => {
  console.log(`Virtual office open at http://localhost:${port}${process.env.OFFICE_DEMO === '1' ? ' (demo mode: no real agents)' : ''}`);
});
