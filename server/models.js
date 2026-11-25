// The models the manager may put someone on for a task, and small helpers for showing usage.
// config.json can replace this list with its own "models".

export const DEFAULT_MODELS = [
  { id: 'haiku', label: 'Haiku', use: 'routine, mechanical work: copy changes, renames, small well-defined fixes' },
  { id: 'sonnet', label: 'Sonnet', use: 'everyday work: most testing, reviews, triage and ordinary features' },
  { id: 'opus', label: 'Opus', use: 'hard problems: design, tricky bugs, risky changes to shared code' },
  { id: 'claude-fable-5-2', label: 'Fable', use: 'the hardest work only: a problem that has already beaten Opus, deep architecture, subtle bugs across many files' },
];

export const modelList = (config) => (Array.isArray(config.models) && config.models.length ? config.models : DEFAULT_MODELS);

/** Finds an allowed model by its id or its label, ignoring case. */
export function findModel(config, name) {
  const wanted = String(name || '').trim().toLowerCase();
  return modelList(config).find((model) => model.id.toLowerCase() === wanted || model.label.toLowerCase() === wanted) || null;
}

/**
 * A short name for a model: "Opus" for "opus" or for a full id such as "claude-opus-5-5".
 * Unknown models keep their id without the "claude-" prefix.
 */
export function modelLabel(config, id) {
  const wanted = String(id || '').toLowerCase();
  const list = modelList(config);
  const known =
    list.find((model) => model.id.toLowerCase() === wanted) ||
    list.find((model) => wanted.includes(model.id.toLowerCase()) || wanted.includes(model.label.toLowerCase()));
  return known ? known.label : wanted.replace(/^claude-/, '') || 'unknown';
}

/** 1234 -> "1.2k"; 1234567 -> "1.2M". */
export function formatTokens(count) {
  const number = Number(count) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e4) return `${Math.round(number / 1e3)}k`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}
