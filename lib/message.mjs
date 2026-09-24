// Normalizes an Ooma message record into a flat shape the rest of the app uses.
// The API nests a duplicate copy under `value`; the real body is `text`.
export function normalize(m) {
  const media = m.media ?? [];
  const kinds = media.map(x => x.media?.mime_type ?? 'unknown');
  return {
    id: m.id,
    at: m.createdTs ?? m.sentTs ?? 0,
    inbound: m.direction === 'IN',
    remote: Array.isArray(m.remoteNumber) ? m.remoteNumber[0] : m.remoteNumber,
    local: m.localNumber,
    state: m.state,
    text: typeof m.text === 'string' ? m.text : '',
    media: kinds,
    descriptions: [],
    // What the model actually reads. Attachments are described by the vision
    // model when enrich() has run, otherwise noted as bare placeholders.
    forModel() {
      const body = this.text.trim();
      if (!media.length) return body;
      const att = this.descriptions.length
        ? this.descriptions.map((d, i) => `[image ${i + 1}: ${d}]`).join(NL)
        : `[${media.length} attachment(s): ${kinds.join(', ')}]`;
      return body ? body + NL + att : att;
    },
  };
}

const NL = String.fromCharCode(10);
export const mask = n => String(n ?? '').replace(/\d(?=\d{4})/g, '•');
