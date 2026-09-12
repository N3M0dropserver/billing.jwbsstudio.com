import type { APIRoute } from 'astro';
import { and, eq, or, like, sql, desc } from 'drizzle-orm';
import { db } from '~/lib/env';
import { invoices, clients, expenses, timeEntries, projects } from '~/lib/db/schema';
import { formatMoneyShort } from '~/lib/tax/money';

export const prerender = false;

interface SearchHit {
  type: 'invoice' | 'client' | 'expense' | 'time' | 'project';
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
}

const PER_TYPE = 4;

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
  }

  const query = (url.searchParams.get('q') ?? '').trim();
  if (query.length < 1) {
    return Response.json({ hits: [] });
  }

  // LIKE with escaped wildcards: a user searching for "50%" should not get
  // every row back.
  const term = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const database = db();

  const [invoiceRows, clientRows, expenseRows, timeRows, projectRows] = await Promise.all([
    database
      .select({
        id: invoices.id,
        number: invoices.number,
        total: invoices.total,
        status: invoices.status,
        currency: invoices.currency,
        issuedOn: invoices.issuedOn,
        reference: invoices.reference,
        clientName: clients.name,
      })
      .from(invoices)
      .leftJoin(clients, eq(invoices.clientId, clients.id))
      .where(
        and(
          eq(invoices.userId, user.id),
          or(
            sql`${invoices.number} LIKE ${term} ESCAPE '\\'`,
            sql`${invoices.reference} LIKE ${term} ESCAPE '\\'`,
            sql`${invoices.notes} LIKE ${term} ESCAPE '\\'`,
            sql`${clients.name} LIKE ${term} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(desc(invoices.issuedOn))
      .limit(PER_TYPE),

    database
      .select({
        id: clients.id,
        name: clients.name,
        email: clients.email,
        country: clients.country,
        status: clients.status,
      })
      .from(clients)
      .where(
        and(
          eq(clients.userId, user.id),
          or(
            sql`${clients.name} LIKE ${term} ESCAPE '\\'`,
            sql`${clients.legalName} LIKE ${term} ESCAPE '\\'`,
            sql`${clients.email} LIKE ${term} ESCAPE '\\'`,
            sql`${clients.notes} LIKE ${term} ESCAPE '\\'`,
          ),
        ),
      )
      .limit(PER_TYPE),

    database
      .select({
        id: expenses.id,
        description: expenses.description,
        vendor: expenses.vendor,
        category: expenses.category,
        amountGross: expenses.amountGross,
        currency: expenses.currency,
        incurredOn: expenses.incurredOn,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.userId, user.id),
          or(
            sql`${expenses.description} LIKE ${term} ESCAPE '\\'`,
            sql`${expenses.vendor} LIKE ${term} ESCAPE '\\'`,
            sql`${expenses.category} LIKE ${term} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(desc(expenses.incurredOn))
      .limit(PER_TYPE),

    database
      .select({
        id: timeEntries.id,
        description: timeEntries.description,
        minutes: timeEntries.minutes,
        startedAt: timeEntries.startedAt,
        clientName: clients.name,
      })
      .from(timeEntries)
      .leftJoin(clients, eq(timeEntries.clientId, clients.id))
      .where(
        and(
          eq(timeEntries.userId, user.id),
          sql`${timeEntries.description} LIKE ${term} ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(timeEntries.startedAt))
      .limit(PER_TYPE),

    database
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        clientName: clients.name,
      })
      .from(projects)
      .leftJoin(clients, eq(projects.clientId, clients.id))
      .where(
        and(eq(projects.userId, user.id), sql`${projects.name} LIKE ${term} ESCAPE '\\'`),
      )
      .limit(PER_TYPE),
  ]);

  const hits: SearchHit[] = [
    ...invoiceRows.map((row) => ({
      type: 'invoice' as const,
      id: row.id,
      title: row.number,
      subtitle: [row.clientName, row.status].filter(Boolean).join(' · '),
      meta: formatMoneyShort(row.total, row.currency),
      href: `/invoices/${row.id}`,
    })),
    ...clientRows.map((row) => ({
      type: 'client' as const,
      id: row.id,
      title: row.name,
      subtitle: [row.email, row.country].filter(Boolean).join(' · '),
      href: `/clients/${row.id}`,
    })),
    ...expenseRows.map((row) => ({
      type: 'expense' as const,
      id: row.id,
      title: row.description,
      subtitle: [row.vendor, row.category].filter(Boolean).join(' · '),
      meta: formatMoneyShort(row.amountGross, row.currency),
      href: `/tax/expenses/${row.id}`,
    })),
    ...timeRows.map((row) => ({
      type: 'time' as const,
      id: row.id,
      title: row.description || 'Untitled entry',
      subtitle: [row.clientName, row.startedAt.slice(0, 10)].filter(Boolean).join(' · '),
      meta: `${(row.minutes / 60).toFixed(1)}h`,
      href: `/time?entry=${row.id}`,
    })),
    ...projectRows.map((row) => ({
      type: 'project' as const,
      id: row.id,
      title: row.name,
      subtitle: [row.clientName, row.status].filter(Boolean).join(' · '),
      href: `/clients/${row.id}`,
    })),
  ];

  return Response.json(
    { hits },
    { headers: { 'cache-control': 'no-store' } },
  );
};
