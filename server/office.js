import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { staffPrompt, managerPrompt } from './prompts.js';
import { describeApproval } from './describe.js';
import { modelList, findModel, modelLabel, formatTokens } from './models.js';

const STAFF = ['senior', 'junior', 'qa', 'pm', 'reviewer'];
// What the contractor reviewer may not run: anything that writes to GitHub or changes the branch.
const REVIEWER_WRITES =
  /\bgh\s+pr\s+(review|comment|merge|close|edit|ready|reopen|create|checkout)\b|\bgh\s+issue\s+(comment|create|close|edit)\b|\bgh\s+api\b.*(\s-X\b|--method|\s-[fF]\b|--field|--raw-field|--input)|\bgit\s+(push|commit|merge|rebase|reset|checkout|switch|stash|add)\b/i;
const LOG_LIMIT = 200;
const CHAT_LIMIT = 500;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** Turns a tool call into a short line for the office floor ("Editing Foo.cs"). */
function describeTool(name, input = {}) {
  const file = input.file_path || input.path || input.notebook_path;
  const base = file ? path.basename(String(file)) : '';
  if (name === 'Read') return `Reading ${base}`;
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return `Editing ${base}`;
  if (name === 'Grep' || name === 'Glob') return 'Searching the code';
  if (name === 'Bash' || name === 'PowerShell') {
    const command = String(input.command || '');
    if (/\b(test|vitest|playwright)\b/i.test(command)) return 'Running tests';
    if (/\bdotnet\s+build\b|npm\s+run\s+build/i.test(command)) return 'Building';
    if (/^\s*git\b/.test(command)) return `git ${command.trim().split(/\s+/)[1] || ''}`;
    return `Running: ${clip(command.replace(/\s+/g, ' '), 40)}`;
  }
  if (/jira|atlassian/i.test(name)) return /search|get|list|read/i.test(name) ? 'Checking Jira' : 'Updating Jira';
  if (name.startsWith('mcp__office__')) return name.replace('mcp__office__', '').replace(/_/g, ' ');
  if (name === 'Agent' || name === 'Task') return 'Delegating to a helper';
  if (/WebSearch|WebFetch/.test(name)) return 'Researching';
  return clip(name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' '), 40);
}

class Agent {
  constructor(office, id, definition) {
    this.office = office;
    this.id = id;
    this.name = definition.name;
    this.role = definition.role;
    this.defaultModel = definition.model; // their usual model
    this.plugins = definition.plugins || []; // folders of local plugins loaded for this agent only
    this.model = definition.model; // the model for the current task: the manager can change it per task
    this.status = 'idle'; // idle | working | waiting
    this.task = null;
    this.activity = '';
    this.log = [];
    this.sessionId = null;
    this.sessionPath = null; // the folder the saved session belongs to
    this.tokens = 0; // all time, on this project
    this.lastError = null; // the last error an assistant message reported, such as 'model_not_found'
    this.abort = null;
    this.place = { branch: null, path: office.project.path }; // where the current task runs
    this.mood = null; // null | 'failing' | 'passing': the result of this task's latest test run
    this.watched = new Map(); // tool call id -> 'test' | 'merge', resolved when its result arrives
  }

  snapshot() {
    const { id, name, role, model, defaultModel, status, task, activity, tokens, mood } = this;
    const { config } = this.office;
    const today = this.office.tokensToday(id);
    return {
      id, name, role, model, defaultModel, status, task, activity, tokens, mood,
      modelLabel: modelLabel(config, model),
      tokensToday: today.total,
      modelsToday: today.byModel,
      branch: this.place.branch,
    };
  }

  /** Notes the tool calls whose outcome the office floor reacts to. */
  watch(block) {
    if (block.name !== 'Bash' && block.name !== 'PowerShell') return;
    const command = String(block.input?.command || '');
    if (/\bgh\s+pr\s+merge\b/.test(command)) this.watched.set(block.id, 'merge');
    else if (/\b(dotnet\s+test|vitest|playwright\s+test|npm\s+(run\s+)?test|pytest|jest)\b/i.test(command)) this.watched.set(block.id, 'test');
  }

  /** Reads tool results: a test run sets the mood, a merged pull request starts a celebration. */
  settle(block) {
    const kind = this.watched.get(block.tool_use_id);
    if (!kind) return;
    this.watched.delete(block.tool_use_id);
    const output = Array.isArray(block.content) ? block.content.map((part) => part.text || '').join('\n') : String(block.content || '');
    if (kind === 'test') {
      const failed = block.is_error || /\b[1-9]\d*\s+(failed|failing)\b|Failed!|Test Run Failed|FAILED/.test(output);
      this.set({ mood: failed ? 'failing' : 'passing' });
    } else if (!block.is_error) {
      this.office.celebrate(`${this.name} merged a pull request.`);
    }
  }

  set(changes) {
    Object.assign(this, changes);
    this.office.emit('agent', this.snapshot());
  }

  note(kind, text) {
    const entry = { at: Date.now(), kind, text };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.office.emit('log', { id: this.id, entry });
  }

