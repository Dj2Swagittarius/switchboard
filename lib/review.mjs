// Daily recap: one morning summary of the previous day's texts, calls and
// voicemail, written by the chosen AI platform (lib/ai.mjs) and kept on disk
// as reviews/YYYY-MM-DD.json (one file per day reviewed).
//
// Recordings and voicemails that haven't been transcribed yet are transcribed
// first (local Whisper, one at a time), so the recap covers what was said and
// not only that a call happened.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { conversations, thread } from './messaging.mjs';
import * as store from './store.mjs';
import { summarizeThread } from './thread.mjs';
import { listCalls, transcribeRecording } from './calls.mjs';
import { listVoicemails, transcribeVoicemail } from './voicemail.mjs';
import { lookup } from './contacts.mjs';
import * as ai from './ai.mjs';
import * as settings from './settings.mjs';

const DIR = new URL('../reviews/', import.meta.url);
const NL = String.fromCharCode(10);
const MAX_TRANSCRIBE = 25;           // per run; each is ~10-60s of Whisper
// Characters of material a local model starts from when its context window is
// unknown (~2.5k tokens: fits a 4k window with the instructions and answer).
const LOCAL_BUDGET = 9000;
// Tokens kept free for the instructions and the answer; ~3 characters a token
// is a safe rate for mixed English, numbers and transcripts.
const RESERVED = 2200, CHARS_PER_TOKEN = 3;
// On local models, threads with more texts than this in the day are read in
// chunks of CHUNK first (see run()).
const BUSY_THREAD = 12, CHUNK = 30;

// ---- days --------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); };
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
function bounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  return [from, new Date(y, m - 1, d + 1).getTime()];
}

// ---- storage -------------------------------------------------------------------
const file = (day) => new URL(day + '.json', DIR);
export const has = (day) => existsSync(file(day));
export function load(day) {
  try { return JSON.parse(readFileSync(file(day), 'utf8')); } catch { return null; }
}
export function list() {
  try { return readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse(); }
  catch { return []; }
}
function save(r) { mkdirSync(DIR, { recursive: true }); writeFileSync(file(r.day), JSON.stringify(r, null, 2)); }

