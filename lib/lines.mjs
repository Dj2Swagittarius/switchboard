// Which local numbers this bot services.
//
// The user doc's phone_number is NOT authoritative: it lists a line that has
// had no traffic since 2026-07, while the live line does not appear in the doc
// at all. Sending on a dead line fails with 500 "init failed". So the list is
// configured explicitly here and toggled from the dashboard.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = new URL('../lines.json', import.meta.url);

const read = () => {
  if (!existsSync(FILE)) return { lines: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { lines: [] }; }
};

const norm = (n) => String(n ?? '').replace(/[^\d+]/g, '');

export function lines({ activeOnly = true } = {}) {
  const all = (read().lines ?? []).filter(l => l.number);
  return activeOnly ? all.filter(l => l.active !== false) : all;
}

export function primary(fallback = null) {
  return lines()[0]?.number ?? fallback;
}

// Enable or disable a line. Returns the full list.
export function setActive(number, active) {
  const cfg = read();
  const k = norm(number);
  const line = (cfg.lines ?? []).find(l => norm(l.number) === k);
  if (!line) throw new Error(`unknown line ${number}`);
  line.active = !!active;
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return lines({ activeOnly: false });
}

// Move a line to the top of the list; the first line is the primary.
export function setPrimary(number) {
  const cfg = read();
  const k = norm(number);
  const i = (cfg.lines ?? []).findIndex(l => norm(l.number) === k);
  if (i < 0) throw new Error(`unknown line ${number}`);
  const [line] = cfg.lines.splice(i, 1);
  cfg.lines.unshift(line);
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return lines({ activeOnly: false });
}

export function setLabel(number, label) {
  const cfg = read();
  const line = (cfg.lines ?? []).find(l => norm(l.number) === norm(number));
  if (!line) throw new Error(`unknown line ${number}`);
  line.label = String(label ?? '').slice(0, 40);
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return lines({ activeOnly: false });
}

// Only forgets the line here; nothing on the Ooma side is touched.
export function removeLine(number) {
  const cfg = read();
  const before = (cfg.lines ?? []).length;
  cfg.lines = (cfg.lines ?? []).filter(l => norm(l.number) !== norm(number));
  if (cfg.lines.length === before) throw new Error(`unknown line ${number}`);
  if (!cfg.lines.length) throw new Error('keep at least one line');
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return lines({ activeOnly: false });
}

// Add a line that is not yet in the config (e.g. a newly provisioned number).
export function addLine(number, label = '', active = true) {
  const cfg = read();
  const k = norm(number);
  if (!/^\+\d{10,15}$/.test(k)) throw new Error('number must be E.164, e.g. +15555550123');
  if (!cfg.lines) cfg.lines = [];
  if (cfg.lines.some(l => norm(l.number) === k)) throw new Error('line already configured');
  cfg.lines.push({ number: k, label, active: !!active });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return lines({ activeOnly: false });
}