  /** PreToolUse gate: role limits, blocked commands, and owner approvals. Runs for every tool call. */
  async gate(toolName, input) {
    const deny = (reason) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
    const { config } = this.office;
    const isShell = toolName === 'Bash' || toolName === 'PowerShell';
    const isEdit = ['Edit', 'Write', 'NotebookEdit'].includes(toolName);
    const subject = `${toolName} ${isShell ? String(input.command || '') : ''}`;

    if (toolName === 'AskUserQuestion') return deny('There is no user here. Put the question in your report to the manager.');
    if (this.id === 'manager') {
      const allowed = ['Read', 'Grep', 'Glob'].includes(toolName) || toolName.startsWith('mcp__office__');
      return allowed ? {} : deny('The manager delegates work with assign_task and does not run tools directly.');
    }
    if (this.id === 'qa' && isEdit) return deny('QA reports problems and does not edit files.');
    if (this.id === 'pm' && (isEdit || isShell)) return deny('The project manager works in Jira and does not change the repository.');
    if (this.id === 'reviewer' && isEdit) return deny('The reviewer reads and does not edit files.');
    if (this.id === 'reviewer' && isShell && REVIEWER_WRITES.test(subject)) {
      return deny('The reviewer only reads. Save your notes with the draft_pr_review tool; nothing else may be written to the pull request or the branch.');
    }
    if (config.alwaysBlocked.some((pattern) => new RegExp(pattern, 'i').test(subject))) {
      return deny('Blocked by office policy. Do not work around it; report it to the manager.');
    }
    if (config.needsOwnerApproval.some((pattern) => new RegExp(pattern, 'i').test(subject))) {
      const previous = { status: this.status, activity: this.activity };
      this.set({ status: 'waiting', activity: 'Waiting for approval' });
      const approved = await this.office.requestApproval(this, toolName, input);
      this.set(previous);
      if (!approved) return deny('The owner declined this action. Report that to the manager.');
    }
    return {};
  }

  options(resume) {
    const { office } = this;
    const isManager = this.id === 'manager';
    return {
      model: this.model,
      cwd: this.place.path,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: isManager
          ? managerPrompt(office.config, office.project)
          : staffPrompt(this.id, office.config, office.project, this.place),
      },
      settingSources: ['user', 'project', 'local'],
      mcpServers: isManager
        ? { office: office.managerTools }
        : this.id === 'pm' ? { office: office.pmTools } : this.id === 'reviewer' ? { office: office.reviewerTools } : undefined,
      disallowedTools: isManager ? ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent'] : [],
      hooks: {
        PreToolUse: [{ timeout: 86400, hooks: [async (hookInput) => this.gate(hookInput.tool_name, hookInput.tool_input || {})] }],
      },
      canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      abortController: this.abort,
      resume: resume || undefined,
      ...(this.plugins.length ? { plugins: this.plugins.map((folder) => ({ type: 'local', path: folder })) } : {}),
    };
  }

  /**
   * Runs one task and resolves with the agent's final text. If the model the manager chose for
   * this task is not available, the agent carries on with their usual model instead of failing.
   */
  async run(prompt, options = {}) {
    this.lastError = null;
    const report = await this.runTurn(prompt, options);
    const changed = this.model !== this.defaultModel;
    const unavailable = this.lastError === 'model_not_found' || (/^Failed to run/.test(report) && /\bmodel\b/i.test(report));
    if (!changed || !unavailable || this.abort?.signal.aborted) return report;
    const { config } = this.office;
    this.note('error', `${modelLabel(config, this.model)} was not available for this task. Carrying on with ${modelLabel(config, this.defaultModel)}.`);
    this.office.say('system', `${this.name} could not use ${modelLabel(config, this.model)}, so they are carrying on with ${modelLabel(config, this.defaultModel)}.`);
    this.set({ model: this.defaultModel });
    this.lastError = null;
    return this.runTurn(prompt, { ...options, fresh: true });
  }

  /** Runs one turn and resolves with the agent's final text. */
  async runTurn(prompt, { fresh = false } = {}) {
    this.abort = new AbortController(); // one per turn, so a stop only ever ends the turn it was aimed at
    if (this.office.demo) return this.runDemo(prompt);
    // A saved conversation belongs to one folder: moving to another worktree starts a new one.
    if (fresh || this.sessionPath !== this.place.path) this.sessionId = null;
    this.sessionPath = this.place.path;
    try {
      return await this.runOnce(prompt, this.sessionId);
    } catch (error) {
      if (this.abort?.signal.aborted) return 'Stopped by the owner before finishing.';
      if (this.sessionId) {
        // A stale session id cannot be resumed: start a new conversation once.
        this.note('error', `Could not resume the previous session (${error.message}). Starting a new one.`);
        this.sessionId = null;
        try {
          return await this.runOnce(prompt, null);
        } catch (retryError) {
          return `Failed to run: ${retryError.message}`;
        }
      }
      return `Failed to run: ${error.message}`;
    }
  }

  async runOnce(prompt, resume) {
    const { signal } = this.abort;
    let release;
    const finished = new Promise((resolve) => (release = resolve));
    async function* input() {
      yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
      await finished; // keep the input stream open so tools and hooks keep working until the result
    }
    let result = '';
    const session = query({ prompt: input(), options: this.options(resume) });
    const read = this.read(session, (text) => (result = text), release);
    // A stop must end the turn at once, even if the session is slow to wind down.
    const stopped = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    try {
      await Promise.race([read, stopped]);
      if (signal.aborted) {
        read.catch(() => {});
        try {
          session.close?.();
        } catch {
          // already closed
        }
        throw new Error('Stopped');
      }
    } finally {
      release();
    }
    return result;
  }

  /** Reads one session's messages until its result arrives. */
  async read(session, setResult, release) {
    let result = '';
    try {
      for await (const message of session) {
        if (this.abort?.signal.aborted) return;
        if (message.type === 'system' && message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.office.save();
        } else if (message.type === 'assistant') {
          if (message.error) this.lastError = message.error;
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) this.note('says', block.text.trim());
            if (block.type === 'tool_use') {
              const activity = describeTool(block.name, block.input);
              this.note('does', activity);
              this.watch(block);
              if (this.status === 'working') this.set({ activity });
            }
          }
        } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) if (block.type === 'tool_result') this.settle(block);
        } else if (message.type === 'result') {
          result = message.subtype === 'success' ? message.result || '' : `Stopped early (${message.subtype}).`;
          this.office.addUsage(this, message.modelUsage);
          setResult(result);
          release();
        }
      }
    } finally {
      release();
    }
  }

  /** Scripted stand-in used with OFFICE_DEMO=1 so the office can be tried without spending tokens. */
  async runDemo(prompt) {
    const steps = {
      senior: ['Reading EventService.cs', 'Editing EventService.cs', 'Running tests', 'Editing EventService.cs', 'Running tests'],
      junior: ['Reading Footer.cshtml', 'Editing Footer.cshtml', 'Building'],
      qa: ['Reading the diff', 'Running tests', 'Checking /us/events'],
      pm: ['Checking Jira', 'Updating Jira'],
      reviewer: ['Reading the diff', 'Reading EventService.cs', 'Reading the rules', 'draft pr review'],
    }[this.id] || [];
    let testRuns = 0;
    for (const step of steps) {
      this.note('does', step);
      this.set({ activity: step });
      const { signal } = this.abort;
      await Promise.race([sleep(1800 + Math.random() * 1500), new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))]);
      if (signal.aborted) return 'Stopped by the owner before finishing.';
      // The senior developer's first test run fails, to show the red screen; later runs pass.
      if (step === 'Running tests') this.set({ mood: this.id === 'senior' && (testRuns += 1) === 1 ? 'failing' : 'passing' });
    }
    if (this.id === 'pm') {
      this.office.setBoard([
        { name: 'Open', count: 14 }, { name: 'In Progress', count: 3 }, { name: 'Peer Review', count: 2 }, { name: 'Testing', count: 5 },
      ]);
    }
    const share = 0.8 + Math.random() * 0.4;
    this.office.addUsage(this, {
      [this.model]: { inputTokens: Math.round(9000 * share), outputTokens: Math.round(3500 * share), cacheCreationInputTokens: Math.round(12000 * share), cacheReadInputTokens: 90000 },
    });
    return `Demo report: finished "${clip(prompt, 60)}". Nothing real was changed.`;
  }
}

