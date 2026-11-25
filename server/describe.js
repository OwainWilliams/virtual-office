// Turns an action that needs the owner's approval into a few plain-English lines, so the
// approval card says what will happen instead of showing a wall of shell.

const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** The value of a quoted flag such as --title "..." or -m '...'. */
function flagValue(command, flag) {
  const match = new RegExp(`${flag}\\s+(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|(\\S+))`).exec(command);
  return match ? (match[1] ?? match[2] ?? match[3]) : '';
}

/** The plain arguments (not flags) that follow a command, up to the next shell separator. */
function plainArguments(command, pattern) {
  const match = pattern.exec(command);
  if (!match) return null;
  const rest = command.slice(match.index + match[0].length).split(/&&|\|\||[;|\n]|\d?>/)[0];
  return rest.trim().split(/\s+/).filter((word) => word && !word.startsWith('-')).map((word) => word.replace(/^["']|["']$/g, ''));
}

function describeCommand(command) {
  const steps = [];
  const add = (text, verb) => steps.push({ text, needsApproval: Boolean(verb), verb: verb || null });

  if (/\bgit\s+commit\b/.test(command)) {
    const message = flagValue(command.slice(command.search(/\bgit\s+commit\b/)), '-m');
    const files = plainArguments(command, /\bgit\s+add\b/) || [];
    const what = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} (${clip(files.map((file) => file.split('/').pop()).join(', '), 80)})` : 'the staged changes';
    add(`Commit ${what}${message ? `: "${clip(message, 120)}"` : ''}`);
  }
  if (/\bgit\s+merge\s/.test(command)) {
    const [branch] = plainArguments(command, /\bgit\s+merge\b/) || [];
    add(`Merge ${branch || 'another branch'} into the current branch`, 'merge a branch');
  }
  if (/\bgit\s+branch\s+-D\b/.test(command)) {
    const [branch] = plainArguments(command, /\bgit\s+branch\s+-D\b/) || [];
    add(`Delete the local branch ${branch || '(see the full command)'}`, 'delete a branch');
  }
  if (/\bgit\s+push\b/.test(command)) {
    const [remote, branch] = plainArguments(command, /\bgit\s+push\b/) || [];
    add(`Push ${branch ? `branch ${branch}` : 'the current branch'} to ${!remote || remote === 'origin' ? 'GitHub' : remote}`, 'push to GitHub');
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const title = flagValue(command, '--title');
    const base = flagValue(command, '--base');
    const draft = /\s--draft\b/.test(command);
    add(`Open a ${draft ? 'draft ' : ''}pull request${title ? `: "${clip(title, 120)}"` : ''}${base ? ` into ${base}` : ''}`, 'open a pull request');
  }
  if (/\bgh\s+pr\s+merge\b/.test(command)) {
    const [number] = plainArguments(command, /\bgh\s+pr\s+merge\b/) || [];
    const how = /--squash\b/.test(command) ? ' (squash)' : /--rebase\b/.test(command) ? ' (rebase)' : '';
    const tidy = /--delete-branch\b/.test(command) ? ' and delete its branch' : '';
    add(`Merge pull request${number ? ` #${number}` : ''}${how}${tidy}`, 'merge a pull request');
  }
  if (/\bgh\s+pr\s+close\b/.test(command)) {
    const [number] = plainArguments(command, /\bgh\s+pr\s+close\b/) || [];
    add(`Close pull request${number ? ` #${number}` : ''} without merging`, 'close a pull request');
  }
  if (/\bgh\s+release\b/.test(command)) {
    const [action, tag] = plainArguments(command, /\bgh\s+release\b/) || [];
    add(`${action === 'create' ? 'Publish' : `Run "release ${action || ''}" on`} release ${tag || ''}`.trim(), 'change a release');
  }
  if (/\bgh\s+pr\s+edit\b/.test(command)) {
    const [number] = plainArguments(command, /\bgh\s+pr\s+edit\b/) || [];
    add(`Edit the title or description of pull request${number ? ` #${number}` : ''}`);
  }
  const script = /\b(python3?|node|pwsh|powershell|bash|sh)\b[^&|;\n]*\s-(c|e|Command)\b/i.exec(command);
  if (script) add(`Run an inline ${script[1].toLowerCase()} script (open the full command to read it)`);

  // Say so when the command does more than the lines above cover.
  const parts = command.split(/&&|\|\||;|\n/).filter((part) => part.trim() && !/^\s*(cd|git\s+add)\b/.test(part)).length; // cd and git add are covered by the lines above
  if (steps.length && parts > steps.length) add('Other steps in the same command are not summarised here; open the full command to check them');
  return steps;
}

/**
 * Describes a tool call for the approval card.
 * Returns { headline, steps: [{ text, needsApproval }], command }.
 */
export function describeApproval(toolName, input) {
  const isShell = toolName === 'Bash' || toolName === 'PowerShell';
  const command = isShell ? String(input.command || '') : `${toolName} ${JSON.stringify(input, null, 2)}`;
  let steps = isShell ? describeCommand(command) : [];
  if (!steps.some((step) => step.needsApproval)) {
    // Nothing recognised: name the rule that asked for approval rather than guess.
    const name = toolName.replace(/^mcp__/, '').replace(/__/g, ': ').replace(/_/g, ' ');
    steps = [
      {
        text: isShell ? 'Run a command this summary does not recognise; open the full command to read it' : `Use the tool "${name}"`,
        needsApproval: true,
        verb: isShell ? 'run a command' : `use ${name}`,
      },
      ...steps,
    ];
  }
  const verbs = [...new Set(steps.filter((step) => step.needsApproval).map((step) => step.verb))];
  const headline = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}` : verbs[0];
  return { headline, steps: steps.map(({ text, needsApproval }) => ({ text, needsApproval })), command };
}
