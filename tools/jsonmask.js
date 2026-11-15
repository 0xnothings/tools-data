// jsonmask.js — redact PII-looking fields in JSON with a policy and an auditable trail.
// Copyright (c) 2026 0xnothings
// @tool jsonmask
// @desc Mask or redact email/phone/card/IP/name/secret fields in JSON with a policy file and audit trail
// @usage node tools/jsonmask.js users.json --policy pii.json --style hash --json
// @tags data,json,privacy,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HELP = `jsonmask — PII / secret redaction for JSON

  node tools/jsonmask.js <file.json|-> [options]

  --policy <file>   JSON policy: {"types":["email","phone"],"fields":["email"],"allow":["id"],
                    "style":"partial","keepDomain":true,"salt":"..."}
  --types <list>    override policy types: email,phone,card,ip,ssn,name,secret,uuid,url
  --fields <list>   override policy field-name list (case-insensitive, matched anywhere)
  --style <s>       mask (default) | partial | hash | redact | token
  --salt <s>        salt for hash style (default "0xnothings")
  --depth <n>       limit masking to this depth
  --array <n>       keep only the first n array elements (0 = all)
  --audit           print the audit trail (default on)
  --out <file>      write the masked document here
  --json            machine-readable output
  -h, --help        this text

  Two independent detectors run: field-name matching (fast, precise) and value
  shape matching (regex: email, E.164/NANP phone, Luhn-valid card, IPv4/v6, SSN,
  UUID, bearer tokens, private-key blocks). Hash style is deterministic per value
  and salt, which keeps joins possible without exposing the plaintext.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'no-meta']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/jsonmask.js users.json');

const raw = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src);
let doc;
try { doc = JSON.parse(raw); } catch (e) { die(`JSON parse failed: ${e.message}`); }

const DEFAULT_POLICY = {
  types: ['email', 'phone', 'card', 'ip', 'ssn', 'secret', 'uuid'],
  fields: ['email', 'mail', 'phone', 'mobile', 'tel', 'telephone', 'ssn', 'social', 'card', 'creditcard', 'card_number', 'pan', 'cvv', 'cvc', 'password', 'passwd', 'pass', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'auth', 'cookie', 'session', 'privatekey', 'private_key', 'iban', 'address', 'street', 'zip', 'postal', 'dob', 'birthdate', 'firstname', 'first_name', 'lastname', 'last_name', 'fullname', 'full_name', 'name', 'ip', 'ip_address', 'lat', 'lng', 'latitude', 'longitude'],
  allow: [],
  style: 'mask',
  keepDomain: true,
  salt: '0xnothings',
};

