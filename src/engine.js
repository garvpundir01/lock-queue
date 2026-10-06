/* Lock Queue — reads a PostgreSQL migration and works out what it will do to a
 * live database.
 *
 * The outage people don't see coming is not a slow migration. It is the queue.
 * ALTER TABLE asks for ACCESS EXCLUSIVE, which has to wait for whatever is
 * already running on that table. While it waits, every query that arrives after
 * it waits too — including plain SELECTs that would otherwise be unaffected. So
 * a 200ms migration sitting behind one 5-minute analytics query blocks the whole
 * table for 5 minutes.
 *
 * Three things matter for every statement, and this engine reports all three:
 *   1. which lock it takes, and therefore what is blocked
 *   2. whether it rewrites the table, scans it, or only touches catalog entries
 *   3. how long it holds that lock, given the row count
 *
 * Pattern-based, not a full SQL parser. It reads the shapes a migration actually
 * takes rather than parsing arbitrary SQL.
 */

/* ------------------------------------------------------------------ locks */

export const LOCKS = {
  'ACCESS EXCLUSIVE': {
    rank: 8,
    blocks: 'everything, including SELECT',
    note: 'Nothing can read or write the table while this is held.',
  },
  'SHARE ROW EXCLUSIVE': {
    rank: 6,
    blocks: 'all writes and other schema changes',
    note: 'Reads continue. INSERT, UPDATE and DELETE wait.',
  },
  'SHARE': {
    rank: 5,
    blocks: 'all writes',
    note: 'Reads continue. Writes wait for the whole build.',
  },
  'SHARE UPDATE EXCLUSIVE': {
    rank: 4,
    blocks: 'other schema changes and VACUUM',
    note: 'Reads and writes both continue normally.',
  },
  'ROW EXCLUSIVE': {
    rank: 3,
    blocks: 'nothing that matters here',
    note: 'The ordinary write lock.',
  },
  'ACCESS SHARE': {
    rank: 1,
    blocks: 'nothing',
    note: 'The ordinary read lock.',
  },
};

/* ------------------------------------------------- statement splitting */

