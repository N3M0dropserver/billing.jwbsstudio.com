/**
 * D1 schema.
 *
 * Conventions:
 *  - Every money column is an INTEGER number of CENTS. Never REAL.
 *  - Every timestamp is an ISO-8601 UTC string, so it sorts lexically and
 *    survives a JSON round trip without timezone drift.
 *  - Every id is a ULID-ish string generated in the app, not an autoincrement,
 *    so records can be created client-side and merged without collisions.
 */

import { sqliteTable, text, integer, index, uniqueIndex, real } from 'drizzle-orm/sqlite-core';

const id = () => text('id').primaryKey();
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

/* ------------------------------------------------------------------ */
/* Auth — invite only, no self-service signup                          */
/* ------------------------------------------------------------------ */

export const users = sqliteTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** PBKDF2-SHA256, stored as "pbkdf2$<iterations>$<saltB64>$<hashB64>". */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['owner', 'accountant', 'viewer'] })
      .notNull()
      .default('owner'),
    /** Set when the account is provisioned but the password is not yet chosen. */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' })
      .notNull()
      .default(false),
    disabledAt: text('disabled_at'),
    lastLoginAt: text('last_login_at'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: text('locked_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token. The raw token only ever lives in the cookie. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Single-use tokens for signing in by email link, and anything else that
 * proves possession of the mailbox rather than knowledge of a password.
 *
 * As with sessions, only the SHA-256 of the token is stored — the raw value
 * exists in the emailed URL and nowhere else. A leaked database therefore
 * yields no usable sign-in link.
 */
export const loginTokens = sqliteTable(
  'login_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['magic-link'] })
      .notNull()
      .default('magic-link'),
    /** SHA-256 of the token. The raw token only ever lives in the emailed URL. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    /** Set the moment the link is redeemed, so it cannot be used twice. */
    consumedAt: text('consumed_at'),
    /** Where the link was asked for, which is not necessarily where it is used. */
    requestedIp: text('requested_ip'),
    requestedUserAgent: text('requested_user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('login_tokens_token_idx').on(t.tokenHash),
    index('login_tokens_user_idx').on(t.userId, t.createdAt),
    index('login_tokens_expiry_idx').on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const settings = sqliteTable('settings', {
  id: id(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** Trading name shown on invoices. */
  businessName: text('business_name').notNull().default(''),
  legalName: text('legal_name').notNull().default(''),
  addressLine1: text('address_line1').notNull().default(''),
  addressLine2: text('address_line2').notNull().default(''),
  city: text('city').notNull().default(''),
  postcode: text('postcode').notNull().default(''),
  country: text('country').notNull().default('NZ'),
  email: text('email').notNull().default(''),
  phone: text('phone').notNull().default(''),
  website: text('website').notNull().default(''),
  logoKey: text('logo_key'),

  /** Where you are tax resident. Drives which country taxes worldwide income. */
  taxResidence: text('tax_residence', { enum: ['NZ', 'AU'] })
    .notNull()
    .default('NZ'),

  nzIrdNumber: text('nz_ird_number').notNull().default(''),
  nzGstRegistered: integer('nz_gst_registered', { mode: 'boolean' }).notNull().default(false),
  nzGstNumber: text('nz_gst_number').notNull().default(''),
  nzGstFilingFrequency: text('nz_gst_filing_frequency', {
    enum: ['monthly', 'two-monthly', 'six-monthly'],
  })
    .notNull()
    .default('two-monthly'),
  nzHasStudentLoan: integer('nz_has_student_loan', { mode: 'boolean' }).notNull().default(false),
  nzAccCover: text('nz_acc_cover', { enum: ['CoverPlus', 'CoverPlusExtra'] })
    .notNull()
    .default('CoverPlus'),
  nzAccAgreedCover: integer('nz_acc_agreed_cover'),
  /** Your ACC classification unit work levy rate, ex GST, as a decimal. */
  nzAccWorkLevyRate: real('nz_acc_work_levy_rate'),
  nzAccFullTime: integer('nz_acc_full_time', { mode: 'boolean' }).notNull().default(true),

  auAbn: text('au_abn').notNull().default(''),
  auGstRegistered: integer('au_gst_registered', { mode: 'boolean' }).notNull().default(false),
  auBasFrequency: text('au_bas_frequency', { enum: ['monthly', 'quarterly', 'annual'] })
    .notNull()
    .default('quarterly'),
  auHasHelpDebt: integer('au_has_help_debt', { mode: 'boolean' }).notNull().default(false),
  auHasPrivateHospitalCover: integer('au_has_private_hospital_cover', { mode: 'boolean' })
    .notNull()
    .default(false),

  /** Default currency for new invoices. */
  defaultCurrency: text('default_currency', { enum: ['NZD', 'AUD'] })
    .notNull()
    .default('NZD'),
  defaultPaymentTermsDays: integer('default_payment_terms_days').notNull().default(14),
  defaultHourlyRate: integer('default_hourly_rate').notNull().default(0),
  invoiceNumberPrefix: text('invoice_number_prefix').notNull().default('INV-'),
  invoiceNextNumber: integer('invoice_next_number').notNull().default(1),
  invoiceFooter: text('invoice_footer').notNull().default(''),

  bankAccountName: text('bank_account_name').notNull().default(''),
  bankAccountNumber: text('bank_account_number').notNull().default(''),
  bankName: text('bank_name').notNull().default(''),
  bankBsb: text('bank_bsb').notNull().default(''),
  bankSwift: text('bank_swift').notNull().default(''),

  stripeEnabled: integer('stripe_enabled', { mode: 'boolean' }).notNull().default(false),

  /** Share of each payment to move into the tax account, as a decimal. */
  taxReserveRate: real('tax_reserve_rate').notNull().default(0.33),

  /* -- Growth engine defaults ------------------------------------- */

  /** JSON `{ [stage]: 'manual' | 'ai' | 'auto' }`. Blank means all manual. */
  growthPolicy: text('growth_policy').notNull().default('{}'),
  /** Brand kit new campaigns start from. */
  growthBrandKitId: text('growth_brand_kit_id'),
  growthDiscoveryProvider: text('growth_discovery_provider', {
    enum: ['overpass', 'google-places', 'manual'],
  })
    .notNull()
    .default('overpass'),
  /** Apex the generated demos are published under. */
  demoHost: text('demo_host').notNull().default('demo.jwbsstudio.com'),
  /**
   * Whether a demo subdomain has actually been seen to resolve.
   *
   * Until it has, demos are linked on the app's own origin instead. Wildcard
   * DNS and a matching Worker route are a manual setup step, and a proposal
   * email containing a link that does not load is worse than an ugly one.
   */
  demoHostVerified: integer('demo_host_verified', { mode: 'boolean' }).notNull().default(false),
  demoHostCheckedAt: text('demo_host_checked_at'),
  demoHostCheckResult: text('demo_host_check_result').notNull().default(''),
  /** Hours an identical AI request may be served from cache. 0 disables it. */
  aiCacheTtlHours: integer('ai_cache_ttl_hours').notNull().default(72),
  /**
   * Hard ceiling on outreach emails sent by unattended runs in any rolling
   * 24 hours. An automated pipeline that can mail strangers needs a number
   * it cannot talk itself past; zero blocks unattended sending entirely.
   */
  outreachDailyCap: integer('outreach_daily_cap').notNull().default(10),
  /** How you sign the outreach, and the paragraph about what you do. */
  outreachSenderName: text('outreach_sender_name').notNull().default(''),
  outreachBio: text('outreach_bio').notNull().default(''),
  outreachSignature: text('outreach_signature').notNull().default(''),
  /** Reply-to for outreach, when it differs from the invoicing address. */
  outreachReplyTo: text('outreach_reply_to').notNull().default(''),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* Clients                                                             */
/* ------------------------------------------------------------------ */

export const clients = sqliteTable(
  'clients',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    legalName: text('legal_name').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    website: text('website').notNull().default(''),
    addressLine1: text('address_line1').notNull().default(''),
    addressLine2: text('address_line2').notNull().default(''),
    city: text('city').notNull().default(''),
    postcode: text('postcode').notNull().default(''),
    /** ISO country code. Drives the GST export treatment on their invoices. */
    country: text('country').notNull().default('NZ'),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    /** NZBN, ABN or equivalent. Needed to evidence a zero-rated export. */
    taxNumber: text('tax_number').notNull().default(''),
    /** Overrides the default GST treatment for this client's invoices. */
    gstTreatment: text('gst_treatment', {
      enum: ['auto', 'standard', 'zero-rated-export', 'exempt'],
    })
      .notNull()
      .default('auto'),
    hourlyRate: integer('hourly_rate'),
    paymentTermsDays: integer('payment_terms_days'),
    status: text('status', { enum: ['lead', 'active', 'dormant', 'archived'] })
      .notNull()
      .default('active'),
    source: text('source').notNull().default(''),
    notes: text('notes').notNull().default(''),
    tags: text('tags').notNull().default('[]'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('clients_user_idx').on(t.userId),
    index('clients_status_idx').on(t.userId, t.status),
    index('clients_name_idx').on(t.name),
  ],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: id(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('contacts_client_idx').on(t.clientId)],
);

export const communications = sqliteTable(
  'communications',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: ['email', 'call', 'meeting', 'note', 'proposal-sent', 'invoice-sent', 'follow-up'],
    }).notNull(),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    occurredAt: text('occurred_at').notNull(),
    followUpAt: text('follow_up_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('comms_client_idx').on(t.clientId, t.occurredAt),
    index('comms_followup_idx').on(t.userId, t.followUpAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

export const invoices = sqliteTable(
  'invoices',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),

    number: text('number').notNull(),
    status: text('status', {
      enum: ['draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'void', 'written-off'],
    })
      .notNull()
      .default('draft'),

    /**
     * Manual entries are invoices raised outside this system (the old
     * spreadsheet rows, or anything billed by another means). They count for
     * tax but have no PDF and are never sent.
     */
    isManualEntry: integer('is_manual_entry', { mode: 'boolean' }).notNull().default(false),

    issuedOn: text('issued_on').notNull(),
    dueOn: text('due_on').notNull(),
    paidOn: text('paid_on'),

    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    /** Jurisdiction whose GST rules apply to this invoice. */
    jurisdiction: text('jurisdiction', { enum: ['NZ', 'AU'] }).notNull().default('NZ'),
    gstTreatment: text('gst_treatment', {
      enum: ['standard', 'zero-rated-export', 'exempt', 'not-registered'],
    })
      .notNull()
      .default('standard'),

    subtotal: integer('subtotal').notNull().default(0),
    gstAmount: integer('gst_amount').notNull().default(0),
    total: integer('total').notNull().default(0),
    amountPaid: integer('amount_paid').notNull().default(0),

    /**
     * Rate used to convert this invoice into the tax-residence currency.
     * Stored per invoice because the rate on the day is what the return uses.
     */
    fxRateToResidence: real('fx_rate_to_residence').notNull().default(1),

    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    terms: text('terms').notNull().default(''),

    pdfKey: text('pdf_key'),
    /** Random token for the public view/pay link. */
    publicToken: text('public_token'),
    sentAt: text('sent_at'),
    viewedAt: text('viewed_at'),
    remindersSent: integer('reminders_sent').notNull().default(0),
    lastReminderAt: text('last_reminder_at'),

    stripePaymentIntentId: text('stripe_payment_intent_id'),
    stripePaymentLinkUrl: text('stripe_payment_link_url'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invoices_number_idx').on(t.userId, t.number),
    uniqueIndex('invoices_public_token_idx').on(t.publicToken),
    index('invoices_user_status_idx').on(t.userId, t.status),
    index('invoices_client_idx').on(t.clientId),
    index('invoices_issued_idx').on(t.userId, t.issuedOn),
    index('invoices_due_idx').on(t.userId, t.dueOn),
  ],
);

export const invoiceLines = sqliteTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    description: text('description').notNull(),
    /** Quantity in thousandths, so 1.5 hours is stored as 1500. */
    quantity: integer('quantity').notNull().default(1000),
    unit: text('unit').notNull().default('hours'),
    unitPrice: integer('unit_price').notNull().default(0),
    /** Discount as a decimal, e.g. 0.1 for 10% off. */
    discount: real('discount').notNull().default(0),
    lineTotal: integer('line_total').notNull().default(0),
    taxable: integer('taxable', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId, t.position)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invoiceId: text('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    receivedOn: text('received_on').notNull(),
    method: text('method', {
      enum: ['bank-transfer', 'stripe', 'cash', 'paypal', 'wise', 'other'],
    })
      .notNull()
      .default('bank-transfer'),
    /** Merchant/processing fee deducted before the money landed. */
    fee: integer('fee').notNull().default(0),
    reference: text('reference').notNull().default(''),
    stripeChargeId: text('stripe_charge_id'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_user_date_idx').on(t.userId, t.receivedOn),
  ],
);

/* ------------------------------------------------------------------ */
/* Expenses and assets                                                 */
/* ------------------------------------------------------------------ */

export const expenses = sqliteTable(
  'expenses',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),

    description: text('description').notNull(),
    vendor: text('vendor').notNull().default(''),
    category: text('category').notNull().default('other'),
    incurredOn: text('incurred_on').notNull(),

    /** Amount as it appeared on the receipt, GST inclusive. */
    amountGross: integer('amount_gross').notNull().default(0),
    /** GST component, where one was charged and you can claim it. */
    gstAmount: integer('gst_amount').notNull().default(0),
    /** Amount excluding GST — the figure that feeds the income tax deduction. */
    amountNet: integer('amount_net').notNull().default(0),

    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    jurisdiction: text('jurisdiction', { enum: ['NZ', 'AU'] }).notNull().default('NZ'),

    /** Share that is business use, 0..1. */
    businessUsePercent: real('business_use_percent').notNull().default(1),
    /** businessUsePercent applied to amountNet. Denormalised for fast rollups. */
    claimableAmount: integer('claimable_amount').notNull().default(0),

    /** True when this is a capital asset rather than a running cost. */
    isCapital: integer('is_capital', { mode: 'boolean' }).notNull().default(false),
    assetId: text('asset_id'),

    /** Set when the invoice it relates to is rebilled to a client. */
    isBillable: integer('is_billable', { mode: 'boolean' }).notNull().default(false),
    billedOnInvoiceId: text('billed_on_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),

    receiptKey: text('receipt_key'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('expenses_user_date_idx').on(t.userId, t.incurredOn),
    index('expenses_category_idx').on(t.userId, t.category),
    index('expenses_client_idx').on(t.clientId),
  ],
);

export const assets = sqliteTable(
  'assets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull().default('assets'),
    acquiredOn: text('acquired_on').notNull(),
    disposedOn: text('disposed_on'),
    disposalProceeds: integer('disposal_proceeds'),

    /** Cost excluding GST if registered, including if not. */
    cost: integer('cost').notNull(),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    jurisdiction: text('jurisdiction', { enum: ['NZ', 'AU'] }).notNull().default('NZ'),

    depreciationRate: real('depreciation_rate').notNull().default(0.3),
    depreciationMethod: text('depreciation_method', { enum: ['DV', 'SL'] })
      .notNull()
      .default('DV'),
    businessUsePercent: real('business_use_percent').notNull().default(1),

    /** Total depreciation claimed to date. */
    accumulatedDepreciation: integer('accumulated_depreciation').notNull().default(0),
    /** True when written off in full in year one under a low-value rule. */
    immediateWriteOff: integer('immediate_write_off', { mode: 'boolean' })
      .notNull()
      .default(false),

    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('assets_user_idx').on(t.userId, t.acquiredOn)],
);

export const depreciationEntries = sqliteTable(
  'depreciation_entries',
  {
    id: id(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    taxYear: text('tax_year').notNull(),
    opening: integer('opening').notNull(),
    depreciation: integer('depreciation').notNull(),
    claimable: integer('claimable').notNull(),
    closing: integer('closing').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('depreciation_asset_year_idx').on(t.assetId, t.taxYear)],
);

/* ------------------------------------------------------------------ */
/* Other income — employment, interest, anything not invoiced          */
/* ------------------------------------------------------------------ */

export const incomeSources = sqliteTable(
  'income_sources',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taxYear: text('tax_year').notNull(),
    jurisdiction: text('jurisdiction', { enum: ['NZ', 'AU'] }).notNull(),
    kind: text('kind', {
      enum: ['employment', 'interest', 'dividends', 'rental', 'foreign', 'other'],
    }).notNull(),
    label: text('label').notNull(),
    /** Gross amount before any withholding. */
    grossAmount: integer('gross_amount').notNull().default(0),
    /** PAYE (NZ) or PAYG withholding (AU) already taken. */
    taxWithheld: integer('tax_withheld').notNull().default(0),
    /** ACC earner levy collected through PAYE, NZ employment only. */
    accLevyWithheld: integer('acc_levy_withheld').notNull().default(0),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('income_sources_user_year_idx').on(t.userId, t.taxYear)],
);

/* ------------------------------------------------------------------ */
/* Time tracking                                                       */
/* ------------------------------------------------------------------ */

export const timeEntries = sqliteTable(
  'time_entries',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    invoiceId: text('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),

    description: text('description').notNull().default(''),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    /** Duration in minutes. Set when the timer stops or on manual entry. */
    minutes: integer('minutes').notNull().default(0),

    billable: integer('billable', { mode: 'boolean' }).notNull().default(true),
    /** Overrides the client or default rate for this entry. */
    hourlyRate: integer('hourly_rate'),
    billed: integer('billed', { mode: 'boolean' }).notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('time_user_started_idx').on(t.userId, t.startedAt),
    index('time_client_idx').on(t.clientId),
    index('time_unbilled_idx').on(t.userId, t.billed),
  ],
);

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['active', 'on-hold', 'complete', 'archived'] })
      .notNull()
      .default('active'),
    /** Agreed fixed price, if the work is not hourly. */
    fixedPrice: integer('fixed_price'),
    estimatedHours: real('estimated_hours'),
    startedOn: text('started_on'),
    dueOn: text('due_on'),
    completedOn: text('completed_on'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_user_idx').on(t.userId, t.status), index('projects_client_idx').on(t.clientId)],
);

/* ------------------------------------------------------------------ */
/* Growth engine                                                       */
/* ------------------------------------------------------------------ */

/**
 * A campaign moves through these stages in order. Each one can be set to
 * run by itself, to be decided by the model, or to stop and wait for you —
 * see `StageMode`.
 */
export const CAMPAIGN_STAGES = [
  'brief',
  'discover',
  'shortlist',
  'enrich',
  'plan',
  'build',
  'propose',
] as const;
export type CampaignStage = (typeof CAMPAIGN_STAGES)[number];

/**
 * How much rope a stage is given.
 *
 *   manual — do the work, then stop and wait for a decision.
 *   ai     — do the work, let the model decide, record the reasoning, carry on.
 *   auto   — do the work and carry on with the obvious default, no model call.
 *
 * `auto` is not "more autonomous than ai" — it is *less* considered. On the
 * shortlist stage `auto` means take everything above the score floor, while
 * `ai` means the model picks and says why.
 */
export const STAGE_MODES = ['manual', 'ai', 'auto'] as const;
export type StageMode = (typeof STAGE_MODES)[number];

/**
 * Reference material the generated sites are built from: the sites to
 * channel, the type, the palette, the rules. Saved kits are the defaults; a
 * campaign can override any field for a single run.
 */
export const brandKits = sqliteTable(
  'brand_kits',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),

    /** JSON `[{ url, note }]` — sites whose feel we are after. */
    referenceUrls: text('reference_urls').notNull().default('[]'),
    /** JSON `[{ role, family, fallback, source, url, weights }]`. */
    typography: text('typography').notNull().default('[]'),
    /** JSON `[{ name, value, role }]` — CSS colour tokens. */
    palette: text('palette').notNull().default('[]'),
    /** JSON `string[]` — preferred section order for a generated page. */
    sectionOrder: text('section_order').notNull().default('[]'),

    /** The editable art-direction block handed to the model verbatim. */
    prompt: text('prompt').notNull().default(''),
    /** How the copy should sound. */
    toneNotes: text('tone_notes').notNull().default(''),
    /** Hard rules. Things that must never appear in the output. */
    avoid: text('avoid').notNull().default(''),
    /** What you can actually deliver, so proposals do not over-promise. */
    capabilities: text('capabilities').notNull().default(''),
    /** Which niches this kit suits. */
    suitableFor: text('suitable_for').notNull().default(''),

    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_kits_user_idx').on(t.userId, t.isDefault)],
);

/**
 * Files backing a brand kit or a single campaign — screenshots, template
 * exports, font files, logos. The bytes live in R2; this is the index.
 */
export const brandAssets = sqliteTable(
  'brand_assets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    brandKitId: text('brand_kit_id').references(() => brandKits.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),

    kind: text('kind', {
      enum: ['screenshot', 'template', 'font', 'logo', 'reference', 'other'],
    })
      .notNull()
      .default('screenshot'),
    label: text('label').notNull().default(''),
    note: text('note').notNull().default(''),
    r2Key: text('r2_key').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    bytes: integer('bytes').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('brand_assets_kit_idx').on(t.brandKitId),
    index('brand_assets_campaign_idx').on(t.campaignId),
  ],
);

/**
 * One run of the pipeline: a niche, a region, a brand kit, and a policy
 * saying how much of it happens without you.
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),

    /** The trade. "Coffee roasters", "physiotherapists". */
    niche: text('niche').notNull().default(''),
    /** Free text describing the client you actually want. Steers scoring. */
    idealClient: text('ideal_client').notNull().default(''),
    region: text('region').notNull().default(''),
    country: text('country').notNull().default('NZ'),

    discoveryProvider: text('discovery_provider', {
      enum: ['overpass', 'google-places', 'manual'],
    })
      .notNull()
      .default('overpass'),
    /** Pasted businesses, one per line, when the provider is `manual`. */
    manualInput: text('manual_input').notNull().default(''),

    brandKitId: text('brand_kit_id').references(() => brandKits.id, { onDelete: 'set null' }),
    /** JSON — per-run overrides merged over the saved kit. */
    briefOverrides: text('brief_overrides').notNull().default('{}'),
    /** JSON `{ [stage]: StageMode }`. Missing stages fall back to settings. */
    policy: text('policy').notNull().default('{}'),

    stage: text('stage', { enum: CAMPAIGN_STAGES }).notNull().default('brief'),
    status: text('status', {
      enum: ['draft', 'running', 'waiting', 'paused', 'complete', 'failed', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    /** Set while `status` is `waiting`: the stage that needs a decision. */
    waitingOn: text('waiting_on'),

    /** How many prospects to carry past the shortlist. */
    targetCount: integer('target_count').notNull().default(10),
    /** Prospects below this score are never carried forward, in any mode. */
    scoreFloor: integer('score_floor').notNull().default(55),
    /**
     * Prospects whose measured scale is above this are never carried forward.
     * The default rules out recognised brands and multi-site operators, who
     * do not respond to an unsolicited spec redesign from a freelancer.
     */
    scaleCeiling: integer('scale_ceiling').notNull().default(60),

    discoveredCount: integer('discovered_count').notNull().default(0),
    shortlistedCount: integer('shortlisted_count').notNull().default(0),
    enrichedCount: integer('enriched_count').notNull().default(0),
    plannedCount: integer('planned_count').notNull().default(0),
    builtCount: integer('built_count').notNull().default(0),
    proposedCount: integer('proposed_count').notNull().default(0),

    error: text('error').notNull().default(''),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    lastActivityAt: text('last_activity_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('campaigns_user_idx').on(t.userId, t.createdAt),
    index('campaigns_status_idx').on(t.userId, t.status),
  ],
);

/**
 * The run log. Every stage transition, every model decision and every
 * failure lands here, which is what the live run view reads — and what
 * makes an unattended run auditable after the fact.
 */
export const campaignEvents = sqliteTable(
  'campaign_events',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id'),
    stage: text('stage').notNull().default(''),
    level: text('level', { enum: ['info', 'decision', 'warn', 'error'] })
      .notNull()
      .default('info'),
    message: text('message').notNull(),
    detail: text('detail').notNull().default('{}'),
    createdAt: createdAt(),
  },
  (t) => [index('campaign_events_idx').on(t.campaignId, t.createdAt)],
);

/**
 * A business surfaced by a campaign, plus everything learned about it.
 */
export const prospects = sqliteTable(
  'prospects',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),

    businessName: text('business_name').notNull(),
    niche: text('niche').notNull().default(''),
    region: text('region').notNull().default(''),
    country: text('country').notNull().default('NZ'),

    website: text('website').notNull().default(''),
    /** Registrable host, lower-cased and without `www.`. Dedupe key. */
    domain: text('domain').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    address: text('address').notNull().default(''),
    mapsUrl: text('maps_url').notNull().default(''),
    /** JSON `[{ platform, url, handle }]`. */
    socialLinks: text('social_links').notNull().default('[]'),
    contactName: text('contact_name').notNull().default(''),
    contactRole: text('contact_role').notNull().default(''),

    /** Where the record came from. */
    source: text('source').notNull().default(''),
    sourceRef: text('source_ref').notNull().default(''),

    /** Why this one is worth approaching. */
    signal: text('signal', {
      enum: [
        'no-website',
        'dated-website',
        'no-google-presence',
        'maps-only',
        'poor-mobile',
        'thin-content',
        'broken-site',
        'social-only',
        'other',
      ],
    })
      .notNull()
      .default('other'),
    /**
     * 0..100, measured rather than guessed: what the crawler found about the
     * state of their customer-facing content. Higher means *more* need.
     */
    presenceScore: integer('presence_score').notNull().default(0),
    /** 0..100 from the model: how good a client they would actually be. */
    fitScore: integer('fit_score').notNull().default(0),
    /**
     * 0..100, measured: how large and well-resourced the business already is.
     *
     * A speculative redesign from a freelancer is a plausible approach to an
     * owner-operated shop and an imposition on a national brand with an
     * in-house design team. Kept apart from `fitScore` because it is derived
     * from signals rather than judged, and because it is a *ceiling* — past a
     * point it disqualifies regardless of how good a fit the model thinks
     * they are.
     */
    scaleScore: integer('scale_score').notNull().default(0),
    /** JSON — the signals behind `scaleScore`. */
    scale: text('scale').notNull().default('{}'),
    /** Chain or franchise name, when the business is a branch of one. */
    brand: text('brand').notNull().default(''),
    /** Branches found in the searched region. More than one means a chain. */
    branchCount: integer('branch_count').notNull().default(1),
    /** The ranking number the UI sorts on. Weighted blend of the two above. */
    score: integer('score').notNull().default(0),
    /** JSON — the deterministic audit behind `presenceScore`. */
    audit: text('audit').notNull().default('{}'),
    /** JSON — the model's reasoning, angle, and anything enrichment found. */
    findings: text('findings').notNull().default('{}'),

    rating: real('rating'),
    reviewCount: integer('review_count').notNull().default(0),
    reviewSummary: text('review_summary').notNull().default(''),

    /** Carried past the shortlist. */
    selected: integer('selected', { mode: 'boolean' }).notNull().default(false),
    selectedBy: text('selected_by', { enum: ['user', 'ai', 'auto'] }),
    /** How far down the pipeline this one has actually got. */
    stage: text('stage', { enum: CAMPAIGN_STAGES }).notNull().default('discover'),

    status: text('status', {
      enum: ['new', 'qualified', 'contacted', 'responded', 'converted', 'rejected'],
    })
      .notNull()
      .default('new'),
    convertedClientId: text('converted_client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    notes: text('notes').notNull().default(''),

    enrichedAt: text('enriched_at'),
    plannedAt: text('planned_at'),
    builtAt: text('built_at'),
    proposedAt: text('proposed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('prospects_user_status_idx').on(t.userId, t.status),
    index('prospects_score_idx').on(t.userId, t.score),
    index('prospects_campaign_idx').on(t.campaignId, t.score),
    index('prospects_domain_idx').on(t.userId, t.domain),
  ],
);

/**
 * Anything downloaded or generated for a prospect, stored in R2. Crawled
 * pages, their images, the generated site's files. Kept out of D1 because
 * a single crawled page can be larger than a sensible row.
 */
export const prospectArtifacts = sqliteTable(
  'prospect_artifacts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),

    kind: text('kind', {
      enum: ['page', 'image', 'asset', 'feed', 'review', 'plan', 'site', 'source'],
    })
      .notNull()
      .default('page'),
    label: text('label').notNull().default(''),
    /** Where it came from, when it came from somewhere. */
    sourceUrl: text('source_url').notNull().default(''),
    r2Key: text('r2_key').notNull().default(''),
    contentType: text('content_type').notNull().default(''),
    bytes: integer('bytes').notNull().default(0),
    /** JSON — extracted title, headings, word count, colours, fonts. */
    meta: text('meta').notNull().default('{}'),
    createdAt: createdAt(),
  },
  (t) => [index('prospect_artifacts_idx').on(t.prospectId, t.kind)],
);

/**
 * The design and page plan for one prospect: what we are proposing, why it
 * serves them, and the section-by-section spec the generator builds from.
 */
export const designPlans = sqliteTable(
  'design_plans',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    brandKitId: text('brand_kit_id').references(() => brandKits.id, { onDelete: 'set null' }),

    /** One line: what this site is for. */
    summary: text('summary').notNull().default(''),
    /** Why this layout serves *their* goal — sales, bookings, or standing. */
    strategy: text('strategy').notNull().default(''),
    /** What we are optimising for: 'conversion' | 'awareness' | 'credibility'. */
    objective: text('objective').notNull().default('conversion'),

    /** JSON `[{ name, value, role }]` — resolved for this prospect. */
    palette: text('palette').notNull().default('[]'),
    /** JSON `[{ role, family, fallback, source, url, weights }]`. */
    typography: text('typography').notNull().default('[]'),
    /** JSON `[{ id, type, heading, subheading, body, items, cta, imageHint, notes }]`. */
    sections: text('sections').notNull().default('[]'),
    /** JSON `{ title, description, ogImageHint }`. */
    meta: text('meta').notNull().default('{}'),

    model: text('model').notNull().default(''),
    status: text('status', { enum: ['draft', 'approved', 'rejected'] })
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('design_plans_prospect_idx').on(t.prospectId)],
);

/**
 * A generated demo published to a subdomain. The built files live in R2
 * under `r2Prefix` and are served straight from there; `sourcePrefix` holds
 * an Astro project you can hand over or deploy standalone.
 */
export const demoSites = sqliteTable(
  'demo_sites',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => designPlans.id, { onDelete: 'set null' }),

    /** The label only, e.g. `wells-coffee`. */
    subdomain: text('subdomain').notNull(),
    /** The full host it is served on. */
    host: text('host').notNull(),
    /**
     * The URL handed to the prospect.
     *
     * The subdomain when the wildcard has been verified as reachable, and the
     * path-based mount on the app's own origin otherwise — so a demo is
     * always openable even before DNS is arranged.
     */
    publicUrl: text('public_url').notNull().default(''),

    status: text('status', { enum: ['building', 'live', 'failed', 'archived'] })
      .notNull()
      .default('building'),
    /** R2 prefix holding the served files. */
    r2Prefix: text('r2_prefix').notNull().default(''),
    /** R2 prefix holding the exported Astro project source. */
    sourcePrefix: text('source_prefix').notNull().default(''),
    fileCount: integer('file_count').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    buildError: text('build_error').notNull().default(''),
    /** Set when we created the DNS record through the Cloudflare API. */
    dnsRecordId: text('dns_record_id'),

    views: integer('views').notNull().default(0),
    lastViewedAt: text('last_viewed_at'),
    publishedAt: text('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('demo_sites_host_idx').on(t.host),
    index('demo_sites_prospect_idx').on(t.prospectId),
  ],
);

export const proposals = sqliteTable(
  'proposals',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),
    prospectId: text('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    demoSiteId: text('demo_site_id').references(() => demoSites.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    status: text('status', {
      enum: ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'],
    })
      .notNull()
      .default('draft'),
    body: text('body').notNull().default(''),
    /** The outreach email itself, kept apart from the proposal page body. */
    emailSubject: text('email_subject').notNull().default(''),
    emailBody: text('email_body').notNull().default(''),
    /** Where it was sent, and what the provider said. */
    sentTo: text('sent_to').notNull().default(''),
    sendResult: text('send_result').notNull().default(''),

    /** Quoted amount, excluding GST. */
    amount: integer('amount').notNull().default(0),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),

    publicToken: text('public_token'),
    viewCount: integer('view_count').notNull().default(0),
    sentAt: text('sent_at'),
    viewedAt: text('viewed_at'),
    respondedAt: text('responded_at'),
    expiresOn: text('expires_on'),
    convertedInvoiceId: text('converted_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('proposals_user_status_idx').on(t.userId, t.status),
    index('proposals_campaign_idx').on(t.campaignId),
    uniqueIndex('proposals_public_token_idx').on(t.publicToken),
  ],
);


