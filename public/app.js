import { createScene, drawAvatar, SEATS, WIDTH, HEIGHT } from './scene.js';
import { rich } from './rich.js';

const byId = (id) => document.getElementById(id);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
/** 1234 -> "1.2k"; 1234567 -> "1.2M". */
function formatTokens(count) {
  const number = Number(count) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e4) return `${Math.round(number / 1e3)}k`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const scene = createScene(byId('canvas'));
const stage = byId('stage');
const timeline = byId('timeline');
const state = { officeName: 'Virtual Office', owner: 'You', agents: {}, chat: [], questions: [], logs: {} };
let socket;
let openLog = null;

function send(message) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
}

// ---- office floor ---------------------------------------------------------

const tags = {};
const bubbles = {};
for (const [id, seat] of Object.entries(SEATS)) {
  const tag = element('button', 'tag');
  tag.type = 'button';
  tag.style.left = `${(seat.x / WIDTH) * 100}%`;
  tag.style.top = `${((seat.y + 30) / HEIGHT) * 100}%`;
  if (id === 'owner') tag.disabled = true;
  else tag.addEventListener('click', () => showLog(id));
  const bubble = element('div', 'bubble');
  bubble.style.left = `${(seat.x / WIDTH) * 100}%`;
  bubble.style.top = `${((seat.y - 16) / HEIGHT) * 100}%`;
  bubble.hidden = true;
  stage.append(tag, bubble);
  tags[id] = tag;
  bubbles[id] = bubble;
}

function renderFloor() {
  scene.update(state.agents);
  const ownerTag = tags.owner;
  ownerTag.replaceChildren(element('strong', '', state.owner), element('span', '', 'You'));
  // A desk the running office does not know about (an older server) gets no empty tag.
  for (const [id, tag] of Object.entries(tags)) tag.hidden = id !== 'owner' && !state.agents[id];
  let working = 0;
  let tokens = 0;
  let tokensToday = 0;
  const modelsToday = {};
  for (const agent of Object.values(state.agents)) {
    if (agent.status === 'working') working += 1;
    tokens += agent.tokens || 0;
    tokensToday += agent.tokensToday || 0;
    for (const [model, count] of Object.entries(agent.modelsToday || {})) modelsToday[model] = (modelsToday[model] || 0) + count;
    const name = element('strong');
    name.append(element('i', `dot ${agent.status}`), agent.name);
    const tag = tags[agent.id];
    const inWorktree = agent.status !== 'idle' && agent.branch;
    // The contractor is only in the office while reviewing.
    const away = agent.id === 'reviewer' && agent.status === 'idle';
    tag.classList.toggle('away', away);
    tag.replaceChildren(name, element('span', '', away ? 'Not in today' : `${agent.role} · ${formatTokens(agent.tokensToday)} tokens`));
    // Shown only while the manager has put them on a model other than their usual one.
    const moved = agent.model !== agent.defaultModel && agent.status !== 'idle';
    if (moved) tag.append(element('em', 'model', `on ${agent.modelLabel || agent.model}`));
    if (inWorktree) tag.append(element('em', '', agent.branch));
    const tests = agent.mood === 'failing' ? 'tests failing' : agent.mood === 'passing' ? 'tests passing' : '';
    const used = Object.entries(agent.modelsToday || {}).map(([model, count]) => `${model} ${formatTokens(count)}`).join(', ');
    tag.title = [
      inWorktree ? `Working in the ${agent.branch} worktree` : '',
      tests,
      `Model: ${agent.modelLabel || agent.model}${moved ? ' (not their usual one)' : ''}`,
      `${formatTokens(agent.tokensToday)} tokens today${used ? ` (${used})` : ''}`,
      `${formatTokens(agent.tokens)} tokens in total`,
    ]
      .filter(Boolean)
      .join(' · ');
    tag.setAttribute(
      'aria-label',
      `${agent.name}, ${agent.role}, ${agent.status}${agent.task ? `: ${agent.task}` : ''}${inWorktree ? `, branch ${agent.branch}` : ''}${moved ? `, on ${agent.modelLabel || agent.model}` : ''}${tests ? `, ${tests}` : ''}, ${formatTokens(agent.tokensToday)} tokens today. Open activity log.`,
    );
    const bubble = bubbles[agent.id];
    bubble.hidden = agent.status === 'idle' || !agent.activity;
    bubble.className = `bubble ${agent.status}`;
    bubble.textContent = agent.activity;
    bubble.title = agent.task || '';
  }
  const pending = state.questions.filter((question) => !question.answer).length;
  const summary = byId('summary');
  summary.textContent = pending
    ? `${pending} waiting on you · ${working} working`
    : working ? `${working} working` : 'All quiet';
  summary.classList.toggle('alert', pending > 0);
  const usage = byId('usage');
  usage.textContent = `${formatTokens(tokensToday)} tokens today`;
  usage.title = [
    'Tokens the agents used today on this project: new input, output and cache writes. Re-reading cached text is not counted.',
    'A guide to how fast your plan limits are being used. It is not money.',
    Object.keys(modelsToday).length ? `Today by model: ${Object.entries(modelsToday).map(([model, count]) => `${model} ${formatTokens(count)}`).join(', ')}` : '',
    `All time on this project: ${formatTokens(tokens)}`,
  ].filter(Boolean).join('\n');
  byId('title').textContent = state.officeName;
  document.title = `${pending ? `(${pending}) ` : ''}${state.officeName}`;
  const manager = state.agents.manager;
  if (manager) byId('manager-name').textContent = `${manager.name}, ${manager.role}`;
}

