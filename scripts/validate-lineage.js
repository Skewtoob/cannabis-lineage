#!/usr/bin/env node
// Validates the strain lineage data embedded in index.html.
//
// Errors (exit 1): duplicate ids within a list, missing id/label, parents that
// don't resolve to any strain, self-parenting, and ancestry cycles.
// Warnings (reported, exit 0 unless --strict): a parent dated later than its
// child, and a strain whose parents differ between the canvas (N) and the
// Vault (NX) copies.
//
// Usage: node scripts/validate-lineage.js [path/to/index.html] [--strict] [--json]

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const file = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// Pull out a top-level `const NAME=[ ... ];` or `const NAME={ ... };` block.
function extract(name, open, close) {
  const start = lines.findIndex(l => l.startsWith(`const ${name}=${open}`));
  if (start < 0) throw new Error(`Could not find "const ${name}=${open}" in ${file}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === `${close};`);
  if (end < 0) throw new Error(`Could not find the end of ${name} in ${file}`);
  const body = lines.slice(start, end + 1).join('\n').replace(`const ${name}=`, `${name}=`);
  const ctx = {};
  vm.runInNewContext(body, ctx, { timeout: 5000 });
  return { value: ctx[name], line: start + 1 };
}

const N = extract('N', '[', ']');
const NX = extract('NX', '[', ']');
const ALIAS = extract('PARENT_ALIAS', '{', '}').value;

// Line number for each strain id, for readable messages.
const idLine = {};
lines.forEach((l, i) => {
  const m = l.match(/^\s*\{\s*id:\s*['"]([^'"]+)['"]/);
  if (m && !(m[1] in idLine)) idLine[m[1]] = i + 1;
});
const where = id => (idLine[id] ? `index.html:${idLine[id]}` : 'index.html');

const errors = [];
const warnings = [];
const err = (kind, msg, id) => errors.push({ kind, msg, at: where(id) });
const warn = (kind, msg, id) => warnings.push({ kind, msg, at: where(id) });

// Mirror the app: NX parent ids pass through PARENT_ALIAS.
NX.value.forEach(s => { if (s.parents) s.parents = s.parents.map(p => ALIAS[p] || p); });

for (const [name, list] of [['N', N.value], ['NX', NX.value]]) {
  const seen = new Set();
  for (const s of list) {
    if (!s.id || !s.label) err('missing-field', `${name} entry missing id or label: ${JSON.stringify(s).slice(0, 80)}`, s.id);
    if (seen.has(s.id)) err('duplicate-id', `"${s.id}" appears more than once in ${name}`, s.id);
    seen.add(s.id);
  }
}

// Combined lookup; the canvas (N) copy wins where both lists define a strain.
const byId = new Map();
for (const s of NX.value) byId.set(s.id, s);
for (const s of N.value) byId.set(s.id, s);
const all = [...N.value, ...NX.value];

for (const s of all) {
  for (const p of s.parents || []) {
    if (p === s.id) err('self-parent', `"${s.id}" lists itself as a parent`, s.id);
    else if (!byId.has(p)) err('missing-parent', `"${s.id}" has unknown parent "${p}"`, s.id);
  }
}

// Cycle detection over each list on its own and over the combined graph.
function findCycles(lookup) {
  const state = {};
  const found = new Set();
  const visit = (id, stack) => {
    if (state[id] === 2) return;
    if (state[id] === 1) {
      const cyc = stack.slice(stack.indexOf(id));
      // Normalise rotation so each cycle is reported once.
      const k = cyc.indexOf([...cyc].sort()[0]);
      found.add([...cyc.slice(k), ...cyc.slice(0, k)].join(' → '));
      return;
    }
    state[id] = 1;
    for (const p of lookup.get(id)?.parents || []) if (lookup.has(p)) visit(p, [...stack, id]);
    state[id] = 2;
  };
  for (const id of lookup.keys()) visit(id, []);
  return found;
}
const cycles = new Set([
  ...findCycles(new Map(N.value.map(s => [s.id, s]))),
  ...findCycles(new Map(NX.value.map(s => [s.id, s]))),
  ...findCycles(byId),
]);
for (const c of cycles) {
  const first = c.split(' → ')[0];
  err('cycle', `ancestry cycle: ${c} → ${first}`, first);
}

// Date sanity: a parent shouldn't be newer than its child.
const seenPairs = new Set();
for (const s of all) {
  for (const p of s.parents || []) {
    const q = byId.get(p);
    const key = `${s.id}<${p}`;
    if (!q || seenPairs.has(key)) continue;
    seenPairs.add(key);
    if (s.year && q.year && q.year > s.year) {
      warn('parent-newer', `"${s.id}" (${s.year}) has parent "${p}" (${q.year})`, s.id);
    }
  }
}

// Same strain, different parents in the two lists.
const nxById = new Map(NX.value.map(s => [s.id, s]));
for (const s of N.value) {
  const x = nxById.get(s.id);
  if (!x) continue;
  const a = [...(s.parents || [])].sort().join(',');
  const b = [...(x.parents || [])].sort().join(',');
  if (a !== b) warn('n-nx-mismatch', `"${s.id}" parents differ: canvas [${a}] vs vault [${b}]`, s.id);
}

const failed = errors.length > 0 || (strict && warnings.length > 0);

if (asJson) {
  console.log(JSON.stringify({ counts: { N: N.value.length, NX: NX.value.length }, errors, warnings }, null, 2));
} else {
  const gh = process.env.GITHUB_ACTIONS === 'true';
  const print = (level, e) => console.log(gh
    ? `::${level} file=index.html,line=${(e.at.split(':')[1]) || 1}::${e.msg}`
    : `${level.toUpperCase().padEnd(7)} ${e.at.padEnd(17)} ${e.msg}`);
  console.log(`Checked ${N.value.length} canvas + ${NX.value.length} vault strains.`);
  errors.forEach(e => print('error', e));
  warnings.forEach(w => print('warning', w));
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
}
process.exit(failed ? 1 : 0);
