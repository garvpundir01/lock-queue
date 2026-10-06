/* Engine tests. Run: node src/test.mjs */
import {
  splitStatements, normalize, classify, analyze, estimateSeconds, describeDuration, LOCKS,
} from './engine.js';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (extra ? ` — ${extra}` : ''));
};
const eq = (name, a, b) => ok(name, Object.is(a, b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const one = (sql) => classify({ sql, line: 1 });

/* ---- statement splitting -------------------------------------------- */
{
  const s = splitStatements('SELECT 1; SELECT 2;');
  eq('splits on semicolons', s.length, 2);

  const semi = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
  eq('a semicolon inside a string is not a split', semi.length, 2);
  ok('the string survives intact', semi[0].sql.includes("'a;b'"));

  const dollar = splitStatements(
    "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;");
  eq('dollar-quoted bodies are one statement', dollar.length, 2);

  const tagged = splitStatements("DO $mytag$ BEGIN; END; $mytag$; SELECT 1;");
  eq('tagged dollar quotes too', tagged.length, 2);

  const comments = splitStatements('-- a; comment\nSELECT 1;\n/* block; comment */ SELECT 2;');
  eq('semicolons in comments are ignored', comments.length, 2);

  const lines = splitStatements('SELECT 1;\n\n\nSELECT 2;');
  eq('tracks line numbers', lines[1].line, 4);

  eq('blank input yields nothing', splitStatements('   \n  ').length, 0);
  eq('a trailing statement without a semicolon still counts', splitStatements('SELECT 1').length, 1);

  const quoted = splitStatements('ALTER TABLE "my;table" ADD COLUMN a int;');
  eq('quoted identifiers are not split', quoted.length, 1);
}

/* ---- normalize ------------------------------------------------------ */
eq('strips comments', normalize('SELECT 1 -- trailing\n'), 'SELECT 1');
eq('collapses whitespace', normalize('SELECT\n\n  1'), 'SELECT 1');

/* ---- CREATE INDEX --------------------------------------------------- */
{
  const r = one('CREATE INDEX idx_users_email ON users (email)');
  eq('plain index takes SHARE', r.lock, 'SHARE');
  eq('and is high severity', r.severity, 'high');
  ok('offers CONCURRENTLY', r.fix.sql.includes('CONCURRENTLY'));
  ok('fix keeps the original index name', r.fix.sql.includes('idx_users_email'));
  ok('warns it cannot be in a transaction', /transaction/i.test(r.fix.note));

  const c = one('CREATE INDEX CONCURRENTLY idx ON users (email)');
  eq('concurrent index is safe', c.severity, 'safe');
  eq('and takes a weak lock', c.lock, 'SHARE UPDATE EXCLUSIVE');
  eq('and needs its own transaction', c.needsOwnTransaction, true);

  const u = one('CREATE UNIQUE INDEX idx ON users (email)');
  eq('unique index is caught too', u.severity, 'high');
  ok('and the fix keeps UNIQUE', u.fix.sql.includes('UNIQUE'));
}

/* ---- ADD COLUMN ------------------------------------------------------ */
{
  const plain = one('ALTER TABLE users ADD COLUMN nickname text');
  eq('a nullable column is catalog-only', plain.work, 'catalog');
  eq('and low severity', plain.severity, 'low');

  const constDefault = one("ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'new'");
  eq('a constant default does not rewrite', constDefault.work, 'catalog');
  eq('and stays low', constDefault.severity, 'low');

  const volatileDefault = one('ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now()');
  eq('a volatile default rewrites', volatileDefault.work, 'rewrite');
  eq('and is critical', volatileDefault.severity, 'critical');
  ok('fix separates the default from the column', volatileDefault.fix.sql.includes('SET DEFAULT'));
  ok('and backfills in batches', /LIMIT/i.test(volatileDefault.fix.sql));

  const uuid = one('ALTER TABLE users ADD COLUMN id2 uuid DEFAULT gen_random_uuid()');
  eq('gen_random_uuid counts as volatile', uuid.work, 'rewrite');

  const notNullNoDefault = one('ALTER TABLE users ADD COLUMN email text NOT NULL');
  eq('NOT NULL with no default is critical', notNullNoDefault.severity, 'critical');
  ok('and says it will fail', /fail/i.test(notNullNoDefault.title));

  const uniq = one('ALTER TABLE users ADD COLUMN slug text UNIQUE');
  eq('UNIQUE on a new column builds an index', uniq.work, 'build-index');
  ok('fix uses USING INDEX', uniq.fix.sql.includes('USING INDEX'));
}

/* ---- ALTER COLUMN TYPE ----------------------------------------------- */
{
  const r = one('ALTER TABLE orders ALTER COLUMN id TYPE bigint');
  eq('int to bigint rewrites', r.work, 'rewrite');
  eq('and is critical', r.severity, 'critical');
  ok('fix adds a new column', r.fix.sql.includes('ADD COLUMN'));
  ok('and renames at the end', r.fix.sql.includes('RENAME COLUMN'));
  ok('names the column it found', r.fix.sql.includes('id_new'));
}

/* ---- SET NOT NULL ----------------------------------------------------- */
{
  const r = one('ALTER TABLE users ALTER COLUMN email SET NOT NULL');
  eq('scans the table', r.work, 'scan');
  eq('under the strongest lock', r.lock, 'ACCESS EXCLUSIVE');
  ok('fix uses a NOT VALID check', r.fix.sql.includes('NOT VALID'));
  ok('then validates it', r.fix.sql.includes('VALIDATE CONSTRAINT'));
  ok('then sets not null', r.fix.sql.includes('SET NOT NULL'));
  ok('then cleans up the scaffolding', r.fix.sql.includes('DROP CONSTRAINT'));
}

/* ---- constraints ------------------------------------------------------ */
{
  const fk = one('ALTER TABLE orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id)');
  eq('a validated FK scans', fk.work, 'scan');
  eq('and blocks writes on both tables', fk.lock, 'SHARE ROW EXCLUSIVE');
  ok('fix appends NOT VALID', fk.fix.sql.includes('NOT VALID'));
  ok('and validates by constraint name', fk.fix.sql.includes('orders_user_fk'));

  const fkNV = one('ALTER TABLE orders ADD CONSTRAINT f FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID');
  eq('NOT VALID is already safe', fkNV.severity, 'safe');

  const chk = one('ALTER TABLE users ADD CONSTRAINT age_ck CHECK (age > 0)');
  eq('a validated CHECK scans', chk.work, 'scan');
  ok('fix appends NOT VALID', chk.fix.sql.includes('NOT VALID'));

  const uq = one('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)');
  eq('UNIQUE builds an index', uq.work, 'build-index');
  eq('and is critical', uq.severity, 'critical');
  ok('fix builds concurrently first', uq.fix.sql.includes('CREATE UNIQUE INDEX CONCURRENTLY'));

  const adopt = one('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE USING INDEX tmp_idx');
  eq('adopting an existing index is safe', adopt.severity, 'safe');

  const val = one('ALTER TABLE users VALIDATE CONSTRAINT age_ck');
  eq('VALIDATE takes a weak lock', val.lock, 'SHARE UPDATE EXCLUSIVE');
  eq('and is safe', val.severity, 'safe');
}

/* ---- drops and renames ------------------------------------------------ */
{
  const d = one('ALTER TABLE users DROP COLUMN legacy_flag');
  eq('dropping a column is catalog-only', d.work, 'catalog');
  ok('but warns about deploy order', /deploy|running/i.test(d.mechanism));
  ok('and the fix is about sequencing', d.fix.sql.includes('Deploy application code'));

  const r = one('ALTER TABLE users RENAME COLUMN email TO email_address');
  eq('rename is medium', r.severity, 'medium');
  ok('and warns it breaks running code', /running code/i.test(r.title));

  const di = one('DROP INDEX idx_users_email');
  eq('plain DROP INDEX takes the strongest lock', di.lock, 'ACCESS EXCLUSIVE');
  ok('fix is concurrent', di.fix.sql.includes('CONCURRENTLY'));
}

/* ---- heavy maintenance ------------------------------------------------ */
eq('VACUUM FULL is critical', one('VACUUM FULL users').severity, 'critical');
eq('CLUSTER is critical', one('CLUSTER users USING idx').severity, 'critical');
eq('TRUNCATE is critical', one('TRUNCATE users').severity, 'critical');
eq('DROP TABLE is critical', one('DROP TABLE users').severity, 'critical');
eq('REINDEX CONCURRENTLY is safe', one('REINDEX INDEX CONCURRENTLY idx').severity, 'safe');

/* ---- data statements --------------------------------------------------- */
{
  const bare = one('UPDATE users SET active = true');
  eq('an unfiltered UPDATE is high', bare.severity, 'high');
  ok('fix batches it', /LIMIT/i.test(bare.fix.sql));

  const batched = one('UPDATE users SET active = true WHERE id IN (SELECT id FROM users LIMIT 1000)');
  eq('a batched UPDATE is safe', batched.severity, 'safe');

  const filtered = one('DELETE FROM users WHERE created_at < now()');
  eq('a filtered DELETE is low', filtered.severity, 'low');
}

eq('CREATE TABLE is safe', one('CREATE TABLE t (id int)').severity, 'safe');

/* ---- table extraction --------------------------------------------------- */
eq('finds the table in ALTER', one('ALTER TABLE public.users ADD COLUMN a int').table, 'public.users');
eq('finds the table in CREATE INDEX', one('CREATE INDEX i ON orders (id)').table, 'orders');
eq('preserves original casing', one('ALTER TABLE MyTable ADD COLUMN a int').table, 'MyTable');

/* ---- estimates ---------------------------------------------------------- */
eq('no estimate without work', estimateSeconds('catalog', 1e6), null);
eq('no estimate without rows', estimateSeconds('rewrite', 0), null);
ok('a rewrite of 10M rows takes tens of seconds', estimateSeconds('rewrite', 10e6) === 20);
eq('describes a short duration', describeDuration(0.5), 'under a second');
eq('describes seconds', describeDuration(20), 'about 20 seconds');
eq('describes minutes', describeDuration(300), 'about 5 minutes');
eq('describes hours', describeDuration(7200), 'about 2.0 hours');
eq('describes nothing', describeDuration(null), 'instant');

/* ---- script-level findings ----------------------------------------------- */
{
  const r = analyze('ALTER TABLE users ADD COLUMN a int;', { rows: 1e6 });
  ok('warns about the missing lock_timeout', r.script.some((f) => f.id === 'lock:no-timeout'),
    r.script.map((f) => f.id).join(','));
  ok('and the fix sets one', r.script.find((f) => f.id === 'lock:no-timeout').fix.includes('lock_timeout'));
}
{
  const r = analyze("SET lock_timeout = '3s';\nALTER TABLE users ADD COLUMN a int;", { rows: 1e6 });
  ok('no warning once a timeout is set', !r.script.some((f) => f.id === 'lock:no-timeout'));
}
{
  const r = analyze('BEGIN;\nCREATE INDEX CONCURRENTLY idx ON users (email);\nCOMMIT;', { rows: 1e6 });
  ok('catches CONCURRENTLY inside a transaction', r.script.some((f) => f.id === 'txn:concurrent'),
    r.script.map((f) => f.id).join(','));
  eq('which is critical', r.verdict, 'critical');
}
{
  const r = analyze('CREATE INDEX CONCURRENTLY idx ON users (email);', { rows: 1e6 });
  ok('and not outside one', !r.script.some((f) => f.id === 'txn:concurrent'));
}
{
  const sql = `BEGIN;
ALTER TABLE users ADD COLUMN a text;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
COMMIT;`;
  const r = analyze(sql, { rows: 1e6 });
  ok('catches locks accumulating in one transaction', r.script.some((f) => f.id === 'txn:accumulating'),
    r.script.map((f) => f.id).join(','));
}

/* ---- whole-script analysis ------------------------------------------------ */
{
  const sql = `
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN placed_at timestamptz DEFAULT now();
CREATE INDEX idx_orders_placed ON orders (placed_at);
`;
  const r = analyze(sql, { rows: 5e6 });
  eq('counts the statements', r.statements.length, 3);
  eq('verdict is the worst of them', r.verdict, 'critical');
  eq('counts the blocking ones', r.blockingCount, 2);
  eq('reports the strongest lock', r.worstLock, 'ACCESS EXCLUSIVE');
  ok('sums the blocked time', r.blockedSeconds > 0);
  ok('and describes it', typeof r.blockedFor === 'string');
  ok('every statement carries a duration', r.statements.every((s) => typeof s.duration === 'string'));
}
{
  const r = analyze("SET lock_timeout = '3s';\nCREATE INDEX CONCURRENTLY i ON t (a);", { rows: 1e6 });
  eq('an entirely safe script says so', r.verdict, 'safe');
  eq('with nothing blocking', r.blockingCount, 0);
}
{
  const r = analyze('', { rows: 1e6 });
  eq('empty input yields no statements', r.statements.length, 0);
  eq('and a safe verdict', r.verdict, 'safe');
}
{
  const r = analyze('SELECT * FROM users;', { rows: 1e6 });
  eq('an unrecognised statement is reported, not judged', r.statements[0].op, 'OTHER');
  eq('and does not raise the verdict', r.verdict, 'safe');
}

/* ---- lock table ------------------------------------------------------------ */
ok('every lock has a rank and a description',
  Object.values(LOCKS).every((l) => typeof l.rank === 'number' && l.blocks && l.note));
ok('ACCESS EXCLUSIVE outranks everything',
  Object.entries(LOCKS).every(([k, v]) => k === 'ACCESS EXCLUSIVE' || v.rank < LOCKS['ACCESS EXCLUSIVE'].rank));

/* ---- report ---------------------------------------------------------------- */
console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('');
  process.exit(1);
}

const demo = analyze(`BEGIN;
ALTER TABLE orders ADD COLUMN placed_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_orders_placed ON orders (placed_at);
ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;
COMMIT;`, { rows: 12_000_000 });

console.log('  worked example (12M rows):');
console.log(`    verdict: ${demo.verdict}  ·  ${demo.blockingCount} blocking statements  ·  blocked for ${demo.blockedFor}`);
demo.statements.filter((s) => s.severity !== 'info').forEach((s) => {
  console.log(`    [${s.severity.padEnd(8)}] ${s.op.padEnd(28)} ${s.lock || '—'}  ${s.duration}`);
});
demo.script.forEach((f) => console.log(`    [script  ] ${f.title}`));
console.log('');
