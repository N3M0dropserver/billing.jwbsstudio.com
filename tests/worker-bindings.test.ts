/**
 * The two Workers have to agree with each other.
 *
 * The app binds its Durable Objects by `script_name` out of a second Worker,
 * because the Astro Cloudflare adapter generates this app's entry and there is
 * no supported way to add a Durable Object export to it. That split is fine
 * until the two configurations drift, and then it fails at deploy with
 *
 *     Cannot create binding for class 'ResearchAgent'
 *     that is not exported by script 'jwbs-growth-agent'
 *
 * which is a slow and expensive way to find out. Every rule below is a thing
 * that has to be true for a deploy to work, checked where it is cheap.
 *
 * What this cannot check is whether the *deployed* agent Worker is current —
 * only that the repository is self-consistent. Deploy order is the other half,
 * and it lives in `package.json`: `deploy` runs `deploy:agent` first.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Read a JSONC file.
 *
 * Both configs are heavily commented, and one of the comments contains a URL —
 * so stripping `//` without tracking strings eats half the file.
 */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') { inString = true; out += char; continue; }

    if (char === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (char === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }

    out += char;
  }

  // Trailing commas are legal in jsonc and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

interface DoBinding {
  name: string;
  class_name: string;
  script_name?: string;
}

const app = readJsonc('wrangler.jsonc');
const agent = readJsonc('workers/agent/wrangler.jsonc');
const agentSource = readFileSync('workers/agent/src/index.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

const bindingsOf = (config: Record<string, unknown>): DoBinding[] =>
  ((config.durable_objects as { bindings?: DoBinding[] } | undefined)?.bindings ?? []);

/** Every class the agent Worker actually exports. */
const exported = new Set(
  [...agentSource.matchAll(/^export class (\w+) extends Agent\b/gm)].map((m) => m[1]!),
);

/** Every class registered in one of the agent Worker's migrations. */
const migrated = new Set(
  ((agent.migrations as Array<{ new_sqlite_classes?: string[]; new_classes?: string[] }>) ?? [])
    .flatMap((entry) => [...(entry.new_sqlite_classes ?? []), ...(entry.new_classes ?? [])]),
);

describe('the app binding the agent Worker', () => {
  it('binds at least the two agents', () => {
    const names = bindingsOf(app).map((b) => b.name);
    expect(names).toContain('CAMPAIGN_AGENT');
    expect(names).toContain('RESEARCH_AGENT');
  });

  /** The exact deploy failure this file exists to prevent. */
  it('only names classes the agent Worker exports', () => {
    for (const binding of bindingsOf(app)) {
      if (binding.script_name !== 'jwbs-growth-agent') continue;
      expect(
        exported.has(binding.class_name),
        `${binding.name} binds ${binding.class_name}, which workers/agent/src/index.ts does not export`,
      ).toBe(true);
    }
  });

  it('names the agent Worker by the name that Worker is deployed under', () => {
    for (const binding of bindingsOf(app)) {
      if (!binding.script_name) continue;
      expect(binding.script_name).toBe(agent.name);
    }
  });
});

describe('the agent Worker', () => {
  it('exports every class it binds', () => {
    for (const binding of bindingsOf(agent)) {
      expect(exported.has(binding.class_name), `${binding.class_name} is bound but not exported`).toBe(true);
    }
  });

  /**
   * A Durable Object class that no migration ever introduced cannot be
   * deployed. Only SQLite-backed classes work here: the Agents SDK keeps its
   * state and its schedule in the object's embedded SQLite.
   */
  it('introduces every exported agent class in a migration', () => {
    for (const name of exported) {
      expect(migrated.has(name), `${name} is exported but no migration introduces it`).toBe(true);
    }
  });

  it('keeps migration tags unique and ordered', () => {
    const tags = ((agent.migrations as Array<{ tag: string }>) ?? []).map((m) => m.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toEqual([...tags].sort());
  });
});

describe('deploy order', () => {
  /**
   * The app cannot be deployed before the agent Worker that owns its classes.
   * `deploy` encodes that; anything calling `wrangler deploy` on its own —
   * a CI deploy command, most often — skips it and fails at the API.
   */
  it('deploys the agent Worker before the app', () => {
    const deploy = pkg.scripts.deploy ?? '';
    expect(deploy).toContain('deploy:agent');
    expect(deploy.indexOf('deploy:agent')).toBeLessThan(deploy.indexOf('wrangler deploy'));
  });

  it('points deploy:agent at the agent Worker config', () => {
    expect(pkg.scripts['deploy:agent']).toContain('workers/agent/wrangler.jsonc');
  });
});