/* ------------------------------------------------------------------ */
/* AI observability                                                    */
/* ------------------------------------------------------------------ */

/**
 * One row per model call.
 *
 * A pipeline that makes dozens of model calls per run, unattended, is
 * otherwise a black box with a bill attached. This records what was asked,
 * what it cost, how long it took and whether it was served from cache — by
 * stage and by operation, so an expensive stage is visible rather than
 * inferred.
 *
 * Prompts and responses are deliberately NOT stored: they contain crawled
 * third-party content, and the useful questions here are all about shape and
 * cost rather than text. A truncated prompt digest is kept for grouping.
 */
export const aiCalls = sqliteTable(
  'ai_calls',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    prospectId: text('prospect_id'),

    /** Which pipeline stage asked. */
    stage: text('stage').notNull().default(''),
    /** What it was asked for: qualify, shortlist, plan, proposal, brief. */
    operation: text('operation').notNull().default(''),
    model: text('model').notNull().default(''),

    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    /**
     * True when the counts came from the provider rather than being estimated
     * from character length. An estimate is useful; pretending it is a
     * measurement is not.
     */
    tokensMeasured: integer('tokens_measured', { mode: 'boolean' }).notNull().default(false),

    /** Estimated cost in millionths of a cent, to stay in integers. */
    costMicrocents: integer('cost_microcents').notNull().default(0),
    /** Whether the model's price is confirmed or a placeholder. */
    costConfident: integer('cost_confident', { mode: 'boolean' }).notNull().default(false),

    durationMs: integer('duration_ms').notNull().default(0),
    /** Served from the prompt cache, so it cost nothing and took no time. */
    cached: integer('cached', { mode: 'boolean' }).notNull().default(false),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    error: text('error').notNull().default(''),
    /** SHA-256 prefix of the request, for grouping repeats. */
    requestHash: text('request_hash').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_calls_user_idx').on(t.userId, t.createdAt),
    index('ai_calls_campaign_idx').on(t.campaignId),
    index('ai_calls_operation_idx').on(t.userId, t.operation),
  ],
);