/**
 * Split a script into statements, respecting the three things that make a
 * naive split-on-semicolon wrong: string literals, line and block comments,
 * and dollar-quoted bodies ($$ ... $$ or $tag$ ... $tag$).
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let line = 1;
  let startLine = 1;
  let i = 0;

  const push = () => {
    const text = buf.trim();
    if (text) {
      // The statement starts where its first non-whitespace character is, not
      // where the previous one ended — otherwise blank lines between statements
      // are attributed to the wrong line.
      const leading = buf.match(/^\s*/)[0];
      const skipped = (leading.match(/\n/g) || []).length;
      out.push({ sql: text, line: startLine + skipped });
    }
    buf = '';
    startLine = line;
  };

  while (i < sql.length) {
    const c = sql[i];
    const next2 = sql.slice(i, i + 2);

    if (c === '\n') { line++; buf += c; i++; continue; }

    // line comment
    if (next2 === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // block comment
    if (next2 === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      for (let k = i; k < stop; k++) if (sql[k] === '\n') line++;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // single-quoted string, '' escapes a quote
    if (c === "'") {
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") { k += 2; continue; }
        if (sql[k] === "'") { k++; break; }
        if (sql[k] === '\n') line++;
        k++;
      }
      buf += sql.slice(i, k);
      i = k;
      continue;
    }

    // double-quoted identifier
    if (c === '"') {
      let k = i + 1;
      while (k < sql.length && sql[k] !== '"') { if (sql[k] === '\n') line++; k++; }
      buf += sql.slice(i, k + 1);
      i = k + 1;
      continue;
    }

    // dollar quoting
    if (c === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        for (let k = i; k < stop; k++) if (sql[k] === '\n') line++;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (c === ';') { push(); i++; continue; }

    buf += c;
    i++;
  }
  push();
  return out;
}

/** Strip comments and collapse whitespace, for matching only. */
export function normalize(stmt) {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/* --------------------------------------------------------- classification */

const VOLATILE = /\b(NOW|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|CLOCK_TIMESTAMP|TIMEOFDAY|RANDOM|GEN_RANDOM_UUID|UUID_GENERATE_V[14]|NEXTVAL)\b/;

/** Pull the table name out of the usual shapes. */
function tableOf(norm, original) {
  const patterns = [
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Z0-9_."]+)/,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Z0-9_."]+\s+)?ON\s+(?:ONLY\s+)?([A-Z0-9_."]+)/,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Z0-9_."]+)/,
    /TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([A-Z0-9_."]+)/,
    /(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?([A-Z0-9_."]+)/,
    /VACUUM\s+(?:FULL\s+)?(?:ANALYZE\s+)?([A-Z0-9_."]+)/,
    /CLUSTER\s+(?:VERBOSE\s+)?([A-Z0-9_."]+)/,
    /REINDEX\s+(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?([A-Z0-9_."]+)/,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_."]+)/,
  ];
  for (const re of patterns) {
    const m = norm.match(re);
    if (m) {
      // Recover the original casing where we can.
      const idx = original.toUpperCase().indexOf(m[1]);
      return idx === -1 ? m[1].toLowerCase() : original.slice(idx, idx + m[1].length);
    }
  }
  return null;
}

function columnOf(norm, original, re) {
  const m = norm.match(re);
  if (!m) return null;
  const idx = original.toUpperCase().indexOf(m[1]);
  return idx === -1 ? m[1].toLowerCase() : original.slice(idx, idx + m[1].length);
}

const q = (name) => (name ? name.replace(/"/g, '') : 'table');

/**
 * Classify one statement.
 * Returns { op, table, lock, work, severity, title, mechanism, fix }
 *   work: 'rewrite' | 'scan' | 'build-index' | 'catalog' | 'rows' | 'none'
 */
export function classify(stmt) {
  const original = stmt.sql;
  const norm = normalize(original);
  const table = tableOf(norm, original);
  const t = q(table);

  const base = { table, raw: original, line: stmt.line };

  /* ---- transaction control ---- */
  if (/^(BEGIN|START TRANSACTION)\b/.test(norm)) return { ...base, op: 'BEGIN', lock: null, work: 'none', severity: 'info', title: 'Transaction begins' };
  if (/^(COMMIT|END)\b/.test(norm)) return { ...base, op: 'COMMIT', lock: null, work: 'none', severity: 'info', title: 'Transaction commits' };
  if (/^ROLLBACK\b/.test(norm)) return { ...base, op: 'ROLLBACK', lock: null, work: 'none', severity: 'info', title: 'Rollback' };
  if (/^SET\s+LOCK_TIMEOUT/.test(norm)) return { ...base, op: 'SET lock_timeout', lock: null, work: 'none', severity: 'safe', title: 'Sets a lock timeout', mechanism: 'Caps how long this session will wait for a lock, which is what stops a blocked migration from queueing traffic behind it.' };
  if (/^SET\b/.test(norm)) return { ...base, op: 'SET', lock: null, work: 'none', severity: 'safe', title: 'Session setting' };

  /* ---- CREATE INDEX ---- */
  if (/^CREATE\s+(UNIQUE\s+)?INDEX/.test(norm)) {
    const concurrent = /\bCONCURRENTLY\b/.test(norm);
    if (concurrent) {
      return {
        ...base, op: 'CREATE INDEX CONCURRENTLY', lock: 'SHARE UPDATE EXCLUSIVE', work: 'build-index',
        severity: 'safe',
        title: 'Builds the index without blocking',
        mechanism: 'Two passes over the table while reads and writes continue. Slower in wall-clock terms than a plain build, which is the trade you want.',
        needsOwnTransaction: true,
      };
    }
    return {
      ...base, op: 'CREATE INDEX', lock: 'SHARE', work: 'build-index',
      severity: 'high',
      title: 'Blocks every write until the index is built',
      mechanism: 'A plain CREATE INDEX takes a SHARE lock for the whole build. Reads continue; every INSERT, UPDATE and DELETE on this table waits until it finishes.',
      fix: {
        title: 'Build it concurrently instead',
        sql: original.replace(/CREATE\s+(UNIQUE\s+)?INDEX/i, (m) => m + ' CONCURRENTLY'),
        note: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this statement has to be outside BEGIN/COMMIT. If it fails it leaves an invalid index behind — drop it and retry.',
      },
    };
  }

  /* ---- DROP INDEX ---- */
  if (/^DROP\s+INDEX/.test(norm)) {
    if (/\bCONCURRENTLY\b/.test(norm)) {
      return { ...base, op: 'DROP INDEX CONCURRENTLY', lock: 'SHARE UPDATE EXCLUSIVE', work: 'catalog', severity: 'safe', title: 'Drops the index without blocking', needsOwnTransaction: true };
    }
    return {
      ...base, op: 'DROP INDEX', lock: 'ACCESS EXCLUSIVE', work: 'catalog',
      severity: 'medium',
      title: 'Takes the strongest lock, briefly',
      mechanism: 'The drop itself is fast, but it needs ACCESS EXCLUSIVE to get it. Acquiring that on a busy table is where the queue forms.',
      fix: {
        title: 'Drop it concurrently',
        sql: original.replace(/DROP\s+INDEX/i, 'DROP INDEX CONCURRENTLY'),
        note: 'Cannot run inside a transaction block.',
      },
    };
  }

  /* ---- ALTER TABLE ---- */
  if (/^ALTER\s+TABLE/.test(norm)) {
    /* ADD COLUMN */
    if (/\bADD\s+(COLUMN\s+)?/.test(norm) && !/\bADD\s+CONSTRAINT\b/.test(norm)) {
      const col = columnOf(norm, original, /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_."]+)/);
      const hasDefault = /\bDEFAULT\b/.test(norm);
      const volatileDefault = hasDefault && VOLATILE.test(norm);
      const unique = /\bUNIQUE\b/.test(norm);
      const notNull = /\bNOT\s+NULL\b/.test(norm);

      if (volatileDefault) {
        return {
          ...base, op: 'ADD COLUMN (volatile default)', lock: 'ACCESS EXCLUSIVE', work: 'rewrite',
          severity: 'critical',
          title: 'Rewrites every row in the table',
          mechanism: 'A constant default is stored once in the catalog and costs nothing. A volatile default like now() or gen_random_uuid() has to be evaluated per row, so Postgres rewrites the whole table while holding ACCESS EXCLUSIVE.',
          fix: {
            title: 'Add the column, then the default, then backfill',
            sql: [
              `ALTER TABLE ${t} ADD COLUMN ${q(col)} <type>;`,
              `ALTER TABLE ${t} ALTER COLUMN ${q(col)} SET DEFAULT <volatile expression>;`,
              '',
              '-- Backfill in batches so no single statement holds a long lock:',
              `UPDATE ${t} SET ${q(col)} = <volatile expression>`,
              `WHERE ${q(col)} IS NULL AND id IN (SELECT id FROM ${t} WHERE ${q(col)} IS NULL LIMIT 5000);`,
              '-- repeat until no rows are updated',
            ].join('\n'),
            note: 'New rows get the default immediately. Existing rows fill in over many short transactions instead of one long one.',
          },
        };
      }
      if (unique) {
        return {
          ...base, op: 'ADD COLUMN UNIQUE', lock: 'ACCESS EXCLUSIVE', work: 'build-index',
          severity: 'critical',
          title: 'Builds a unique index while blocking everything',
          mechanism: 'UNIQUE on a new column creates an index, and it is built under the ACCESS EXCLUSIVE lock the ALTER already holds.',
          fix: {
            title: 'Add the column, then build the index concurrently',
            sql: [
              `ALTER TABLE ${t} ADD COLUMN ${q(col)} <type>;`,
              '',
              `CREATE UNIQUE INDEX CONCURRENTLY ${t}_${q(col)}_key ON ${t} (${q(col)});`,
              `ALTER TABLE ${t} ADD CONSTRAINT ${t}_${q(col)}_key UNIQUE USING INDEX ${t}_${q(col)}_key;`,
            ].join('\n'),
            note: 'ADD CONSTRAINT ... USING INDEX adopts the index you already built instead of building a new one.',
          },
        };
      }
      if (notNull && !hasDefault) {
        return {
          ...base, op: 'ADD COLUMN NOT NULL', lock: 'ACCESS EXCLUSIVE', work: 'rewrite',
          severity: 'critical',
          title: 'Fails outright on a table with rows',
          mechanism: 'NOT NULL with no default has nothing to put in existing rows. On a non-empty table this errors; the migration dies partway through.',
          fix: {
            title: 'Give it a default, or add it nullable and tighten later',
            sql: [`ALTER TABLE ${t} ADD COLUMN ${q(col)} <type> NOT NULL DEFAULT <constant>;`].join('\n'),
            note: 'Since Postgres 11 a constant default is a catalog-only change, so this stays fast at any table size.',
          },
        };
      }
      return {
        ...base, op: 'ADD COLUMN', lock: 'ACCESS EXCLUSIVE', work: 'catalog',
        severity: 'low',
        title: 'Catalog-only, but still needs the strongest lock',
        mechanism: hasDefault
          ? 'A constant default is stored once in the catalog, so Postgres 11 and later do not rewrite the table. The work is instant; getting the lock is the only risk.'
          : 'Adding a nullable column with no default touches only the catalog. The work is instant; getting the lock is the only risk.',
      };
    }

    /* ALTER COLUMN ... TYPE */
    if (/\bALTER\s+(COLUMN\s+)?[A-Z0-9_."]+\s+(SET\s+DATA\s+)?TYPE\b/.test(norm)) {
      const col = columnOf(norm, original, /ALTER\s+(?:COLUMN\s+)?([A-Z0-9_."]+)\s+(?:SET\s+DATA\s+)?TYPE/);
      const safeWiden = /TYPE\s+TEXT\b/.test(norm) || /TYPE\s+VARCHAR\s*(\(|$)/.test(norm);
      return {
        ...base, op: 'ALTER COLUMN TYPE', lock: 'ACCESS EXCLUSIVE', work: 'rewrite',
        severity: 'critical',
        title: safeWiden ? 'Usually a rewrite, occasionally free' : 'Rewrites every row in the table',
        mechanism: safeWiden
          ? 'Widening varchar(n) to a larger varchar or to text is catalog-only. Any other type change rewrites the table under ACCESS EXCLUSIVE, and indexes on the column are rebuilt too.'
          : 'Changing a column type rewrites every row and rebuilds every index on it, all while holding ACCESS EXCLUSIVE. int to bigint is the usual trap: it looks like a widening but it is a full rewrite.',
        fix: {
          title: 'Move to a new column in steps',
          sql: [
            `ALTER TABLE ${t} ADD COLUMN ${q(col)}_new <newtype>;`,
            '',
            '-- Backfill in batches, then keep the two in step:',
            `UPDATE ${t} SET ${q(col)}_new = ${q(col)}::<newtype> WHERE ${q(col)}_new IS NULL;`,
            '',
            '-- Once backfilled and the application writes both, swap the names:',
            `ALTER TABLE ${t} RENAME COLUMN ${q(col)} TO ${q(col)}_old;`,
            `ALTER TABLE ${t} RENAME COLUMN ${q(col)}_new TO ${q(col)};`,
          ].join('\n'),
          note: 'Long, but every step is short. The alternative holds the table for the length of a full rewrite.',
        },
      };
    }

    /* SET NOT NULL */
    if (/\bALTER\s+(COLUMN\s+)?[A-Z0-9_."]+\s+SET\s+NOT\s+NULL\b/.test(norm)) {
      const col = columnOf(norm, original, /ALTER\s+(?:COLUMN\s+)?([A-Z0-9_."]+)\s+SET\s+NOT\s+NULL/);
      const cname = `${t}_${q(col)}_not_null`;
      return {
        ...base, op: 'SET NOT NULL', lock: 'ACCESS EXCLUSIVE', work: 'scan',
        severity: 'high',
        title: 'Scans the whole table holding the strongest lock',
        mechanism: 'Postgres has to prove no row is null, and it does that with a sequential scan while holding ACCESS EXCLUSIVE.',
        fix: {
          title: 'Prove it with a NOT VALID check first',
          sql: [
            `ALTER TABLE ${t} ADD CONSTRAINT ${cname} CHECK (${q(col)} IS NOT NULL) NOT VALID;`,
            `ALTER TABLE ${t} VALIDATE CONSTRAINT ${cname};`,
            `ALTER TABLE ${t} ALTER COLUMN ${q(col)} SET NOT NULL;`,
            `ALTER TABLE ${t} DROP CONSTRAINT ${cname};`,
          ].join('\n'),
          note: 'VALIDATE scans under SHARE UPDATE EXCLUSIVE, so reads and writes continue. Postgres 12 and later then accept SET NOT NULL instantly, because the validated constraint is already proof.',
        },
      };
    }

    /* ADD CONSTRAINT */
    if (/\bADD\s+CONSTRAINT\b/.test(norm) || /\bADD\s+(FOREIGN\s+KEY|CHECK|UNIQUE|PRIMARY\s+KEY)\b/.test(norm)) {
      const notValid = /\bNOT\s+VALID\b/.test(norm);
      const cname = columnOf(norm, original, /ADD\s+CONSTRAINT\s+([A-Z0-9_."]+)/) || 'constraint_name';

      if (/\bFOREIGN\s+KEY\b/.test(norm)) {
        if (notValid) {
          return { ...base, op: 'ADD FOREIGN KEY NOT VALID', lock: 'SHARE ROW EXCLUSIVE', work: 'catalog', severity: 'safe', title: 'Added without validating', mechanism: 'New and changed rows are checked from now on; existing rows are not scanned. Validate separately.' };
        }
        return {
          ...base, op: 'ADD FOREIGN KEY', lock: 'SHARE ROW EXCLUSIVE', work: 'scan',
          severity: 'high',
          title: 'Blocks writes on both tables while it scans',
          mechanism: 'Adding a validated foreign key scans this table and takes a lock on the referenced table too. Writes to either one wait.',
          fix: {
            title: 'Add it NOT VALID, then validate',
            sql: [
              `${original.trim().replace(/;?\s*$/, '')} NOT VALID;`,
              '',
              `ALTER TABLE ${t} VALIDATE CONSTRAINT ${q(cname)};`,
            ].join('\n'),
            note: 'The first statement is instant. VALIDATE takes only SHARE UPDATE EXCLUSIVE, so writes continue while it scans.',
          },
        };
      }
      if (/\bCHECK\b/.test(norm)) {
        if (notValid) {
          return { ...base, op: 'ADD CHECK NOT VALID', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'safe', title: 'Added without scanning', mechanism: 'Enforced for new rows only until validated.' };
        }
        return {
          ...base, op: 'ADD CHECK', lock: 'ACCESS EXCLUSIVE', work: 'scan',
          severity: 'high',
          title: 'Scans the table under the strongest lock',
          mechanism: 'A validated CHECK constraint must be proven against every existing row before the ALTER returns.',
          fix: {
            title: 'Add it NOT VALID, then validate',
            sql: [
              `${original.trim().replace(/;?\s*$/, '')} NOT VALID;`,
              '',
              `ALTER TABLE ${t} VALIDATE CONSTRAINT ${q(cname)};`,
            ].join('\n'),
          },
        };
      }
      if (/\bUSING\s+INDEX\b/.test(norm)) {
        return { ...base, op: 'ADD CONSTRAINT USING INDEX', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'safe', title: 'Adopts an index you already built', mechanism: 'No index build happens here, so the lock is held only for a catalog update.' };
      }
      if (/\b(UNIQUE|PRIMARY\s+KEY)\b/.test(norm)) {
        const col = columnOf(norm, original, /(?:UNIQUE|PRIMARY\s+KEY)\s*\(\s*([A-Z0-9_."]+)/) || 'col';
        return {
          ...base, op: 'ADD UNIQUE / PRIMARY KEY', lock: 'ACCESS EXCLUSIVE', work: 'build-index',
          severity: 'critical',
          title: 'Builds an index while blocking everything',
          mechanism: 'A UNIQUE or PRIMARY KEY constraint needs a unique index, and it is built while ACCESS EXCLUSIVE is held.',
          fix: {
            title: 'Build the index concurrently, then adopt it',
            sql: [
              `CREATE UNIQUE INDEX CONCURRENTLY ${t}_${q(col)}_key ON ${t} (${q(col)});`,
              '',
              `ALTER TABLE ${t} ADD CONSTRAINT ${q(cname)} UNIQUE USING INDEX ${t}_${q(col)}_key;`,
            ].join('\n'),
            note: 'The concurrent build does the slow part without blocking; adopting it is a catalog update.',
          },
        };
      }
      return { ...base, op: 'ADD CONSTRAINT', lock: 'ACCESS EXCLUSIVE', work: 'scan', severity: 'medium', title: 'Constraint added under the strongest lock' };
    }

    if (/\bVALIDATE\s+CONSTRAINT\b/.test(norm)) {
      return { ...base, op: 'VALIDATE CONSTRAINT', lock: 'SHARE UPDATE EXCLUSIVE', work: 'scan', severity: 'safe', title: 'Scans without blocking reads or writes', mechanism: 'This is the half of the two-step that does the work, and it deliberately takes a weak lock.' };
    }

    if (/\bDROP\s+(COLUMN|CONSTRAINT)\b/.test(norm)) {
      const what = /\bDROP\s+COLUMN\b/.test(norm) ? 'column' : 'constraint';
      return {
        ...base, op: `DROP ${what.toUpperCase()}`, lock: 'ACCESS EXCLUSIVE', work: 'catalog',
        severity: 'medium',
        title: what === 'column' ? 'Instant, and irreversible for any code still reading it' : 'Instant catalog change',
        mechanism: what === 'column'
          ? 'Dropping a column only marks it dead in the catalog, so it is fast. The risk is deployment order: any running copy of the application that still selects this column starts erroring the moment this commits.'
          : 'Catalog-only. The lock is held briefly.',
        fix: what === 'column' ? {
          title: 'Ship the code that stops using it first',
          sql: [
            '-- 1. Deploy application code that no longer references the column.',
            '-- 2. Wait for every old process to drain.',
            `-- 3. Then: ${original.trim()}`,
          ].join('\n'),
          note: 'Never in the same release as the code change. A column you dropped cannot be un-dropped with its data.',
        } : undefined,
      };
    }

    if (/\bRENAME\b/.test(norm)) {
      return {
        ...base, op: 'RENAME', lock: 'ACCESS EXCLUSIVE', work: 'catalog',
        severity: 'medium',
        title: 'Instant, and breaks running code the moment it commits',
        mechanism: 'A rename is a catalog update, so it is fast. But every running process still using the old name starts failing immediately, and there is no window where both names work.',
        fix: {
          title: 'Add the new name alongside, then retire the old one',
          sql: [
            '-- Renames cannot be done safely in one step while code is running.',
            '-- Add a new column, write to both, migrate readers, then drop the old one.',
          ].join('\n'),
        },
      };
    }

    if (/\bSET\s+DEFAULT\b|\bDROP\s+DEFAULT\b|\bDROP\s+NOT\s+NULL\b/.test(norm)) {
      return { ...base, op: 'SET/DROP DEFAULT or DROP NOT NULL', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'low', title: 'Catalog-only, but still takes the strongest lock', mechanism: 'The change itself is instant. Acquiring ACCESS EXCLUSIVE on a busy table is the only exposure.' };
    }

    return { ...base, op: 'ALTER TABLE', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'medium', title: 'Takes the strongest lock' };
  }

  /* ---- heavy maintenance ---- */
  if (/^VACUUM\s+FULL/.test(norm)) {
    return {
      ...base, op: 'VACUUM FULL', lock: 'ACCESS EXCLUSIVE', work: 'rewrite', severity: 'critical',
      title: 'Rewrites the table and blocks everything for the duration',
      mechanism: 'VACUUM FULL writes a whole new copy of the table and needs twice the disk space. Nothing can read or write it meanwhile.',
      fix: { title: 'Use a concurrent repack instead', sql: '-- pg_repack reclaims space without an exclusive lock for the whole rewrite.', note: 'Plain VACUUM (no FULL) does not block and is usually what was wanted.' },
    };
  }
  if (/^CLUSTER\b/.test(norm)) {
    return { ...base, op: 'CLUSTER', lock: 'ACCESS EXCLUSIVE', work: 'rewrite', severity: 'critical', title: 'Rewrites the table and blocks everything', mechanism: 'CLUSTER physically reorders the table under ACCESS EXCLUSIVE.' };
  }
  if (/^REINDEX/.test(norm)) {
    const concurrent = /\bCONCURRENTLY\b/.test(norm);
    return concurrent
      ? { ...base, op: 'REINDEX CONCURRENTLY', lock: 'SHARE UPDATE EXCLUSIVE', work: 'build-index', severity: 'safe', title: 'Rebuilds without blocking' }
      : { ...base, op: 'REINDEX', lock: 'ACCESS EXCLUSIVE', work: 'build-index', severity: 'critical', title: 'Blocks everything while the index rebuilds', fix: { title: 'Rebuild concurrently', sql: original.replace(/REINDEX\s+(TABLE|INDEX)/i, 'REINDEX $1 CONCURRENTLY') } };
  }
  if (/^TRUNCATE/.test(norm)) {
    return { ...base, op: 'TRUNCATE', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'critical', title: 'Deletes every row, and cannot be undone', mechanism: 'Fast, exclusive, and irreversible outside a transaction you are prepared to roll back.' };
  }
  if (/^DROP\s+TABLE/.test(norm)) {
    return { ...base, op: 'DROP TABLE', lock: 'ACCESS EXCLUSIVE', work: 'catalog', severity: 'critical', title: 'Removes the table and its data', mechanism: 'Irreversible. Any running code touching it fails immediately.' };
  }

  /* ---- data statements ---- */
  if (/^(UPDATE|DELETE)\b/.test(norm)) {
    const hasWhere = /\bWHERE\b/.test(norm);
    const limited = /\bLIMIT\b|\bIN\s*\(\s*SELECT\b/.test(norm);
    if (!hasWhere) {
      return {
        ...base, op: norm.startsWith('UPDATE') ? 'UPDATE (no WHERE)' : 'DELETE (no WHERE)',
        lock: 'ROW EXCLUSIVE', work: 'rows', severity: 'high',
        title: 'Touches every row in one transaction',
        mechanism: 'Row locks are held until commit, so a single statement over the whole table blocks any writer touching those rows for its full duration, and leaves dead tuples behind.',
        fix: {
          title: 'Work in batches',
          sql: [
            `-- Repeat until no rows are affected:`,
            `${norm.startsWith('UPDATE') ? 'UPDATE' : 'DELETE FROM'} ${t}`,
            `WHERE id IN (SELECT id FROM ${t} WHERE <condition> LIMIT 5000);`,
          ].join('\n'),
          note: 'Each batch commits on its own, so locks are short and autovacuum can keep up.',
        },
      };
    }
    return { ...base, op: norm.startsWith('UPDATE') ? 'UPDATE' : 'DELETE', lock: 'ROW EXCLUSIVE', work: 'rows', severity: limited ? 'safe' : 'low', title: limited ? 'Batched write' : 'Filtered write', mechanism: 'Holds row locks until commit.' };
  }

  if (/^CREATE\s+TABLE/.test(norm)) {
    return { ...base, op: 'CREATE TABLE', lock: null, work: 'none', severity: 'safe', title: 'Creates a new table', mechanism: 'Nothing is reading it yet, so there is nothing to block.' };
  }

  return { ...base, op: 'OTHER', lock: null, work: 'none', severity: 'info', title: 'Not recognised', mechanism: 'Lock Queue did not recognise this statement, so it is reported but not judged.' };
}

/* ------------------------------------------------------------- estimates */

/* Rough throughput on commodity hardware. These are order-of-magnitude figures
 * for turning a row count into "instant / seconds / minutes", not predictions —
 * row width, disk, and cache all move them substantially. */
const ROWS_PER_SEC = {
  rewrite: 500_000,
  scan: 2_000_000,
  'build-index': 1_000_000,
  rows: 200_000,
};

export function estimateSeconds(work, rows) {
  const rate = ROWS_PER_SEC[work];
  if (!rate || !Number.isFinite(rows) || rows <= 0) return null;
  return rows / rate;
}

export function describeDuration(seconds) {
  if (seconds === null) return 'instant';
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} second${Math.round(seconds) === 1 ? '' : 's'}`;
  const mins = seconds / 60;
  if (mins < 60) return `about ${Math.round(mins)} minute${Math.round(mins) === 1 ? '' : 's'}`;
  return `about ${(mins / 60).toFixed(1)} hours`;
}

/* --------------------------------------------------------------- analyse */

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, safe: 0, info: 0 };

/**
 * @param {string} sql
 * @param {object} opts { rows, concurrentLoad }
 */
export function analyze(sql, opts = {}) {
  const rows = Number.isFinite(opts.rows) ? opts.rows : 1_000_000;
  const statements = splitStatements(sql).map((s) => {
    const c = classify(s);
    const seconds = estimateSeconds(c.work, rows);
    return {
      ...c,
      seconds,
      duration: describeDuration(seconds),
      holdsLock: c.lock ? LOCKS[c.lock] : null,
    };
  });

  const script = [];

  /* Is a concurrent build trapped inside a transaction? */
  let depth = 0;
  for (const s of statements) {
    if (s.op === 'BEGIN') depth++;
    else if (s.op === 'COMMIT' || s.op === 'ROLLBACK') depth = Math.max(0, depth - 1);
    else if (s.needsOwnTransaction && depth > 0) {
      script.push({
        id: 'txn:concurrent',
        severity: 'critical',
        title: `${s.op} cannot run inside a transaction`,
        detail: `Line ${s.line} uses CONCURRENTLY inside an explicit BEGIN block. Postgres rejects this outright, so the migration fails at that statement.`,
        fix: 'Move it outside BEGIN/COMMIT, or run it as its own migration step.',
      });
    }
  }

  /* No lock timeout set before taking a strong lock. This is the cascade. */
  const takesStrongLock = statements.some((s) => s.lock && LOCKS[s.lock].rank >= 5);
  const setsTimeout = statements.some((s) => s.op === 'SET lock_timeout');
  if (takesStrongLock && !setsTimeout) {
    script.push({
      id: 'lock:no-timeout',
      severity: 'high',
      title: 'No lock_timeout, so a blocked migration takes the table down with it',
      detail: 'This is the failure people do not see coming. Your ALTER waits behind whatever long query is already running, and every query arriving after it queues behind the ALTER — including plain SELECTs. A migration that would have taken 200ms blocks the table for as long as that one slow query runs.',
      fix: "SET lock_timeout = '3s';\nSET statement_timeout = '30s';\n\n-- With these set, the migration gives up instead of queueing traffic behind it.\n-- Retry it rather than letting it wait.",
    });
  }

  /* Several strong locks inside one transaction are all held until COMMIT. */
  let inTxn = false;
  let strongInTxn = [];
  for (const s of statements) {
    if (s.op === 'BEGIN') { inTxn = true; strongInTxn = []; continue; }
    if (s.op === 'COMMIT' || s.op === 'ROLLBACK') {
      if (inTxn && strongInTxn.length > 1) {
        script.push({
          id: 'txn:accumulating',
          severity: 'high',
          title: `${strongInTxn.length} strong locks held together until COMMIT`,
          detail: `A lock taken inside a transaction is not released when the statement finishes — it is held until commit. These accumulate: ${strongInTxn.join(', ')}. The table is blocked for the combined duration, not the longest one.`,
          fix: 'Split these into separate migrations, each committing on its own.',
        });
      }
      inTxn = false;
      strongInTxn = [];
      continue;
    }
    if (inTxn && s.lock && LOCKS[s.lock].rank >= 5) strongInTxn.push(s.op);
  }

  const worst = statements.reduce(
    (acc, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[acc] ? s.severity : acc),
    'safe'
  );
  const scriptWorst = script.reduce(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    'safe'
  );
  const overall = SEVERITY_RANK[scriptWorst] > SEVERITY_RANK[worst] ? scriptWorst : worst;

  const blocking = statements.filter((s) => s.lock && LOCKS[s.lock].rank >= 5);
  const blockedSeconds = blocking.reduce((sum, s) => sum + (s.seconds || 0), 0);

  return {
    rows,
    statements,
    script,
    verdict: overall,
    blockingCount: blocking.length,
    blockedSeconds,
    blockedFor: describeDuration(blockedSeconds || null),
    worstLock: blocking.reduce(
      (acc, s) => (!acc || LOCKS[s.lock].rank > LOCKS[acc].rank ? s.lock : acc),
      null
    ),
  };
}