// ---- chat -----------------------------------------------------------------

/** What an approval is for: a plain-English summary, with the exact command tucked away. */
function approvalBody(approval) {
  const body = element('div', 'approval');
  const headline = element('p', 'headline');
  headline.append(element('strong', '', approval.name), ` wants to ${approval.headline}`);
  const context = [approval.role, approval.task ? `Task: ${approval.task}` : '', approval.branch ? `Branch: ${approval.branch}` : '']
    .filter(Boolean)
    .join(' · ');
  const steps = element('ul', 'steps');
  for (const step of approval.steps) {
    const item = element('li', step.needsApproval ? 'needs' : '', step.text);
    if (step.needsApproval) item.append(element('span', 'badge', 'needs approval'));
    steps.append(item);
  }
  const details = element('details');
  details.append(element('summary', '', 'Show the full command'), element('pre', '', approval.command));
  body.append(headline, element('p', 'context', context), steps, details);
  return body;
}

function questionCard(question) {
  const card = element('div', `card${question.answer ? ' answered' : ''}`);
  const manager = state.agents.manager?.name || 'Manager';
  card.append(element('span', 'who', `${question.kind === 'approval' ? 'Approval needed' : `${manager} asks`} · ${clock(question.at)}`));
  if (question.approval) card.append(approvalBody(question.approval));
  else {
    const body = element('div', 'rich');
    body.append(rich(question.text));
    card.append(body);
  }
  if (question.answer) {
    card.append(element('div', 'answer', `You answered: ${question.answer}`));
    return card;
  }
  const choices = element('div', 'choices');
  question.options.forEach((option, index) => {
    const button = element('button', `button${index === 0 ? ' primary' : ''}`, option);
    button.type = 'button';
    button.addEventListener('click', () => send({ type: 'answer', id: question.id, text: option }));
    choices.append(button);
  });
  card.append(choices);
  if (question.kind === 'question') {
    const other = element('form', 'other');
    const input = element('input');
    input.placeholder = 'Or type your own answer';
    input.setAttribute('aria-label', 'Your own answer');
    const submit = element('button', 'button', 'Answer');
    other.append(input, submit);
    other.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value.trim()) send({ type: 'answer', id: question.id, text: input.value.trim() });
    });
    card.append(other);
  }
  return card;
}

// Light enough to read on the dark panel; each follows the colour of that person's shirt on the floor.
const TONES = {
  owner: '#e0b040', manager: '#b98af0', senior: '#5fa0ff', junior: '#4cc98a', qa: '#f09a4a', pm: '#f06b95', reviewer: '#a9b4c4',
};

function avatar(id) {
  const canvas = element('canvas', 'avatar');
  canvas.setAttribute('role', 'presentation');
  drawAvatar(canvas, id);
  canvas.style.setProperty('--tone', TONES[id] || 'var(--line)');
  return canvas;
}

