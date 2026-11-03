// Planner sessions. At the start of each planner session the relay lists the
// saved roles (which agent takes each tier, with which model and effort) for
// the planner to show the user; the user keeps or changes them, and only then
// may that planner dispatch. A confirmed session keeps a snapshot of its
// routes, so later edits of the configuration do not change it.
//
// Records live in <root>/.agenthub/sessions/<id>.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { TIERS } from './config.mjs';
import { writeJsonAtomic } from './store.mjs';

const SESSION_ID = /^s\d{8}-\d{6}-[0-9a-f]{6}$/;

function fail(code, message, details) {
  return Object.assign(new Error(message), { code }, details === undefined ? {} : { details });
}

/** A sortable, path-safe session id such as s20261103-153012-a1b2c3. */
export function newSessionId(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `s${day}-${time}-${crypto.randomBytes(3).toString('hex')}`;
}

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** The session records of a repository. */
export function createSessionStore(root) {
  const dir = path.join(root, '.agenthub', 'sessions');
  const fileOf = id => path.join(dir, `${id}.json`);

  function read(id) {
    if (!isSessionId(id)) throw fail('unknown-session', `"${id}" is not a session id`);
    try {
      return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw fail('unknown-session', `There is no session ${id} in this repository`);
      throw fail('session-unreadable', `Cannot read session ${id}: ${err.message}`);
    }
  }

  function write(record) {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(fileOf(record.id), record);
    return record;
  }

  function list() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isSessionId(id)) continue;
      try {
        records.push(read(id));
      } catch {
        // an unreadable record is skipped, not fatal
      }
    }
    return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  return {
    dir,
    read,
    create: record => write(record),
    update(id, mutate) {
      const record = read(id);
      mutate(record);
      return write(record);
    },
    list,
    /** The most recently confirmed session, or null. */
    lastConfirmed() {
      const confirmed = list().filter(record => record.status === 'confirmed');
      confirmed.sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt)));
      return confirmed.at(-1) ?? null;
    },
  };
}

/** A route as plain data: `{ executor, model?, effort? }`. */
export function plainRoute(route) {
  const value = typeof route === 'string' ? { executor: route } : route;
  return {
    executor: value.executor,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
  };
}

/** A route as written on the command line: executor[:model][@effort]. */
export function routeText(route) {
  return `${route.executor}${route.model ? `:${route.model}` : ''}${route.effort ? `@${route.effort}` : ''}`;
}

/**
 * What each tier will run with, for the planner to show the user: the
 * executor, the model and effort and where each comes from (the tier, the
 * executor setting, or the agent's own settings), and the catalog check.
 *
 * @param {object} input
 * @param {object} input.routes tier -> route
 * @param {object} input.config the loaded configuration
 * @param {object} input.catalogs agent -> catalog entry (models.mjs)
 * @param {Function} input.check (route, catalog) => check, see models.checkRoute
 */
export function describeTiers({ routes, config, catalogs, check }) {
  return Object.fromEntries(TIERS.map(tier => {
    const route = plainRoute(routes[tier]);
    const executorConfig = config.executors[route.executor] ?? {};
    const catalog = catalogs[route.executor];
    const model = route.model ?? executorConfig.model;
    const effort = route.effort ?? executorConfig.effort;
    const own = catalog?.default;
    const entry = {
      executor: route.executor,
      route: routeText(route),
      model: model ?? own?.model ?? null,
      modelFrom: route.model ? 'tier' : executorConfig.model ? `executors.${route.executor}.model` : own?.model ? `${route.executor}'s own settings${own.modelFrom ? ` (${own.modelFrom})` : ''}` : `${route.executor}'s built-in default`,
      effort: effort ?? own?.effort ?? null,
      effortFrom: route.effort ? 'tier' : executorConfig.effort ? `executors.${route.executor}.effort` : own?.effort ? `${route.executor}'s own settings${own.effortFrom ? ` (${own.effortFrom})` : ''}` : `${route.executor}'s built-in default`,
    };
    if (catalog?.reserved) return [tier, { ...entry, check: { status: 'unsupported', code: 'reserved-executor', reason: catalog.reason } }];
    return [tier, { ...entry, check: check({ executor: route.executor, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }, catalog) }];
  }));
}