export class Office {
  constructor(config, project, dataDirectory, broadcast) {
    this.config = config;
    this.project = project; // { id, name, path, jiraKey }
    this.demo = process.env.OFFICE_DEMO === '1';
    this.broadcast = broadcast;
    this.stateFile = path.join(dataDirectory, `state-${project.id}.json`);
    this.agents = {};
    for (const [id, definition] of Object.entries(config.agents)) this.agents[id] = new Agent(this, id, definition);
    this.chat = [];
    this.questions = [];
    this.approvals = new Map(); // question id -> resolve(boolean)
    this.inbox = [];
    this.pumping = false;
    this.usageByDay = {}; // 'YYYY-MM-DD' -> { agentId: { model: tokens } }
    this.board = null; // { columns: [{ name, count }], at, source } shown on the office wall
    this.backlog = []; // the office's own board, for projects without Jira
    this.lastRoutine = {}; // 'standup' | 'endOfDay' -> the day it last ran
    this.managerTools = this.buildManagerTools();
    this.pmTools = this.buildPmTools();
    this.reviewerTools = this.buildReviewerTools();
    this.load();
  }

  // ---- usage, board, routines ---------------------------------------------

  today() {
    return new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
  }

  /**
   * Records a turn's token use, per model. This counts new input, output and cache writes. Cache
   * re-reads are left out: they are far cheaper and would drown out everything else. It is a guide
   * to how fast the plan's limits are being used, not a bill.
   */
  addUsage(agent, modelUsage = {}) {
    const day = ((this.usageByDay[this.today()] ||= {})[agent.id] ||= {});
    let added = 0;
    for (const [model, use] of Object.entries(modelUsage || {})) {
      const tokens = (use.inputTokens || 0) + (use.outputTokens || 0) + (use.cacheCreationInputTokens || 0);
      if (!tokens) continue;
      day[model] = (day[model] || 0) + tokens;
      added += tokens;
    }
    if (!added) return;
    agent.tokens += added;
    this.save();
    this.emit('agent', agent.snapshot());
  }

  /** Today's tokens for one agent: the total, and the total per model name. */
  tokensToday(id) {
    const byModel = {};
    let total = 0;
    for (const [model, tokens] of Object.entries(this.usageByDay[this.today()]?.[id] || {})) {
      const label = modelLabel(this.config, model);
      byModel[label] = (byModel[label] || 0) + tokens;
      total += tokens;
    }
    return { total, byModel };
  }

  setBoard(columns, source = 'Jira') {
    this.board = { columns: columns.slice(0, 8), at: Date.now(), source };
    this.emit('board', this.boardSnapshot());
  }

  /** Without Jira the wall board is the office backlog, counted by status. */
  boardSnapshot() {
    if (this.project.jiraKey) {
      // A project's own "jiraUrl" wins; otherwise the site from config.json plus the project key.
      const site = (this.config.jiraSite || '').replace(/\/+$/, '');
      const link = this.project.jiraUrl || (site ? `${site}/browse/${encodeURIComponent(this.project.jiraKey)}` : null);
      return { board: this.board, backlog: null, boardLink: link, boardLinkLabel: `Open ${this.project.jiraKey} in Jira` };
    }
    const columns = ['To do', 'Doing', 'Done'].map((name) => ({
      name,
      count: this.backlog.filter((item) => item.status === name).length,
    }));
    return { board: { columns, at: Date.now(), source: 'Office backlog' }, backlog: this.backlog };
  }

  celebrate(text) {
    this.say('system', text);
    this.emit('celebrate', {});
  }

  /** Stand-up and end-of-day: canned requests to the manager, from a button or the clock. */
  routine(kind) {
    const manager = this.agents.manager.name;
    const pm = this.agents.pm.name;
    const usage = Object.values(this.agents)
      .map((agent) => `${agent.name} ${formatTokens(this.tokensToday(agent.id).total)}`)
      .join(', ');
    const board = this.project.jiraKey ? `the ${this.project.jiraKey} Jira board` : 'the office backlog';
    const requests = {
      standup: {
        notice: `Stand-up started. ${manager} will post the plan for the day.`,
        text: `[Morning stand-up requested by ${this.config.ownerName}]
Have ${pm} triage ${board} first. When the triage report arrives, post a short plan for the day with
tell_owner (what each person will work on, in priority order, and anything blocked), then assign the work.
Ask the owner only if a priority call is truly theirs.`,
      },
      endOfDay: {
        notice: `End-of-day summary requested from ${manager}.`,
        text: `[End-of-day summary requested by ${this.config.ownerName}]
Post one end-of-day summary with tell_owner and assign no new work. Cover: what was finished and verified
today, what is still in progress and where it stands, what is waiting on the owner, and today's token use
(${usage}; a guide to plan usage, not money). Use what you already know from today's reports; say plainly if nothing happened.`,
      },
    };
    const request = requests[kind];
    if (!request) return;
    this.lastRoutine[kind] = this.today();
    this.say('system', request.notice);
    if (kind === 'standup') this.emit('gather', {});
    this.enqueue({ from: 'routine', text: request.text });
  }