/** Marks each agent's name in the text with their own colour. Only text nodes are touched. */
function tintNames(fragment) {
  const people = Object.values(state.agents);
  if (!people.length) return fragment;
  const byName = new Map(people.map((person) => [person.name.toLowerCase(), person]));
  const pattern = new RegExp(`\\b(${people.map((person) => person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const found = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest?.('code, pre, a') && pattern.test(node.data)) found.push(node);
    pattern.lastIndex = 0;
  }
  for (const node of found) {
    const parts = node.data.split(pattern);
    node.replaceWith(...parts.map((part, index) => {
      const person = index % 2 ? byName.get(part.toLowerCase()) : null;
      if (!person) return document.createTextNode(part);
      const span = element('span', 'agent-name', part);
      span.style.setProperty('--tone', TONES[person.id] || 'inherit');
      return span;
    }));
  }
  return fragment;
}

const openReports = new Set(); // reports you have expanded, kept across redraws

function reportCard(message) {
  const person = state.agents[message.agent];
  const node = element('div', 'message report toned rich');
  node.style.setProperty('--tone', TONES[message.agent] || 'var(--line)');
  const who = element('span', 'who');
  who.append(avatar(message.agent), element('span', '', `${person?.name || message.agent} · `), element('span', 'role', `${person?.role || ''} · ${clock(message.at)}`));
  const details = element('details');
  details.open = openReports.has(message.id);
  details.addEventListener('toggle', () => (details.open ? openReports.add(message.id) : openReports.delete(message.id)));
  const lines = String(message.text).trim().split('\n').filter(Boolean);
  const first = (lines[0] || '').replace(/[*#`]/g, '');
  const summary = element('summary');
  summary.append(element('div', 'title', message.title || 'Report'));
  summary.append(first.length > 140 ? `${first.slice(0, 139)}…` : first);
  if (String(message.text).trim().length > first.length) summary.append(element('span', 'more', details.open ? '(hide)' : '(show all)'));
  details.addEventListener('toggle', () => {
    const more = summary.querySelector('.more');
    if (more) more.textContent = details.open ? '(hide)' : '(show all)';
  });
  details.append(summary, tintNames(rich(message.text)));
  node.append(who, details);
  return node;
}

function renderChat() {
  const items = [
    ...state.chat.map((message) => ({ at: message.at, message })),
    ...state.questions.map((question) => ({ at: question.at, question })),
  ].sort((first, second) => first.at - second.at);
  const nodes = items.map(({ message, question }) => {
    if (question) return questionCard(question);
    if (message.from === 'report') return reportCard(message);
    const node = element('div', `message ${message.from}`);
    if (message.from !== 'system') {
      const id = message.from === 'owner' ? 'owner' : 'manager';
      const who = message.from === 'owner' ? 'You' : state.agents.manager?.name || 'Manager';
      const label = element('span', 'who');
      label.append(avatar(id), `${who} · ${clock(message.at)}`);
      node.classList.add('toned');
      node.style.setProperty('--tone', TONES[id]);
      node.append(label);
    }
    // Agents write lists, bold and links; your own messages are shown exactly as typed.
    if (message.from === 'owner') node.append(message.text);
    else {
      node.classList.add('rich');
      node.append(tintNames(rich(message.text)));
    }
    return node;
  });
  if (!nodes.length) nodes.push(element('p', 'empty', 'Nothing yet. Tell the manager what you would like the team to work on.'));
  const keepDraft = document.activeElement?.closest?.('.card .other');
  if (keepDraft) return; // do not wipe an answer that is being typed; the next event re-renders
  timeline.replaceChildren(...nodes);
  timeline.scrollTop = timeline.scrollHeight;
}

byId('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId('input');
  if (!input.value.trim()) return;
  send({ type: 'chat', text: input.value });
  input.value = '';
});
byId('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    byId('composer').requestSubmit();
  }
});
byId('stop').addEventListener('click', () => {
  if (confirm('Stop all agents now? Work in progress is abandoned.')) send({ type: 'stop' });
});

// ---- chat size ----------------------------------------------------------------

function setChatWide(wide) {
  document.querySelector('main').classList.toggle('chat-wide', wide);
  const button = byId('chat-size');
  button.textContent = wide ? 'Shrink' : 'Expand';
  button.setAttribute('aria-pressed', String(wide));
  try {
    localStorage.setItem('chatWide', wide ? '1' : '');
  } catch {
    // storage unavailable: the choice just is not remembered
  }
  timeline.scrollTop = timeline.scrollHeight;
}
byId('chat-size').addEventListener('click', () => setChatWide(!document.querySelector('main').classList.contains('chat-wide')));
try {
  if (localStorage.getItem('chatWide')) setChatWide(true);
} catch {
  // storage unavailable
}

// ---- routines and notifications ---------------------------------------------