// ---- the job ---------------------------------------------------------------------
// One run at a time; `state` is what the Insights page polls.
export const state = { running: false, day: null, step: '', error: null };

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    overview: { type: 'string' },
    follow_ups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          who: { type: 'string' },
          number: { type: 'string' },
          what: { type: 'string' },
          why: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          source: { type: 'string', enum: ['text', 'call', 'voicemail'] },
        },
        required: ['who', 'number', 'what', 'why', 'priority', 'source'],
        additionalProperties: false,
      },
    },
    notable: {
      type: 'array',
      items: {
        type: 'object',
        properties: { who: { type: 'string' }, number: { type: 'string' }, what: { type: 'string' } },
        required: ['who', 'number', 'what'],
        additionalProperties: false,
      },
    },
    watch: {
      type: 'array',
      items: {
        type: 'object',
        properties: { who: { type: 'string' }, number: { type: 'string' }, what: { type: 'string' } },
        required: ['who', 'number', 'what'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'overview', 'follow_ups', 'notable', 'watch'],
  additionalProperties: false,
};

const SYSTEM = `You write the morning recap for a field-service dispatcher,
covering everything that came through their phone line yesterday: text
threads, recorded calls, and voicemail. They read it first thing to know what
needs doing today.

Use only what is in the material. Call and voicemail transcripts come from
automatic speech recognition and WILL contain errors in names, places and
equipment terms; do not correct or invent them, and say "unclear" when a
detail is garbled. Photos appear as [image N: ...] descriptions.

- headline: one line, the single most important thing about yesterday.
- overview: 2-4 plain sentences on how the day went and what is still open.
- follow_ups: everything where someone is waiting on us or we committed to
  something: unanswered questions, callback requests, promised quotes or
  visits, missed calls from real people. Most important first. "who" is the
  name if known, otherwise the number. "number" must be copied exactly from
  the material. priority high = money, safety, angry customer, someone
  blocked, or a same-day deadline. Empty array if nothing is open.
- notable: other things worth knowing that need no action (jobs completed,
  schedule changes, new customers). Keep it short.
- watch: conversations with frustration, complaints or conflict. Empty array
  if none.
No emoji. No filler.`;

// Transcripts can be long; keep each within what the platform can take.
const cap = (s, n) => (s.length > n ? s.slice(0, n) + ' […transcript shortened]' : s);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const nameOf = (n, fallback = '') => lookup(n)?.name || fallback || '';

export async function run(session, day = yesterday(), { onDone } = {}) {
  if (state.running) throw new Error('A recap is already being written.');
  Object.assign(state, { running: true, day, step: 'Collecting texts…', error: null });
  const errors = [];
  try {
    const [from, to] = bounds(day);
    const inDay = (t) => t >= from && t < to;
    const perItem = ai.isCloud(ai.provider()) ? 12000 : 2500;

    // Texts: every thread with activity that day, plus a little context before
    // it. Uses the paged conversation list and full threads (as the Messages
    // page does): the triage feed only returns the latest few dozen messages.
    // Photos use the description triage already wrote, when there is one.
    const described = new Map(store.all().map(e => [e.id, e.text]));
    const say = (m) => {
      if (!m.media.length) return m.text.trim();
      const d = described.get(m.id);
      return d || [m.text.trim(), `[${m.media.length} photo${m.media.length === 1 ? '' : 's'} attached]`].filter(Boolean).join(' ');
    };
    const convs = [];
    const active = (await conversations(session)).filter(c => c.lastAt >= from);
    for (const c of active) {
      let msgs;
      try { msgs = await thread(session, { line: c.line, remote: c.remote }); }
      catch (e) { errors.push(`texts with ${c.remote}: ${e.message}`); continue; }
      msgs = msgs.map(m => ({ ...m, forModel: () => say(m) }));
      const today = msgs.filter(m => inDay(m.at));
      if (!today.length) continue;
      const first = msgs.indexOf(today[0]);
      convs.push({ remote: c.remote, name: c.name || nameOf(c.remote), before: msgs.slice(Math.max(0, first - 2), first), today });
    }

    // Calls, transcribing recordings that haven't been yet.
    state.step = 'Collecting calls…';
    const calls = (await listCalls(session, { days: Math.max(2, Math.ceil((Date.now() - from) / 864e5) + 1) }))
      .filter(c => inDay(c.at));
    const transcribe = settings.get('review.transcribe');
    let budget = MAX_TRANSCRIBE, transcribed = 0;
    const pendingRec = calls.filter(c => c.recording && !c.transcript?.text);
    for (const [i, c] of pendingRec.entries()) {
      if (!transcribe || budget <= 0) break;
      state.step = `Transcribing call ${i + 1} of ${pendingRec.length}…`;
      try { c.transcript = await transcribeRecording(session, c.recording); transcribed++; }
      catch (e) { errors.push(`call ${c.number}: ${e.message}`); }
      budget--;
    }

    state.step = 'Collecting voicemail…';
    const vms = (await listVoicemails(session)).filter(v => inDay(v.at));
    const pendingVm = vms.filter(v => !v.text);
    for (const [i, v] of pendingVm.entries()) {
      if (!transcribe || budget <= 0) break;
      state.step = `Transcribing voicemail ${i + 1} of ${pendingVm.length}…`;
      try { Object.assign(v, await transcribeVoicemail(session, v.box_id, v.media_id)); transcribed++; }
      catch (e) { errors.push(`voicemail ${v.from}: ${e.message}`); }
      budget--;
    }

    const msgCount = convs.reduce((n, c) => n + c.today.length, 0);
    const stats = {
      conversations: convs.length,
      texts_in: convs.reduce((n, c) => n + c.today.filter(m => m.inbound).length, 0),
      texts_out: convs.reduce((n, c) => n + c.today.filter(m => !m.inbound).length, 0),
      calls: calls.length,
      calls_in: calls.filter(c => c.direction === 'in').length,
      missed: calls.filter(c => c.direction === 'in' && !c.answered).length,
      recorded: calls.filter(c => c.recording).length,
      voicemails: vms.length,
      transcribed,
    };

    // Busy threads on a local model: read every text in chunks first and keep
    // the chunk summaries, so the recap covers the whole day instead of the
    // last few messages that would fit. Cloud models take the texts directly.
    if (!ai.isCloud(ai.provider())) {
      const busy = convs.filter(c => c.today.length > BUSY_THREAD);
      for (const [n, c] of busy.entries()) {
        c.chunks = [];
        const parts = Math.ceil(c.today.length / CHUNK);
        for (let i = 0; i < c.today.length; i += CHUNK) {
          state.step = `Reading texts with ${c.name || c.remote} (${n + 1} of ${busy.length}, part ${i / CHUNK + 1} of ${parts})…`;
          const slice = c.today.slice(i, i + CHUNK).map(m => ({ ...m, forModel: () => cap(m.forModel(), 400) }));
          try {
            const s = await summarizeThread(slice);
            c.chunks.push({ from: slice[0].at, to: slice.at(-1).at, count: slice.length, ...s });
          } catch (e) { errors.push(`summarizing texts with ${c.remote}: ${e.message}`); c.chunks = null; break; }
        }
      }
    }

    const base = { day, generated_at: new Date().toISOString(), provider: ai.provider(),
                   model: ai.textModel(), stats, errors };
    if (!msgCount && !calls.length && !vms.length) {
      const r = { ...base, empty: true, recap: null };
      save(r); onDone?.(r); return r;
    }

    // The material, oldest first within each part, at a level of detail:
    //   0  full transcripts (capped per item) and a little earlier context
    //   1  per-call summaries instead of transcripts; texts trimmed
    //   2  shorter still; the last 20 texts per thread
    //   3  one line per call and voicemail, last six texts per thread
    // Local models usually run with a small context window, so they start at
    // the most detailed level that fits LOCAL_BUDGET; any platform steps down a
    // level when its answer comes back cut off.
    calls.sort((a, b) => a.at - b.at);
    vms.sort((a, b) => a.at - b.at);
    const material = (level) => {
      const textCap = [4000, 400, 200, 150][level], perThread = [Infinity, Infinity, 20, 6][level];
      const parts = [];
      if (convs.length) {
        parts.push('## TEXT THREADS');
        for (const c of convs) {
          parts.push(`### ${c.name ? c.name + ' ' : ''}${c.remote}`);
          if (level === 0) for (const m of c.before) parts.push(`(earlier) ${m.inbound ? 'THEM' : 'US'}: ${cap(m.forModel(), 400)}`);
          if (c.chunks?.length) {
            // Read in parts beforehand: the summaries, then the last few texts verbatim.
            for (const k of c.chunks) {
              parts.push(`Summary of ${k.count} texts, ${clock(k.from)}-${clock(k.to)}: ${k.summary}` +
                (k.open_items.length ? ' Open: ' + k.open_items.join('; ') + '.' : '') +
                (k.last_ask ? ' Last ask: ' + k.last_ask : ''));
            }
            parts.push(`Waiting on: ${c.chunks.at(-1).waiting_on}. Last messages:`);
            for (const m of c.today.slice(-[6, 6, 4, 2][level])) parts.push(`${clock(m.at)} ${m.inbound ? 'THEM' : 'US'}: ${cap(m.forModel(), textCap)}`);
            continue;
          }
          const shown = c.today.slice(-perThread);
          if (shown.length < c.today.length) parts.push(`(${c.today.length - shown.length} earlier messages that day not shown)`);
          for (const m of shown) parts.push(`${clock(m.at)} ${m.inbound ? 'THEM' : 'US'}: ${cap(m.forModel(), textCap)}`);
        }
      }
      if (calls.length) {
        parts.push('## CALLS');
        for (const c of calls) {
          const who = `${c.name || nameOf(c.number)} ${c.number || '(unknown number)'}`.trim();
          const how = c.direction === 'in' ? (c.answered ? 'incoming, answered' : 'incoming, MISSED') : (c.answered ? 'outgoing, connected' : 'outgoing, no answer');
          parts.push(`### ${clock(c.at)} ${who} (${how}, ${c.seconds}s)`);
          const t = c.transcript, s = t?.summary;
          if (s?.summary) {
            parts.push(`Summary: ${s.summary} Outcome: ${s.outcome}` +
              (level < 3 && s.follow_ups?.length ? ' Follow-ups said: ' + s.follow_ups.join('; ') : ''));
          }
          if (t?.text && (level === 0 || !s?.summary)) parts.push('Transcript: ' + cap(t.text.trim(), [perItem, 500, 200, 120][level]));
          else if (c.recording && !t?.text) parts.push('(recorded, not transcribed)');
        }
      }
      if (vms.length) {
        parts.push('## VOICEMAIL');
        for (const v of vms) {
          parts.push(`### ${clock(v.at)} ${nameOf(v.from, v.name)} ${v.from} (${v.seconds}s)`);
          const s = v.summary;
          if (s?.summary) parts.push(`Summary: ${s.summary} Wants: ${s.caller_wants}. Callback needed: ${s.callback_needed ? 'yes' : 'no'}.`);
          if (v.text && (level === 0 || !s?.summary)) parts.push('Transcript: ' + cap(v.text.trim(), [perItem, 500, 200, 120][level]));
          else if (!v.text) parts.push('(not transcribed)');
        }
      }
      return `Yesterday was ${new Date(from).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.` + NL + NL + parts.join(NL);
    };

    const local = !ai.isCloud(ai.provider());
    let level = 0;
    if (local) {
      const window = await ai.contextTokens(ai.provider(), ai.textModel(), 16384);
      const budget = window ? Math.max(LOCAL_BUDGET, (window - RESERVED) * CHARS_PER_TOKEN) : LOCAL_BUDGET;
      while (level < 3 && material(level).length > budget) level++;
    }
    let recap = null;
    for (;;) {
      state.step = `Writing the recap with ${ai.LABEL[ai.provider()]}…` + (level ? ' (condensed)' : '');
      try {
        recap = await ai.json({
          name: 'recap', schema: SCHEMA, system: SYSTEM, user: material(level),
          maxTokens: local ? 1500 : 4000, ctx: 16384,
        });
        break;
      } catch (e) {
        if (!(e instanceof ai.TooLongError) || level >= 3) {
          if (e instanceof ai.TooLongError) {
            throw new Error(e.message + ' Even the shortest version of yesterday was too long for this model. '
              + (ai.provider() === 'lmstudio' ? 'Load it in LM Studio with a larger context length (8192 or more).' : 'Try a model with a larger context.'));
          }
          throw e;
        }
        level++;
      }
    }
    const r = { ...base, empty: false, recap, detail: level };
    save(r); onDone?.(r);
    return r;
  } catch (e) {
    state.error = e.message;
    throw e;
  } finally {
    state.running = false; state.step = '';
  }
}

// The scheduled run: once a day, after the chosen time, for yesterday.
export function due() {
  if (!settings.get('review.enabled') || state.running) return false;
  const [h, m] = String(settings.get('review.time')).split(':').map(Number);
  const at = new Date(); at.setHours(h, m, 0, 0);
  return Date.now() >= at.getTime() && !has(yesterday());
}
