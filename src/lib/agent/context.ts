/**
 * Assembling an agent.
 *
 * Both entry points — a research task somebody started from the growth pages,
 * and a pipeline stage that wants to go and look something up — need the same
 * five things wired together: the settings that say how much rope the agent
 * has, a browser if one is configured, a search provider if one is, a memory
 * handle, and somewhere to file what it collects.
 *
 * Doing that in one place means the two paths cannot drift apart, which
 * matters more than it sounds: the whole point of the memory is that what the
 * pipeline learns is there when you ask a question by hand, and the whole
 * point of the skills is that what you teach it by hand shows up in the
 * pipeline.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/index';
import { settings, type BrowserMode, type SelfImproveMode } from '../db/schema';
import { discoveryUserAgent } from '../growth/discovery/index';
import type { AiUsageContext } from '../ai/usage';
import { browserConfig, type BrowserConfig } from './browser';
import type { MemoryContext } from './memory';
import type { SearchProviderName } from './websearch';
import { emptyHarvest, type ToolContext } from './tools';

export interface AgentSettingsView {
  browserMode: BrowserMode;
  stepBudget: number;
  memoryEnabled: boolean;
  skillsEnabled: boolean;
  selfImprove: SelfImproveMode;
  researchDailyCap: number;
  aiCacheTtlHours: number;
}

/**
 * Defaults for a user with no settings row yet.
 *
 * Conservative on the two that cost money and permissive on the two that do
 * not: no browser until it is configured, a small step budget, but memory and
 * skills on — an agent that cannot remember anything is the thing this was
 * all built to stop being.
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettingsView = {
  browserMode: 'fallback',
  stepBudget: 8,
  memoryEnabled: true,
  skillsEnabled: true,
  selfImprove: 'propose',
  researchDailyCap: 20,
  aiCacheTtlHours: 72,
};

export async function loadAgentSettings(db: Db, userId: string): Promise<AgentSettingsView> {
  try {
    const rows = await db
      .select({
        browserMode: settings.agentBrowserMode,
        stepBudget: settings.agentStepBudget,
        memoryEnabled: settings.agentMemoryEnabled,
        skillsEnabled: settings.agentSkillsEnabled,
        selfImprove: settings.agentSelfImprove,
        researchDailyCap: settings.agentResearchDailyCap,
        aiCacheTtlHours: settings.aiCacheTtlHours,
      })
      .from(settings)
      .where(eq(settings.userId, userId))
      .limit(1);

    const row = rows[0];
    if (!row) return DEFAULT_AGENT_SETTINGS;

    return {
      browserMode: row.browserMode,
      stepBudget: Math.min(Math.max(row.stepBudget, 1), 24),
      memoryEnabled: row.memoryEnabled,
      skillsEnabled: row.skillsEnabled,
      selfImprove: row.selfImprove,
      researchDailyCap: row.researchDailyCap,
      aiCacheTtlHours: row.aiCacheTtlHours,
    };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export interface AgentEnvironment {
  db: Db;
  ai: Ai;
  bucket: R2Bucket;
  env: Env;
  appUrl: string;
}

export interface BuildContextOptions {
  userId: string;
  campaignId?: string | null;
  prospectId?: string | null;
  /** Where anything the tools store is filed. */
  artifactPrefix: string;
  usage: AiUsageContext;
  agentSettings: AgentSettingsView;
}

export function buildToolContext(
  environment: AgentEnvironment,
  options: BuildContextOptions,
): ToolContext {
  const config: BrowserConfig | null = browserConfig(environment.env);
  const userAgent = discoveryUserAgent(environment.appUrl);

  const memory: MemoryContext = {
    db: environment.db,
    userId: options.userId,
    ai: environment.ai,
    usage: { ...options.usage, operation: 'memory' },
    enabled: options.agentSettings.memoryEnabled,
  };

  return {
    db: environment.db,
    ai: environment.ai,
    bucket: environment.bucket,
    userId: options.userId,
    campaignId: options.campaignId ?? null,
    prospectId: options.prospectId ?? null,
    userAgent,
    browser: {
      // A browser mode of anything but `off` still means nothing without a
      // token; `toolsFor` reads both, so the tools simply are not offered.
      mode: config ? options.agentSettings.browserMode : 'off',
      config,
    },
    search: {
      provider: (environment.env.SEARCH_PROVIDER as SearchProviderName) ?? 'none',
      apiKey: environment.env.SEARCH_API_KEY,
    },
    memory,
    selfImprove: options.agentSettings.selfImprove,
    usage: options.usage,
    artifactPrefix: options.artifactPrefix,
    harvest: emptyHarvest(),
  };
}

/** Whether a real browser is available at all, for the settings page to say so. */
export function browserAvailable(env: Env): boolean {
  return browserConfig(env) !== null;
}