byId('standup').addEventListener('click', () => send({ type: 'routine', kind: 'standup' }));
byId('end-of-day').addEventListener('click', () => send({ type: 'routine', kind: 'endOfDay' }));

const canNotify = 'Notification' in window;
function renderNotifyButton() {
  const button = byId('notify');
  button.hidden = !canNotify;
  if (!canNotify) return;
  const on = Notification.permission === 'granted';
  button.textContent = on ? 'Notifications on' : Notification.permission === 'denied' ? 'Notifications blocked' : 'Turn on notifications';
  button.disabled = Notification.permission !== 'default';
}
byId('notify').addEventListener('click', async () => {
  await Notification.requestPermission();
  renderNotifyButton();
});
renderNotifyButton();

/** A desktop notification, only when you are not already looking at the office. */
function notify(title, body) {
  if (!canNotify || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const notification = new Notification(title, { body: body.slice(0, 240), tag: 'virtual-office' });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

// ---- wall board -------------------------------------------------------------

const boardButton = element('button', 'board-hit');
boardButton.type = 'button';
boardButton.style.left = `${(284 / WIDTH) * 100}%`;
boardButton.style.top = `${(3 / HEIGHT) * 100}%`;
boardButton.style.width = `${(72 / WIDTH) * 100}%`;
boardButton.style.height = `${(18 / HEIGHT) * 100}%`;
boardButton.addEventListener('click', () => {
  renderBoard();
  byId('board-dialog').showModal();
});
stage.append(boardButton);
byId('board-close').addEventListener('click', () => byId('board-dialog').close());

function renderBoard() {
  scene.setBoard(state.board);
  const columns = state.board?.columns || [];
  const summary = columns.length ? columns.map((column) => `${column.name} ${column.count}`).join(', ') : 'no data yet';
  boardButton.setAttribute('aria-label', `Board: ${summary}. Open the board.`);
  boardButton.title = `Board: ${summary}`;
  const body = byId('board-body');
  body.replaceChildren();
  byId('board-title').textContent = state.board ? `Board (${state.board.source})` : 'Board';
  if (/^https?:\/\//.test(state.boardLink || '')) {
    const link = element('a', 'board-link', `${state.boardLinkLabel || 'Open in Jira'} ↗`);
    link.href = state.boardLink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${state.boardLinkLabel || 'Open in Jira'} (opens in a new tab)`);
    body.append(link);
  }
  if (!columns.length) {
    body.append(element('p', 'empty', 'No board data yet. It fills in the first time the project manager reads the board, for example at a stand-up.'));
    return;
  }
  const counts = element('div', 'counts');
  for (const column of columns) {
    const cell = element('div', 'count');
    cell.append(element('strong', '', String(column.count)), element('span', '', column.name));
    counts.append(cell);
  }
  body.append(counts, element('p', 'empty', `Updated ${clock(state.board.at)}`));
  for (const item of state.backlog || []) {
    body.append(element('div', 'entry', `#${item.id} [${item.status}] (${item.size}) ${item.title}${item.detail ? `\n${item.detail}` : ''}`));
  }
}

// ---- projects -------------------------------------------------------------

byId('project').addEventListener('change', (event) => send({ type: 'project', id: event.target.value }));
byId('add-project').addEventListener('click', () => byId('project-dialog').showModal());
byId('project-cancel').addEventListener('click', () => { if (!state.setup) byId('project-dialog').close(); });
byId('project-dialog').addEventListener('cancel', (event) => { if (state.setup) event.preventDefault(); });
byId('project-form').addEventListener('submit', (event) => {
  event.preventDefault();
  send({
    type: 'addProject',
    name: byId('project-name').value,
    path: byId('project-path').value,
    jiraKey: byId('project-jira').value,
  });
  event.target.reset();
  byId('project-dialog').close();
});

// ---- activity log ---------------------------------------------------------

function logEntry(entry) {
  const node = element('div', `entry ${entry.kind}`);
  const label = { task: 'Task: ', report: 'Report: ', does: '', says: '', error: 'Problem: ', you: 'You: ', office: 'Office: ' }[entry.kind] || '';
  node.append(element('time', '', clock(entry.at)), `${label}${entry.text}`);
  return node;
}

function showLog(id) {
  const agent = state.agents[id];
  if (!agent) return;
  openLog = id;
  byId('drawer-title').textContent = `${agent.name}, ${agent.role} (${agent.modelLabel || agent.model})`;
  const entries = (state.logs[id] || []).map(logEntry);
  byId('log').replaceChildren(...(entries.length ? entries : [element('p', 'empty', 'No activity yet.')]));
  showStop();
  const drawer = byId('drawer');
  if (!drawer.open) drawer.showModal();
  drawer.scrollTop = drawer.scrollHeight;
}

/** The Stop button in the log is there only while that agent has something to stop. */
function showStop() {
  const agent = state.agents[openLog];
  const button = byId('drawer-stop');
  button.hidden = !agent || agent.status === 'idle';
  if (agent) byId('direct-input').placeholder = `Message ${agent.name} directly (/help for commands)`;
  if (agent) button.textContent = `Stop ${agent.name}`;
}
byId('drawer-stop').addEventListener('click', () => {
  const agent = state.agents[openLog];
  if (agent && confirm(`Stop ${agent.name} now? Their task is abandoned where it stands.`)) send({ type: 'stopAgent', id: agent.id });
});
byId('direct-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = byId('direct-input');
  if (!openLog || !input.value.trim()) return;
  send({ type: 'direct', id: openLog, text: input.value });
  input.value = '';
});
byId('drawer-close').addEventListener('click', () => byId('drawer').close());
byId('drawer').addEventListener('close', () => (openLog = null));

// ---- live connection ------------------------------------------------------

function handle({ type, payload }) {
  if (type === 'snapshot') {
    state.owner = payload.owner;
    if (payload.officeName) state.officeName = payload.officeName; // set by "officeName" in config.json
    state.project = payload.project;
    state.setup = Boolean(payload.setup);
    scene.setLatitude(payload.latitude); // sets how long the windows stay light
    state.agents = Object.fromEntries(payload.agents.map((agent) => [agent.id, agent]));
    state.chat = payload.chat;
    state.questions = payload.questions;
    state.logs = payload.logs;
    state.board = payload.board;
    state.backlog = payload.backlog;
    state.boardLink = payload.boardLink;
    state.boardLinkLabel = payload.boardLinkLabel;
    renderBoard();
    byId('demo').hidden = !payload.demo;
    byId('project').replaceChildren(
      ...payload.projects.map((project) => {
        const option = element('option', '', project.name);
        option.value = project.id;
        option.selected = project.id === payload.project;
        return option;
      }),
    );
    if (byId('drawer').open) byId('drawer').close();
    renderFloor();
    renderChat();
    byId('project-welcome').hidden = !state.setup;
    byId('project-cancel').hidden = state.setup;
    if (state.setup && !byId('project-dialog').open) byId('project-dialog').showModal();
  } else if (type === 'agent') {
    state.agents[payload.id] = payload;
    renderFloor();
    if (openLog === payload.id) showStop();
  } else if (type === 'chat') {
    state.chat.push(payload);
    renderChat();
    if (payload.from === 'manager') notify(`${state.agents.manager?.name || 'Manager'} says`, payload.text);
  } else if (type === 'board') {
    state.board = payload.board;
    state.backlog = payload.backlog;
    renderBoard();
  } else if (type === 'gather') {
    scene.gather();
  } else if (type === 'celebrate') {
    scene.celebrate();
  } else if (type === 'question') {
    const index = state.questions.findIndex((question) => question.id === payload.id);
    if (index >= 0) state.questions[index] = payload;
    else {
      state.questions.push(payload);
      const manager = state.agents.manager?.name || 'Manager';
      notify(payload.kind === 'approval' ? `${manager} needs your approval` : `${manager} has a question`, payload.text);
    }
    // Once a typed answer is recorded, let go of its input so the card can redraw as answered.
    if (payload.answer && document.activeElement?.closest?.('.card .other')) document.activeElement.blur();
    renderFloor();
    renderChat();
  } else if (type === 'log') {
    (state.logs[payload.id] ||= []).push(payload.entry);
    if (openLog === payload.id) byId('log').append(logEntry(payload.entry));
  } else if (type === 'notice') {
    // Shown in the chat for this visit only; it is not saved.
    state.chat.push({ id: `notice-${Date.now()}`, at: Date.now(), from: 'system', text: payload });
    byId('project').value = state.project;
    renderChat();
  } else if (type === 'visit') {
    scene.visit(payload.from, payload.to);
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener('message', (event) => handle(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    byId('summary').textContent = 'Disconnected. Reconnecting…';
    setTimeout(connect, 2000);
  });
}
connect();
