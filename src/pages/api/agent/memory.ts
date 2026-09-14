import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { ai, db } from '~/lib/env';
import {
  agentMemories,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
} from '~/lib/db/schema';
import { remember, retire } from '~/lib/agent/memory';

export const prerender = false;

function asScope(value: string): MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(value) ? (value as MemoryScope) : 'global';
}

function asKind(value: string): MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact';
}

/**
 * Add, pin, retire or delete what the agent knows.
 *
 * A memory you write by hand starts at a higher confidence than one the agent
 * inferred, and is pinned by default when you say so — the difference between
 * "it worked this out" and "I told it" is worth keeping in the data.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = locals.user;
  if (!user) return redirect('/login', 302);

  const form = await request.formData();
  const action = String(form.get('action') ?? 'add');
  const id = String(form.get('id') ?? '');
  const database = db();
  const back = String(form.get('back') ?? '/growth/memory');

  try {
    switch (action) {
      case 'add': {
        const content = String(form.get('content') ?? '').trim();
        if (content.length < 12) {
          return redirect(`${back}?error=${encodeURIComponent('That is too short to be worth remembering.')}`, 302);
        }

        await remember(
          { db: database, userId: user.id, ai: ai(), enabled: true },
          {
            content,
            kind: asKind(String(form.get('kind') ?? 'preference')),
            scope: asScope(String(form.get('scope') ?? 'global')),
            scopeKey: String(form.get('scopeKey') ?? ''),
            tags: String(form.get('tags') ?? '')
              .split(/[\n,]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            source: 'you',
            // Something you wrote yourself is not a guess.
            confidence: 90,
            pinned: form.get('pinned') === 'on',
          },
        );
        break;
      }

      case 'pin':
      case 'unpin':
        await database
          .update(agentMemories)
          .set({ pinned: action === 'pin', updatedAt: new Date().toISOString() })
          .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, user.id)));
        break;

      case 'retire':
        await retire(database, user.id, id, 'you said so');
        break;

      case 'restore':
        await database
          .update(agentMemories)
          .set({ retiredAt: null, confidence: 60, updatedAt: new Date().toISOString() })
          .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, user.id)));
        break;

      case 'delete':
        await database
          .delete(agentMemories)
          .where(and(eq(agentMemories.id, id), eq(agentMemories.userId, user.id)));
        break;

      default:
        return new Response('Unknown action', { status: 400 });
    }
  } catch (error) {
    return redirect(`${back}?error=${encodeURIComponent(String(error))}`, 302);
  }

  return redirect(back, 302);
};