/**
 * The prompt cache.
 *
 * Runs repeat themselves constantly — the same shortlist re-run after a
 * change, the same brief adapted for the same trade, a stage retried after a
 * failure downstream. Keyed on everything that affects the answer, so a
 * changed prompt or temperature is a different entry rather than a stale hit.
 *
 * In D1 rather than KV so it needs no binding anyone has to create first.
 */
export const aiCache = sqliteTable(
  'ai_cache',
  {
    /** SHA-256 of model, system, prompt and parameters. */
    hash: text('hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    model: text('model').notNull().default(''),
    operation: text('operation').notNull().default(''),
    response: text('response').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    hits: integer('hits').notNull().default(0),
    lastHitAt: text('last_hit_at'),
    expiresAt: text('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_cache_expiry_idx').on(t.expiresAt)],
);

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: id(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull().default(''),
    entityId: text('entity_id').notNull().default(''),
    detail: text('detail').notNull().default('{}'),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [index('activity_user_idx').on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginToken = typeof loginTokens.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Communication = typeof communications.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type DepreciationEntry = typeof depreciationEntries.$inferSelect;
export type IncomeSource = typeof incomeSources.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type Prospect = typeof prospects.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignEvent = typeof campaignEvents.$inferSelect;
export type BrandKit = typeof brandKits.$inferSelect;
export type BrandAsset = typeof brandAssets.$inferSelect;
export type ProspectArtifact = typeof prospectArtifacts.$inferSelect;
export type DesignPlan = typeof designPlans.$inferSelect;
export type DemoSite = typeof demoSites.$inferSelect;
export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type AiCall = typeof aiCalls.$inferSelect;
export type AiCacheEntry = typeof aiCache.$inferSelect;
