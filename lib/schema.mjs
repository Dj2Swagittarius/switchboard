// A small JSON-schema check for answers that come from outside the app (the
// Claude connector), where no model-side schema enforcement is guaranteed.
// Covers only what the triage and recap schemas use: type, enum, required,
// properties, additionalProperties: false, items.

const typeOk = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: Number.isInteger,
};

// Returns a list of problems, each naming where it is; empty when valid.
export function validate(schema, value, path = '') {
  const at = path || 'answer';
  if (schema.type && !typeOk[schema.type]?.(value)) return [`${at} must be ${schema.type === 'array' || schema.type === 'object' ? 'an' : 'a'} ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at} must be one of: ${schema.enum.join(', ')}`];
  const errors = [];
  if (schema.type === 'object') {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path ? path + '.' : ''}${k} is missing`);
    for (const [k, v] of Object.entries(value)) {
      const sub = path ? `${path}.${k}` : k;
      if (props[k]) errors.push(...validate(props[k], v, sub));
      else if (schema.additionalProperties === false) errors.push(`${sub} is not allowed`);
    }
  }
  if (schema.type === 'array' && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  return errors;
}