let policy = { ...DEFAULT_POLICY };
const policyFile = get(o, 'policy', null);
if (policyFile !== null) {
  try {
    const p = JSON.parse(readFileSync(String(policyFile), 'utf8'));
    policy = { ...policy, ...p };
  } catch (e) { die(`cannot read policy ${policyFile}: ${e.message}`); }
}
if (get(o, 'types', null) !== null) policy.types = String(get(o, 'types')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
if (get(o, 'fields', null) !== null) policy.fields = String(get(o, 'fields')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
if (get(o, 'style', null) !== null) policy.style = String(get(o, 'style')).toLowerCase();
if (get(o, 'salt', null) !== null) policy.salt = String(get(o, 'salt'));
const style = String(policy.style).toLowerCase();
if (!['mask', 'partial', 'hash', 'redact', 'token'].includes(style)) die(`unknown --style "${style}"`);

const maxDepth = num(get(o, 'max-depth', num(get(o, 'depth', 0), 0)), 0) || num(get(o, 'depth', 0), 0);
const arrayLimit = num(get(o, 'array', 0), 0);

const LUHN = (digits) => {
  const s = String(digits).replace(/\D/g, '');
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = Number(s[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

const DETECTORS = {
  email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  phone: /^(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}$/,
  card: (v) => LUHN(v),
  ip: /^(?:\d{1,3}\.){3}\d{1,3}$|^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/,
  ssn: /^\d{3}-?\d{2}-?\d{4}$/,
  secret: /^(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}$|^gh[pousr]_[A-Za-z0-9]{20,}$|^xox[baprs]-[A-Za-z0-9-]{10,}$|^AKIA[0-9A-Z]{16}$|^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  url: /^https?:\/\/\S+$/i,
  pitch: /^[\w-]+\.(?:com|net|org|io|dev|co|id)\/\S+$/i,
};

function detectType(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 512) return null;
  for (const t of policy.types) {
    const d = DETECTORS[t];
    if (!d) continue;
    if (typeof d === 'function') { if (d(v)) return t; }
    else if (d.test(v)) return t;
  }
  return null;
}

const fieldSet = new Set(policy.fields.map((f) => f.toLowerCase()));
const allowSet = new Set((policy.allow || []).map((f) => String(f).toLowerCase()));
const isFieldHit = (key) => {
  const k = String(key).toLowerCase().replace(/[\s-]/g, '_');
  if (allowSet.has(k)) return false;
  if (fieldSet.has(k)) return true;
  return [...fieldSet].some((f) => f.length > 3 && k.includes(f));
};

const masked = (value, reason) => {
  const str = String(value);
  if (style === 'redact') return '[REDACTED]';
  if (style === 'token') return `<<${reason}:${str.length}>>`;
  if (style === 'hash') return 'sha256:' + createHash('sha256').update(String(policy.salt) + '|' + str).digest('hex').slice(0, 32);
  if (style === 'partial') {
    const kind = reason === 'field' ? detectType(str) : reason;
    if (kind === 'email' && str.includes('@')) {
      const [u, d] = str.split('@');
      const keepU = u.slice(0, 1);
      const dom = String(policy.keepDomain) === 'false' ? '***' : d;
      return `${keepU}${'*'.repeat(Math.max(1, u.length - 1))}@${dom}`;
    }
    if (/^\d/.test(str) && str.length > 4) return str.slice(0, 2) + '*'.repeat(Math.max(1, str.length - 4)) + str.slice(-2);
    if (str.length > 4) return str.slice(0, 2) + '*'.repeat(str.length - 4) + str.slice(-2);
    return '*'.repeat(str.length);
  }
  return '*'.repeat(Math.max(3, Math.min(str.length, 8)));
};

const audit = [];
const stats = { fields: 0, values: 0 };

function walk(node, path, depth) {
  if (maxDepth && depth > maxDepth) return node;
  if (Array.isArray(node)) {
    const limit = arrayLimit > 0 ? Math.min(node.length, arrayLimit) : node.length;
    return node.slice(0, limit).map((v, i) => walk(v, `${path}[${i}]`, depth + 1));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const childPath = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && isFieldHit(k)) {
        out[k] = masked(v, 'field');
        audit.push({ path: childPath, reason: 'field-name', key: k, type: 'field-rule', before: v.slice(0, 4) + '…', length: v.length, replacement: out[k] });
        stats.fields++;
        continue;
      }
      if (typeof v === 'string') {
        const t = detectType(v);
        if (t) {
          out[k] = masked(v, t);
          audit.push({ path: childPath, reason: 'value-shape', key: k, type: t, before: v.slice(0, 4) + '…', length: v.length, replacement: out[k] });
          stats.values++;
          continue;
        }
      }
      if (typeof v === 'number' && isFieldHit(k)) {
        out[k] = 0;
        audit.push({ path: childPath, reason: 'field-name', key: k, type: 'numeric-field', before: String(v), length: String(v).length, replacement: 0 });
        stats.fields++;
        continue;
      }
      out[k] = walk(v, childPath, depth + 1);
    }
    return out;
  }
  return node;
}

const result = walk(doc, '', 0);
const outFile = get(o, 'out', null);
if (outFile) writeFileSync(String(outFile), JSON.stringify(result, null, 2) + '\n');

const report = {
  input: src, style, policy: { types: policy.types, fieldRules: policy.fields.length, allow: policy.allow, saltApplied: style === 'hash', keepDomain: policy.keepDomain },
  maskedByField: stats.fields, maskedByShape: stats.values, auditEntries: audit.length,
  audit, output: outFile ? String(outFile) : 'stdout',
};

if (flag(o, 'json')) {
  const payload = flag(o, 'no-meta') ? result : { ...report, result };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  console.log(`${src} — masked ${stats.fields} field(s) + ${stats.values} shape-matched value(s) (style: ${style})`);
  console.log(table([
    { field: 'field-name hits', value: stats.fields },
    { field: 'value-shape hits', value: stats.values },
    { field: 'audit entries', value: audit.length },
    { field: 'field rules active', value: policy.fields.length },
    { field: 'value detectors', value: policy.types.join(', ') },
  ], ['field', 'value']));
  if (audit.length) {
    console.log('\nAUDIT TRAIL');
    console.log(table(audit.slice(0, 80).map((a) => ({
      path: a.path, reason: a.reason, type: a.type, length: a.length,
      replacement: String(a.replacement).slice(0, 40),
    })), ['path', 'reason', 'type', 'length', 'replacement']));
    if (audit.length > 80) console.log(`... ${audit.length - 80} more`);
  }
  if (outFile) console.log(`\nwrote masked document -> ${outFile}`);
  else process.stdout.write('\n' + JSON.stringify(result, null, 2) + '\n');
}
