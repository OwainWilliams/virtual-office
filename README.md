# Virtual Office

A local app that runs a small team of Claude agents on your git repository and shows them
working in a pixel-art office. You talk only to the manager.

The agents are real Claude Code sessions that can read and change files and run commands in
your project folder. Read "Guard rails" below before you point it at anything you care about.

## What you need

- [Node.js](https://nodejs.org) 20 or newer
- [Claude Code](https://claude.com/claude-code), installed and signed in (run `claude` once and
  `/login`). The agents use that login, so they count against your own plan.
- [git](https://git-scm.com). [GitHub CLI](https://cli.github.com) (`gh`, signed in) is needed
  only for pull request work and the contractor's draft reviews.
- A git repository for the team to work on

## Install and run

```
git clone <this repository>
cd <the folder>
npm install
npm start
```

Open http://localhost:4700. The first time, the office asks for a project: a name, the full
path to a git repository, and optionally a Jira key. Run it from your own terminal, not from
inside a Claude session. If the manager reports a sign-in failure, run `claude`, type `/login`,
and resend your message.

To try the office without real agents or token use, set `OFFICE_DEMO=1` first (PowerShell:
`$env:OFFICE_DEMO = '1'; npm start`; macOS or Linux: `OFFICE_DEMO=1 npm start`).

## Make it yours

`config.json` holds the defaults. Put your own settings in `config.local.json` (same folder,
not committed to git); anything in it wins over `config.json`. For example:

```json
{
  "officeName": "Acme HQ",
  "ownerName": "Sam",
  "jiraSite": "https://acme.atlassian.net",
  "agents": { "senior": { "name": "Ada", "model": "sonnet" } },
  "routines": { "standupTime": "09:00" }
}
```

You only list what you change: an agent you mention keeps its other settings, and `routines`
merge the same way. Lists such as `models`, `needsOwnerApproval` and `alwaysBlocked` are replaced
whole, so copy the default list first if you want to add to it. `port` and `projects` work here
too. Restart the office after changing either file.

## The team

| Desk | Name | Model | Does |
|---|---|---|---|
| Manager | Claudette | opus | Takes your requests, delegates, and only asks you when a decision is yours |
| Senior Developer | Claudius | opus | Demanding work that needs reasoning |
| Junior Developer | Claudio | haiku | Easy, quick wins |
| QA | Claudia | sonnet | Tests the developers' work; cannot edit files |
| Project Manager | Claudine | sonnet | Jira; cannot edit files or run commands |
| Hot desk | Claudel | opus | Contractor who comes in only to review pull requests; read-only |

Names and models are in `config.json`; override them in `config.local.json`.

The floor also has an office dog and a pet Claude spark that wander about, and idle staff
fetch a coffee from the kitchen now and then. Click either pet to give it a pat. These are
decoration only and are switched off when your system asks for reduced motion.

## Talking to one agent directly

Click an agent's name tag to open their log. The box at the bottom sends them a message
without going through the manager. They answer in the log, and the manager gets a short note
that you spoke to them.

| Type | What happens |
|---|---|
| a normal message | Goes into that agent's existing conversation. They must be idle. |
| `/clear` | Forgets their conversation, so their next task starts fresh |
| `/model sonnet` | Changes their usual model until the office restarts |
| `/stop` | Stops them, the same as the Stop button |
| `/plugins` | Lists the plugins loaded just for them |
| `/help` | Lists these commands |
| any other `/command` | Passed to their own Claude Code session, so `/compact` or a skill's name work |

For the manager only `/clear`, `/model` and `/help` apply; talk to them in the main chat.

**Plugins and skills for one agent.** List plugin folders under that agent in
`config.local.json` and restart the office:

```json
{ "agents": { "qa": { "plugins": ["C:\\plugins\\accessibility-checker"] } } }
```

Those plugins (and their skills) load for that agent only. Skills in your own Claude Code
settings or in the project's `.claude` folder are shared by everyone.
## Daily routines

- **Stand-up** (header button): the project manager triages the board, the team gathers at
  the meeting table, and the manager posts the plan for the day and assigns the work.
- **End of day** (header button): the manager posts what was finished, what is in progress,
  what is waiting on you, and the day's token use.
- To run them on the clock, set `routines.standupTime` and `routines.endOfDayTime` in
  `config.json` (for example `"09:00"` and `"17:30"`). They are off by default because they
  spend tokens without being asked. Each runs once a day, within the hour after its time,
  for the project that is open.

## Notifications

"Turn on notifications" in the header asks the browser for permission. After that you get a
desktop notification when the manager asks a question, needs an approval or sends a note,
but only while the office tab is not the one you are looking at.

## The wall board and the backlog

Click the board behind the project manager to see the count per column.

- **Project with a Jira key:** the project manager updates the counts each time they read
  the board, so it is as fresh as their last look (a stand-up refreshes it).
- **Project without a Jira key:** the office keeps its own backlog (To do, Doing, Done).
  Tell the manager about work for later and the project manager adds and sizes it; the board
  panel lists the items.

## What the floor tells you

- Each name tag shows the tokens that agent used today; hover for the split by model and the
  all-time total. The header shows the day's total. Tokens are new input, output and cache
  writes (re-reading cached text is not counted), so they are a guide to how fast your plan
  limits are being used. They are not money.
- When the manager has put someone on a different model for a task, their tag says "on Fable"
  (or whichever) until the task ends.
- A laptop lid turns red while that task's latest test run is failing, and shows a green
  light once it passes.
- When a pull request is merged, confetti falls and the dog gets the zoomies.
- The contractor beams in and out like a transporter when a review starts and ends.
- Click the water cooler and it spills; the pet Claude spark hurries over with a mop and cleans it up.
- The windows follow your clock: daylight, a golden dawn and dusk, stars at night.

## Projects

The office works on one project at a time. Pick it from the Project list in the header, or
use "Add project" (name, full folder path, optional Jira key). Each project keeps its own
chat, logs and agent conversations. You can only switch while everyone is idle.

A `projects` list in `config.local.json` seeds the list on first run; after that it lives in
`data/projects.json`.

## Worktrees

When the manager gives a task a branch, the office creates a git worktree for it at
`<project>/.claude/worktrees/<branch>` and the agent works there, so the two developers
can work at the same time. The agent's name tag shows the branch.

- A new branch starts from the remote's default branch (after a fetch), or from `HEAD`
  when there is no remote.
- Two people never share a folder while one is changing code: QA is sent to a branch after
  the developer reports. Without a branch, only one developer can be in the main checkout.
- If the project does not already ignore `.claude/worktrees/`, the office adds it to
  `.git/info/exclude` (local only, nothing is committed).
- The manager removes a worktree when its work is merged or abandoned. Git refuses if it
  has uncommitted changes, and the branch is always kept.

## Jira triage

Ask the manager to "work through the board". The project manager reads the tickets and
reports a list sized as junior or senior; the manager assigns from it. The project manager
recommends and never assigns.

## Choosing models

Everyone has a usual model in `config.json` (or your `config.local.json`). The manager can put someone on a different one
for a single task with the `model` option of `assign_task`: up for work that needs more
reasoning, or has already gone wrong once, and down for routine work. The change lasts for
that task, shows on the floor and in the chat, and the person goes back to their usual model
afterwards. You can also just ask ("have Claudius use Fable for this").

- The manager can only pick from `models` in `config.json` (each has an `id`, a `label`, and a
  `use` line the manager reads when deciding). Edit that list to add or remove models. The
  default is Haiku, Sonnet, Opus and Fable.
- Bigger models use your plan limits faster, so the manager is told to use the most capable one
  sparingly and never as a default.
- If a chosen model is not available to your account, the agent carries on with their usual
  model and the chat says so.

## Pull request reviews

When a pull request is opened, the manager brings in the contractor. They walk in, sit at the
hot desk, review the pull request and leave again.

- They start cold every time: a new conversation with no memory of how the work was done.
- They can read files, read the pull request and run tests. They cannot edit, commit, push,
  or post a comment or review with `gh`.
- Their one way to write is a **draft review** on the pull request (a GitHub pending review).
  GitHub shows it only to the account `gh` is signed in as, which is yours, until you open
  the pull request, read it and submit it (or discard it). The chat shows a link when one is
  waiting. Nothing is published without you.
- GitHub keeps one pending review per person per pull request, so submit or discard a draft
  before the contractor reviews the same pull request again.
- The manager gets the verdict and sends real problems back to the developer.

## How it works

- Your chat message goes to the manager. The manager hands tasks to staff with
  `assign_task`; each report comes back to the manager, never to you.
- The manager reaches you two ways: a question card (with answer buttons) or a short
  note. The browser tab title shows a count when something is waiting on you.
- Click any agent's name tag to read their activity log.
- Each agent is a Claude Code session in the project folder (or a worktree of it), so the
  repository's `CLAUDE.md`, rules and MCP servers apply.

## Guard rails

- The agents work in your real project folder and can run commands there. Use a repository
  you are happy for them to change, and keep your work committed.
- `needsOwnerApproval` in `config.json`: commands matching these patterns (push, pull
  request create or merge, Slack sends) pause until you click Approve or Decline.
- `alwaysBlocked`: commands that are refused outright (force push, hard reset,
  recursive deletes, Azure deployment commands). These lists are a safety net, not a
  sandbox: review the approval cards before you click Approve.
- The app listens on `127.0.0.1` only and rejects sockets from other origins.
- "Stop everyone" aborts all running agents.
- To stop one agent, ask the manager ("stop Claudius"), or click their name tag and use the
  Stop button in their log. Their session ends at once and the task is abandoned where it
  stands: files already changed are left as they are, and no report is sent.

## Known limits

- Worktrees separate files only. Tasks that change the same shared things (CMS or database
  schema, generated files) still conflict; the manager is told to run those one after the
  other, but nothing enforces it.
- Each member of staff does one task at a time.
- The project manager uses whatever Jira tools your Claude Code login provides. If Claudine reports none, add the Atlassian server once:
  `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp`
- An approval that is pending when the app closes expires; the agent must be asked again.
- Chat, logs and agent sessions are saved per project in `data/state-<project>.json`.
  Delete a file to start that project clean.