  // ---- state -------------------------------------------------------------

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.chat = saved.chat || [];
      this.questions = (saved.questions || []).map((question) =>
        // An approval that was pending when the app closed can no longer be answered.
        question.kind === 'approval' && !question.answer ? { ...question, answer: 'Expired (office restarted)' } : question,
      );
      for (const [id, stored] of Object.entries(saved.agents || {})) {
        if (!this.agents[id]) continue;
        this.agents[id].sessionId = stored.sessionId || null;
        this.agents[id].sessionPath = stored.sessionPath || null;
        this.agents[id].tokens = stored.tokens || 0;
        this.agents[id].log = stored.log || [];
      }
      this.usageByDay = saved.usageByDay || {}; // older saves held dollar costs, which are no longer kept
      this.board = saved.board || null;
      this.backlog = saved.backlog || [];
      this.lastRoutine = saved.lastRoutine || {};
    } catch {
      // first run: nothing saved yet
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeState(), 300);
  }

  writeState() {
    const agents = {};
    for (const agent of Object.values(this.agents)) {
      agents[agent.id] = { sessionId: agent.sessionId, sessionPath: agent.sessionPath, tokens: agent.tokens, log: agent.log };
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const { chat, questions, usageByDay, board, backlog, lastRoutine } = this;
    fs.writeFileSync(this.stateFile, JSON.stringify({ chat, questions, agents, usageByDay, board, backlog, lastRoutine }, null, 1));
  }

  /** True while anyone is working or an approval is pending: the project cannot be switched then. */
  busy() {
    return this.pumping || this.approvals.size > 0 || Object.values(this.agents).some((agent) => agent.status === 'working');
  }

  /** Writes state now. Called before another project takes over the floor. */
  flush() {
    clearTimeout(this.saveTimer);
    this.writeState();
    this.closed = true;
  }

  emit(type, payload) {
    if (this.closed) return;
    this.broadcast({ type, payload });
    this.save();
  }

  snapshot() {
    const logs = {};
    for (const agent of Object.values(this.agents)) logs[agent.id] = agent.log;
    return {
      officeName: this.config.officeName || null,
      owner: this.config.ownerName,
      project: this.project.id,
      demo: this.demo,
      agents: Object.values(this.agents).map((agent) => agent.snapshot()),
      chat: this.chat,
      questions: this.questions,
      logs,
      ...this.boardSnapshot(),
    };
  }

  say(from, text) {
    const message = { id: randomUUID(), at: Date.now(), from, text };
    this.chat.push(message);
    if (this.chat.length > CHAT_LIMIT) this.chat.shift();
    this.emit('chat', message);
  }

  // ---- owner -------------------------------------------------------------

  ownerMessage(text) {
    this.say('owner', text);
    if (this.stopCommand(text)) return; // handled at once, without waiting for the manager's turn
    this.enqueue({ from: 'owner', text: `[Message from ${this.config.ownerName}, the owner]\n${text}` });
  }

  ownerAnswer(id, text) {
    const question = this.questions.find((candidate) => candidate.id === id);
    if (!question || question.answer) return;
    question.answer = text;
    this.emit('question', question);
    if (question.kind === 'approval') {
      this.approvals.get(id)?.(/^approve/i.test(text));
      this.approvals.delete(id);
    } else {
      this.enqueue({ from: 'owner', text: `[${this.config.ownerName} answered your question "${question.text}"]\n${text}` });
    }
  }

  ask(kind, text, options, about, extra = {}) {
    const question = { id: randomUUID(), at: Date.now(), kind, text, options, about, answer: null, ...extra };
    this.questions.push(question);
    this.emit('question', question);
    this.emit('visit', { from: 'manager', to: 'owner' });
    return question;
  }

  requestApproval(agent, toolName, input) {
    // The card shows what will happen in plain English; the exact command is kept for those who want it.
    const { headline, steps, command } = describeApproval(toolName, input);
    const question = this.ask('approval', `${agent.name} (${agent.role}) wants to ${headline}.`, ['Approve', 'Decline'], agent.id, {
      approval: { name: agent.name, role: agent.role, task: agent.task, branch: agent.place.branch, headline, steps, command },
    });
    return new Promise((resolve) => this.approvals.set(question.id, resolve));
  }

  stopAll() {
    this.inbox.length = 0;
    for (const agent of Object.values(this.agents)) agent.abort?.abort();
    this.declineApprovals();
    this.say('system', 'Everyone has been told to stop.');
  }

  /**
   * A plain "stop Claudius" (or "stop the QA and Claudio", "stop everyone") is acted on here, at once.
   * Going through the manager would wait for their current turn to end and then for a model reply.
   * Anything longer or less clear returns false and goes to the manager as usual.
   */
  stopCommand(text) {
    const match = /^\s*(?:please\s+|can you\s+|could you\s+)?stop\s+(.+?)\s*[.!?]*\s*$/i.exec(text);
    if (!match || text.length > 120) return false;
    const names = match[1]
      .replace(/\b(right now|now|please|immediately|working|what (?:he|she|they) (?:is|are) doing)\b/gi, ' ')
      .split(/,|&|\band\b/i)
      .map((name) => name.replace(/^\s*the\s+/i, '').trim().toLowerCase())
      .filter(Boolean);
    if (!names.length) return false;
    if (names.length === 1 && /^(everyone|everybody|all|all agents|the team|team)$/.test(names[0])) {
      this.stopAll();
      return true;
    }
    const agents = names.map((name) =>
      Object.values(this.agents).find((agent) => [agent.id, agent.name.toLowerCase(), agent.role.toLowerCase()].includes(name)),
    );
    if (agents.some((agent) => !agent)) return false;
    for (const agent of new Set(agents)) {
      const reply = this.stopAgent(agent.id, 'owner');
      if (/not working/.test(reply)) this.say('system', reply);
    }
    return true;
  }

  /**
   * A message from the owner straight to one agent, from the box in their log. The manager is not
   * involved. "/clear", "/model", "/stop" and "/help" are handled here; any other "/command"
   * (such as /compact, or a skill's name) goes to the agent's own session, which runs it.
   * Anything else is a normal message, sent into the agent's existing conversation.
   */
  directMessage(id, text) {
    const agent = this.agents[id];
    const reply = (line) => agent.note('office', line);
    if (!agent) return;
    const command = /^\/(\S+)\s*(.*)$/s.exec(text);
    const name = command?.[1].toLowerCase();
    const rest = command?.[2].trim() || '';
    agent.note('you', text);

    if (name === 'help') {
      reply('Type a message to talk to ' + agent.name + ' directly. Commands: /clear forgets their conversation, /model <name> changes their usual model, /stop stops them, /plugins lists the plugins loaded just for them. Any other /command (for example /compact, or a skill) is passed to their session.');
      return;
    }
    if (name === 'stop') {
      reply(this.stopAgent(id, 'owner'));
      return;
    }
    if (name === 'plugins') {
      reply(agent.plugins.length ? 'Plugins loaded only for ' + agent.name + ': ' + agent.plugins.join(', ') : 'No plugins are loaded just for ' + agent.name + '. Add folders to "plugins" for this agent in config.local.json, then restart the office.');
      return;
    }
    if (agent.status !== 'idle') {
      reply(agent.name + ' is busy with "' + agent.task + '". Use /stop first, or wait.');
      return;
    }
    if (name === 'clear') {
      agent.sessionId = null;
      agent.sessionPath = null;
      this.save();
      reply('Conversation cleared. ' + agent.name + ' starts fresh next time.');
      return;
    }
    if (name === 'model') {
      const chosen = findModel(this.config, rest);
      if (!chosen) {
        reply('Choose one of: ' + modelList(this.config).map((entry) => entry.id).join(', ') + '.');
        return;
      }
      agent.set({ defaultModel: chosen.id, model: chosen.id });
      reply(agent.name + ' now uses ' + modelLabel(this.config, chosen.id) + ' until the office restarts. Set it in config.local.json to keep it.');
      return;
    }
    if (id === 'manager' && !command) {
      reply('Talk to the manager in the main chat. Here you can use /clear, /model and /help.');
      return;
    }
    if (id === 'manager') {
      reply('Only /clear, /model and /help work for the manager.');
      return;
    }
    // A real message: run it in the agent's conversation, where they last worked if that folder is still there.
    const folder = fs.existsSync(agent.place.path) ? agent.place : { branch: null, path: this.project.path };
    const isDeveloper = (agentId) => agentId === 'senior' || agentId === 'junior';
    const clash = Object.values(this.agents).find(
      (other) =>
        other.id !== id && other.id !== 'manager' && other.id !== 'pm' && other.status !== 'idle' &&
        other.place.branch === folder.branch && id !== 'pm' && (isDeveloper(id) || isDeveloper(other.id)),
    );
    if (clash) {
      reply(clash.name + ' is working in the same folder. Wait until they finish, then try again.');
      return;
    }
    agent.place = folder;
    agent.set({ status: 'working', task: 'Your message', activity: 'Reading your message', mood: null });
    this.inbox.push({ from: 'office', text: '[Office note] ' + this.config.ownerName + ' sent ' + agent.name + ' a direct message. No report will come to you.' });
    agent.run(text, { fresh: false }).then((answer) => {
      const last = [...agent.log].reverse().find((entry) => entry.kind === 'says');
      if (answer && last?.text !== answer.trim()) agent.note('report', answer);
      agent.set({ status: 'idle', task: null, activity: '', model: agent.defaultModel });
    });
  }

  /** Declines the approvals that are waiting, for one agent or for everyone. */
  declineApprovals(agentId = null) {
    for (const [id, resolve] of [...this.approvals]) {
      const question = this.questions.find((candidate) => candidate.id === id);
      if (agentId && question?.about !== agentId) continue;
      resolve(false);
      this.approvals.delete(id);
      if (question) {
        question.answer = 'Declined (stopped)';
        this.emit('question', question);
      }
    }
  }

  /**
   * Ends one agent's running session. Their task is abandoned where it stands; files already
   * changed stay as they are. "by" is who asked: the owner (button) or the manager (stop_agent).
   */
  stopAgent(id, by = 'owner') {
    const agent = this.agents[id];
    if (!agent) return 'There is nobody with that desk.';
    if (agent.status === 'idle') return `${agent.name} is not working on anything.`;
    const task = agent.task;
    this.declineApprovals(id);
    agent.abort?.abort();
    this.say('system', `${agent.name} has been stopped${task ? ` ("${task}")` : ''}.`);
    if (by === 'owner' && id !== 'manager') {
      // The manager hears about it with their next message, without being woken for it.
      this.inbox.push({
        from: 'office',
        text: `[Office note] ${this.config.ownerName} stopped ${agent.name}${task ? ` on "${task}"` : ''}. No report will come. Do not reassign it unless asked.`,
      });
    }
    return `${agent.name} has been stopped${task ? ` on "${task}"` : ''}. No report will come. Changes already made are still in place.`;
  }

  // ---- manager loop ------------------------------------------------------

  enqueue(item) {
    this.inbox.push(item);
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const manager = this.agents.manager;
    try {
      while (this.inbox.length) {
        const items = this.inbox.splice(0);
        const fromOwner = items.some((item) => item.from === 'owner');
        manager.set({ status: 'working', activity: fromOwner ? 'Reading your message' : 'Reading reports' });
        const reply = this.demo
          ? await this.demoManager(items)
          : await manager.run(items.map((item) => item.text).join('\n\n'));
        if (reply.startsWith('Failed to run')) {
          const hint = /authenticat|oauth|log ?in/i.test(reply)
            ? ' Sign in again: open a terminal, run "claude", type /login, then resend your message.'
            : '';
          this.say('system', `The manager could not run. ${reply}${hint}`);
        } else if (fromOwner && reply.trim()) this.say('manager', reply.trim());
        const waiting = this.questions.some((question) => question.kind === 'question' && !question.answer);
        manager.set({ status: waiting ? 'waiting' : 'idle', activity: waiting ? 'Waiting for your answer' : '' });
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- worktrees ---------------------------------------------------------

  git(...args) {
    return execFileSync('git', args, { cwd: this.project.path, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  worktreeFolder(branch) {
    return path.join(this.project.path, '.claude', 'worktrees', branch.replace(/[\\/]+/g, '-'));
  }

  /** Creates the worktree for a branch if it is not there yet and returns its folder. */
  ensureWorktree(branch) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
      throw new Error(`"${branch}" is not a usable branch name.`);
    }
    const folder = this.worktreeFolder(branch);
    if (this.demo || fs.existsSync(folder)) return folder;
    // Keep worktree folders out of the repository's status without touching a tracked file.
    try {
      this.git('check-ignore', '-q', '.claude/worktrees/x');
    } catch {
      const exclude = path.resolve(this.project.path, this.git('rev-parse', '--git-common-dir'), 'info', 'exclude');
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, '\n.claude/worktrees/\n');
    }
    let exists = true;
    try {
      this.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    } catch {
      exists = false;
    }
    if (exists) {
      this.git('worktree', 'add', folder, branch);
      return folder;
    }
    // A new branch starts from the remote's default branch when there is one, else from HEAD.
    let base = 'HEAD';
    try {
      this.git('fetch', 'origin', '--quiet');
      base = this.git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
    } catch {
      // no remote, or offline: branch from the main checkout's HEAD
    }
    this.git('worktree', 'add', '-b', branch, folder, base);
    return folder;
  }

  removeWorktree(branch) {
    const occupant = Object.values(this.agents).find((agent) => agent.status !== 'idle' && agent.place.branch === branch);
    if (occupant) return `${occupant.name} is still working on ${branch}. Wait for the report first.`;
    if (this.demo) return `Removed the worktree for ${branch} (demo).`;
    try {
      this.git('worktree', 'remove', this.worktreeFolder(branch));
      return `Removed the worktree for ${branch}. The branch itself is kept.`;
    } catch (error) {
      // git refuses when the worktree has uncommitted changes; that is the safe outcome.
      return `Could not remove it: ${clip(String(error.stderr || error.message), 300)}`;
    }
  }

  assign(agentId, title, task, continuePrevious, branch, modelName) {
    const agent = this.agents[agentId];
    if (agent.status !== 'idle') {
      return `${agent.name} is busy with "${agent.task}". Wait for the report before assigning more.`;
    }
    // The manager may put someone on a different model for this one task; otherwise they use their usual one.
    let model = agent.defaultModel;
    if (modelName) {
      const chosen = findModel(this.config, modelName);
      if (!chosen) return `"${modelName}" is not an allowed model. Choose one of: ${modelList(this.config).map((entry) => entry.id).join(', ')}.`;
      model = chosen.id;
    }
    const useBranch = agentId === 'pm' ? null : branch || null;
    if (agentId !== 'pm') {
      // Two people never share a folder while one of them is changing code.
      const isDeveloper = (id) => id === 'senior' || id === 'junior';
      const clash = Object.values(this.agents).find(
        (other) =>
          other.id !== 'manager' && other.id !== 'pm' && other.status !== 'idle' &&
          other.place.branch === useBranch && (isDeveloper(agentId) || isDeveloper(other.id)),
      );
      if (clash) {
        return `${clash.name} is working in ${useBranch ? `the ${useBranch} worktree` : 'the main checkout'}. ` +
          'Give this task its own branch, or wait for that report.';
      }
    }
    let folder = this.project.path;
    if (useBranch) {
      try {
        folder = this.ensureWorktree(useBranch);
      } catch (error) {
        return `Could not prepare the worktree for ${useBranch}: ${clip(String(error.stderr || error.message), 300)}`;
      }
    }
    agent.place = { branch: useBranch, path: folder };
    agent.set({ status: 'working', task: title, activity: 'Starting', mood: null, model });
    const onModel = model !== agent.defaultModel ? ` on ${modelLabel(this.config, model)}` : '';
    agent.note('task', `${title}${useBranch ? ` (branch ${useBranch})` : ''}${onModel}\n${task}`);
    if (onModel) this.say('system', `${this.agents.manager.name} put ${agent.name}${onModel} for "${title}" (their usual model is ${modelLabel(this.config, agent.defaultModel)}).`);
    this.emit('visit', { from: 'manager', to: agentId });
    // The contractor never carries anything over from an earlier review.
    agent.run(task, { fresh: agentId === 'reviewer' || !continuePrevious }).then((report) => {
      agent.note('report', report);
      agent.set({ status: 'idle', task: null, activity: '', model: agent.defaultModel }); // the change lasts for one task
      if (agent.abort?.signal.aborted) return; // stopped by the owner: do not wake the manager
      this.emit('visit', { from: agentId, to: 'manager' });
      this.enqueue({ from: agentId, text: `[Report from ${agent.name} (${agent.role}) on "${title}"]\n${report}` });
    });
    return `Assigned to ${agent.name}. The report will arrive as a later message; end your turn if you have nothing else to do.`;
  }

  buildManagerTools() {
    const text = (value) => ({ content: [{ type: 'text', text: value }] });
    const models = modelList(this.config);
    return createSdkMcpServer({
      name: 'office',
      version: '1.0.0',
      tools: [
        tool(
          'assign_task',
          'Give a task to a member of staff. Returns immediately; their report arrives later as a message.',
          {
            agent: z.enum(STAFF).describe('Who gets the task'),
            title: z.string().describe('Short title shown on the office floor, about 3 to 8 words'),
            task: z.string().describe('Full, self-contained instructions: goal, files or ticket, what done looks like'),
            continue_previous: z
              .boolean()
              .optional()
              .describe('true to continue that agent\'s previous conversation (a follow-up or rework on the same branch); false or omitted starts fresh'),
            branch: z
              .string()
              .optional()
              .describe('Branch for this work. The office creates a git worktree for it and the agent works there. Omit to use the main checkout. Ignored for pm.'),
            model: z
              .enum(models.map((entry) => entry.id))
              .optional()
              .describe(`Model for this task only. Omit to use the person's usual model. ${models.map((entry) => `${entry.id}: ${entry.use}`).join('; ')}`),
          },
          async (input) => text(this.assign(input.agent, input.title, input.task, input.continue_previous === true, input.branch, input.model)),
        ),
        tool(
          'stop_agent',
          'Stop a member of staff now: ends their running session and abandons their task. Use it when the owner asks you to stop someone. No report arrives afterwards.',
          { agent: z.enum(STAFF).describe('Who to stop') },
          async (input) => text(this.stopAgent(input.agent, 'manager')),
        ),
        tool(
          'remove_worktree',
          'Remove the worktree of a branch whose work is merged or abandoned. The branch is kept; git refuses if there are uncommitted changes.',
          { branch: z.string() },
          async (input) => text(this.removeWorktree(input.branch)),
        ),
        tool(
          'ask_owner',
          'Ask the owner one question that only they can answer. Returns immediately; the answer arrives later as a message.',
          {
            question: z.string(),
            options: z.array(z.string()).max(4).optional().describe('Short answer buttons, recommended option first'),
          },
          async (input) => {
            this.ask('question', input.question, input.options || [], 'manager');
            return text('Question shown to the owner. End your turn; the answer will arrive as a message.');
          },
        ),
        tool(
          'tell_owner',
          'Tell the owner something worth knowing that needs no reply (work finished and verified, a real problem).',
          { message: z.string() },
          async (input) => {
            this.say('manager', input.message);
            this.emit('visit', { from: 'manager', to: 'owner' });
            return text('Shown to the owner.');
          },
        ),
        tool('office_status', 'See what every member of staff is doing right now, and which worktrees exist.', {}, async () => {
          const staff = STAFF.map((id) => {
            const agent = this.agents[id];
            const where = agent.place.branch ? ` in worktree ${agent.place.branch}` : '';
            const onModel = agent.task ? `, model ${modelLabel(this.config, agent.model)}` : `, usual model ${modelLabel(this.config, agent.defaultModel)}`;
            return `${id} (${agent.name}, ${agent.role}): ${agent.status}${onModel}${agent.task ? `, on "${agent.task}"${where}, ${agent.activity}` : ''}`;
          });
          let worktrees = 'unknown';
          try {
            worktrees = this.demo ? '(demo)' : this.git('worktree', 'list');
          } catch {
            worktrees = 'This project is not a git repository, so worktrees are unavailable.';
          }
          return text(`${staff.join('\n')}\n\nWorktrees:\n${worktrees}`);
        }),
      ],
    });
  }

  /**
   * Saves the contractor's notes on a pull request as a pending review. GitHub shows a pending
   * review only to its author (the account gh is signed in as, the owner's) until they submit it.
   */
  draftReview(agent, pullRequest, summary, comments) {
    const where = `pull request #${pullRequest}`;
    if (this.demo) {
      this.say('system', `${agent.name} left a draft review on ${where} (demo). Nobody else can see it until you submit it on GitHub.`);
      return `Saved as a draft review on ${where} (demo).`;
    }
    const post = (payload) =>
      JSON.parse(
        execFileSync('gh', ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${pullRequest}/reviews`, '--input', '-'], {
          cwd: agent.place.path, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    const problem = (error) => clip(String(error.stderr || error.message), 400);
    let review;
    let folded = false;
    try {
      // No "event" field: that is what keeps the review pending instead of publishing it.
      review = post({
        body: summary,
        comments: comments.map((comment) => ({ path: comment.path, line: comment.line, side: 'RIGHT', body: comment.body })),
      });
    } catch (error) {
      if (!comments.length || /pending review/i.test(problem(error))) {
        return `Could not save the draft review: ${problem(error)}. Put your notes in your report instead.`;
      }
      // GitHub refuses a line that is not part of the diff: keep the notes, in the summary instead.
      const notes = comments.map((comment) => `- ${comment.path}:${comment.line} ${comment.body}`).join('\n');
      try {
        review = post({ body: `${summary}\n\n${notes}` });
        folded = true;
      } catch (retryError) {
        return `Could not save the draft review: ${problem(retryError)}. Put your notes in your report instead.`;
      }
    }
    if (review.state !== 'PENDING') return `GitHub saved the review as ${review.state}, not as a draft. Report this to the manager.`;
    this.say(
      'system',
      `${agent.name} left a draft review on ${where}: ${review.html_url || ''}\nNobody else can see it until you read it and submit it on GitHub (or discard it).`,
    );
    return `Saved as a draft review on ${where}${folded ? ' (line notes were moved into the summary because GitHub would not attach them to the diff)' : ''}. Only the owner can see it, and only they can submit it.`;
  }

  /** The contractor reviewer's one way to write: a draft review the owner must read and submit. */
  buildReviewerTools() {
    const text = (value) => ({ content: [{ type: 'text', text: value }] });
    return createSdkMcpServer({
      name: 'office',
      version: '1.0.0',
      tools: [
        tool(
          'draft_pr_review',
          'Save your review notes on the pull request as a DRAFT (pending) review. It is not published: the owner reads it on GitHub and submits or discards it. Call it once, at the end, with everything.',
          {
            pull_request: z.number().int().positive().describe('The pull request number'),
            summary: z.string().describe('The overall review: verdict first, then the main points'),
            comments: z
              .array(z.object({
                path: z.string().describe('File path in the repository'),
                line: z.number().int().positive().describe('Line number in the new version of the file; it must be a line the pull request changes'),
                body: z.string(),
              }))
              .max(40)
              .optional()
              .describe('Notes tied to changed lines'),
          },
          async (input) => text(this.draftReview(this.agents.reviewer, input.pull_request, input.summary, input.comments || [])),
        ),
      ],
    });
  }

  /** The project manager's tools: the wall board, and the office backlog for projects without Jira. */
  buildPmTools() {
    const text = (value) => ({ content: [{ type: 'text', text: value }] });
    const status = z.enum(['To do', 'Doing', 'Done']);
    const size = z.enum(['junior', 'senior']);
    const describe = (item) => `#${item.id} [${item.status}] (${item.size}) ${item.title}${item.detail ? `\n   ${item.detail}` : ''}`;
    const changed = () => {
      this.emit('board', this.boardSnapshot());
    };
    return createSdkMcpServer({
      name: 'office',
      version: '1.0.0',
      tools: [
        tool(
          'set_board',
          'Update the board on the office wall with the number of Jira tickets in each column. Call it whenever you have read the board.',
          { columns: z.array(z.object({ name: z.string(), count: z.number().int().min(0) })).min(1).max(8) },
          async (input) => {
            if (!this.project.jiraKey) return text('This project has no Jira board; the wall shows the office backlog automatically.');
            this.setBoard(input.columns);
            return text('Wall board updated.');
          },
        ),
        tool('backlog_list', 'List the office backlog (the board for projects without Jira).', {}, async () =>
          text(this.backlog.length ? this.backlog.map(describe).join('\n') : 'The backlog is empty.'),
        ),
        tool(
          'backlog_add',
          'Add an item to the office backlog.',
          { title: z.string(), detail: z.string().optional(), size: size.describe('junior = small and well-defined, senior = needs design or judgement') },
          async (input) => {
            const id = this.backlog.reduce((highest, item) => Math.max(highest, item.id), 0) + 1;
            const item = { id, title: input.title, detail: input.detail || '', size: input.size, status: 'To do' };
            this.backlog.push(item);
            changed();
            return text(`Added ${describe(item)}`);
          },
        ),
        tool(
          'backlog_update',
          'Change an office backlog item: its status, size, title or detail.',
          { id: z.number().int(), status: status.optional(), size: size.optional(), title: z.string().optional(), detail: z.string().optional() },
          async (input) => {
            const item = this.backlog.find((candidate) => candidate.id === input.id);
            if (!item) return text(`There is no backlog item #${input.id}.`);
            for (const key of ['status', 'size', 'title', 'detail']) if (input[key] !== undefined) item[key] = input[key];
            changed();
            return text(`Updated ${describe(item)}`);
          },
        ),
      ],
    });
  }

  /** Scripted manager for OFFICE_DEMO=1. */
  async demoManager(items) {
    await sleep(900);
    const routine = items.find((item) => item.from === 'routine');
    if (routine && /stand-up/i.test(routine.text)) {
      this.assign('pm', 'Triage the board', 'Demo: triage.', false);
      return '';
    }
    if (routine) {
      this.say('manager', 'End of day (demo): the events fix is finished and passed QA, the footer copy is done, nothing is waiting on you.');
      return '';
    }
    const owner = items.find((item) => item.from === 'owner');
    if (owner && /answered your question/.test(owner.text)) {
      if (/Open the PR now/.test(owner.text)) {
        this.assign('reviewer', 'Review pull request 12', 'Demo: review the pull request.', false, 'bug/DEMO-1-events-date');
        return 'Thanks. The pull request is open and the contractor is coming in to review it.';
      }
      return 'Thanks, noted. I will carry on with that.';
    }
    if (owner && /approval/i.test(owner.text)) {
      // Lets you see an approval card without real agents: say "show me an approval".
      const junior = this.agents.junior;
      junior.task = 'Tidy the footer copy';
      junior.place = { branch: 'chore/DEMO-2-footer-copy', path: this.project.path };
      const command = 'git add -- Views/Footer.cshtml && git commit -q -m "chore: tidy the footer copy (DEMO-2)" && git push -u origin chore/DEMO-2-footer-copy; gh pr create --base main --title "[CHORE] Tidy the footer copy" --body-file body.md';
      this.requestApproval(junior, 'PowerShell', { command }).then((approved) => this.say('system', `Demo approval ${approved ? 'approved' : 'declined'}.`));
      return 'Here is what an approval looks like. **Nothing real** will run:\n\n- The summary says what will happen\n- The exact command is under `Show the full command`\n\nSee https://docs.github.com for more.';
    }
    if (owner) {
      this.assign('pm', 'Find the ticket', 'Demo: look the ticket up in Jira.', false);
      await sleep(700);
      this.assign('senior', 'Fix the events date bug', 'Demo: fix the bug.', false, 'bug/DEMO-1-events-date', 'claude-fable-5-2');
      await sleep(700);
      this.assign('junior', 'Tidy the footer copy', 'Demo: small copy fix.', false, 'chore/DEMO-2-footer-copy');
      const { pm, senior, junior } = this.agents;
      return `On it. ${pm.name} is finding the ticket, ${senior.name} has the bug and ${junior.name} has the quick fix. I will only come back to you if I need a decision.`;
    }
    const developerDone = items.some((item) => item.from === 'senior');
    if (developerDone) this.assign('qa', 'Test the events fix', 'Demo: test the fix.', false, 'bug/DEMO-1-events-date');
    if (items.some((item) => item.from === 'reviewer')) {
      this.draftReview(this.agents.reviewer, 12, 'Demo review.', []);
      this.celebrate(`${this.agents.senior.name} merged a pull request (demo).`);
    }
    if (items.some((item) => item.from === 'qa')) {
      this.ask('question', `QA passed the events fix. Should ${this.agents.senior.name} open the pull request now, or hold it for tomorrow's release?`, ['Open the PR now', 'Hold for tomorrow'], 'manager');
    }
    return '';
  }
}
