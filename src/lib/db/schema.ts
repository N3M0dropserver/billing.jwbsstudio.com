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

  /** Quotes have their own series — see proposals.number for why. */
  quoteNumberPrefix: text('quote_number_prefix').notNull().default('QUO-'),
  quoteNextNumber: integer('quote_next_number').notNull().default(1),
  /** Days a quote stays open before it lapses. */
  quoteValidDays: integer('quote_valid_days').notNull().default(30),

  bankAccountName: text('bank_account_name').notNull().default(''),
  bankAccountNumber: text('bank_account_number').notNull().default(''),
  bankName: text('bank_name').notNull().default(''),
  bankBsb: text('bank_bsb').notNull().default(''),
  bankSwift: text('bank_swift').notNull().default(''),

  stripeEnabled: integer('stripe_enabled', { mode: 'boolean' }).notNull().default(false),

  /** Share of each payment to move into the tax account, as a decimal. */
  taxReserveRate: real('tax_reserve_rate').notNull().default(0.33),

  /* ---------------- Automatic payment reminders ---------------- */

  /**
   * Off until you turn it on. Sending mail to clients on a schedule is not
   * something software should start doing on your behalf because it was
   * deployed.
   */
  remindersEnabled: integer('reminders_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Days before the due date to send a courtesy note. 0 disables it. */
  reminderDaysBefore: integer('reminder_days_before').notNull().default(3),
  /**
   * Days AFTER the due date to chase, as a JSON array. The default ladder is
   * a week, a fortnight, then a month: enough to be useful, not so much that
   * a client stops reading them.
   */
  reminderDaysAfter: text('reminder_days_after').notNull().default('[7,14,30]'),
  /** Hard ceiling on reminders per invoice, whatever the ladder says. */
  reminderMaxCount: integer('reminder_max_count').notNull().default(4),
  /** Skip weekends. A Saturday chase reads as automated, because it is. */
  reminderSkipWeekends: integer('reminder_skip_weekends', { mode: 'boolean' })
    .notNull()
    .default(true),

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
    /**
     * Some clients are chased by their own accounts payable calendar and a
     * reminder only irritates them. Per-client opt-out, on by default.
     */
    remindersEnabled: integer('reminders_enabled', { mode: 'boolean' }).notNull().default(true),
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
    /**
     * Which rung of the ladder was last sent, e.g. `before-3` or `after-14`.
     * Recorded so a sweep that runs twice in a day, or after a gap, does not
     * send the same reminder again — the day count alone cannot tell you
     * whether you already chased on day 7.
     */
    lastReminderStage: text('last_reminder_stage'),
    /** Stop chasing this one specifically — a payment plan, a dispute. */
    remindersPaused: integer('reminders_paused', { mode: 'boolean' }).notNull().default(false),

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
    /** Rate converting this payment into the tax-residence currency. */
    fxRateToResidence: real('fx_rate_to_residence').notNull().default(1),
    reference: text('reference').notNull().default(''),
    stripeChargeId: text('stripe_charge_id'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_user_date_idx').on(t.userId, t.receivedOn),
    /**
     * A Stripe charge settles exactly once. `recordPayment` checks for the id
     * before inserting, but that is a read followed by a write: one card
     * payment fires both `checkout.session.completed` and
     * `payment_intent.succeeded`, and Stripe retries on any non-2xx, so two
     * deliveries can race, both read "not found", and both credit the
     * invoice. The database is the only place that can settle it.
     *
     * SQLite treats NULLs as distinct in a unique index, so the many payments
     * with no charge id — bank transfers, cash — are unaffected.
     */
    uniqueIndex('payments_stripe_charge_idx').on(t.stripeChargeId),
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
    /**
     * Rate converting this expense into the tax-residence currency, as it
     * stood when the money was spent. Same reasoning as on an invoice: the
     * rate on the day is the one the return uses, so it is stored rather
     * than looked up later.
     */
    fxRateToResidence: real('fx_rate_to_residence').notNull().default(1),

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
    /**
     * What the vision model read off the receipt, as JSON, alongside what was
     * actually saved. Kept so a figure that turns out wrong can be traced to
     * a misread rather than a typo — and so the picture, the reading and the
     * record stay together for as long as the records must be retained.
     */
    receiptExtraction: text('receipt_extraction'),
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
    /**
     * The period the income was actually earned over, inclusive. This is what
     * makes part-time or seasonal work usable: the NZ tax year (1 Apr-31 Mar)
     * and the AU financial year (1 Jul-30 Jun) do not line up, so a period of
     * work is apportioned across whichever years it overlaps rather than
     * being dumped whole into one label. Null on rows created before periods
     * existed, which fall back to the whole of `taxYear`.
     */
    earnedFrom: text('earned_from'),
    earnedTo: text('earned_to'),
    /** Gross amount before any withholding, in `currency`. */
    grossAmount: integer('gross_amount').notNull().default(0),
    /** PAYE (NZ) or PAYG withholding (AU) already taken, in `currency`. */
    taxWithheld: integer('tax_withheld').notNull().default(0),
    /** ACC earner levy collected through PAYE, NZ employment only. */
    accLevyWithheld: integer('acc_levy_withheld').notNull().default(0),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    /**
     * Rate that converts `currency` into the tax-residence currency. Stored
     * per row because the rate at the time of the pay period is what the
     * return uses, not today's rate. 1 when the two currencies are the same.
     */
    fxRateToResidence: real('fx_rate_to_residence').notNull().default(1),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('income_sources_user_year_idx').on(t.userId, t.taxYear),
    index('income_sources_user_period_idx').on(t.userId, t.earnedFrom),
  ],
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
/* Bank statements                                                     */
/* ------------------------------------------------------------------ */

/**
 * Transactions imported from a bank CSV.
 *
 * Kept as their own records rather than turned straight into payments,
 * because most lines on a statement are not payments at all and the ones that
 * are still need a person to agree which invoice they settle. A row here is
 * evidence; a payment is a decision.
 */
export const bankTransactions = sqliteTable(
  'bank_transactions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** What the user called this import, e.g. "ASB business — March". */
    source: text('source').notNull().default(''),
    /** ISO date of the transaction, as the bank stated it. */
    occurredOn: text('occurred_on').notNull(),
    /** Signed cents. Positive is money in. */
    amount: integer('amount').notNull(),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),
    description: text('description').notNull().default(''),
    reference: text('reference').notNull().default(''),

    /**
     * Stable identity within this account, so re-importing an overlapping
     * statement updates rather than duplicates. See src/lib/bank/csv.ts.
     */
    fingerprint: text('fingerprint').notNull(),

    status: text('status', { enum: ['unmatched', 'matched', 'ignored'] })
      .notNull()
      .default('unmatched'),
    matchedInvoiceId: text('matched_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    matchedPaymentId: text('matched_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    /** Why it was matched, kept so a wrong match can be understood later. */
    matchReason: text('match_reason').notNull().default(''),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One row per transaction per account, enforced rather than hoped for.
    uniqueIndex('bank_tx_fingerprint_idx').on(t.userId, t.fingerprint),
    index('bank_tx_user_status_idx').on(t.userId, t.status),
    index('bank_tx_user_date_idx').on(t.userId, t.occurredOn),
  ],
);

export type BankTransaction = typeof bankTransactions.$inferSelect;

/* ------------------------------------------------------------------ */
/* Proposals and prospecting                                           */
/* ------------------------------------------------------------------ */

export const proposals = sqliteTable(
  'proposals',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),
    prospectId: text('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    status: text('status', {
      enum: ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'],
    })
      .notNull()
      .default('draft'),
    body: text('body').notNull().default(''),
    /** Quoted amount, excluding GST. */
    amount: integer('amount').notNull().default(0),
    currency: text('currency', { enum: ['NZD', 'AUD'] }).notNull().default('NZD'),

    /** Subdomain the generated mockup was published to, if any. */
    mockupSubdomain: text('mockup_subdomain'),
    mockupKey: text('mockup_key'),

    publicToken: text('public_token'),
    sentAt: text('sent_at'),
    viewedAt: text('viewed_at'),
    respondedAt: text('responded_at'),
    expiresOn: text('expires_on'),
    convertedInvoiceId: text('converted_invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),

    /* ---------------- Quoting ---------------- */

    /**
     * Its own number series, separate from invoices. A quote is not an
     * invoice and must not consume an invoice number — a gap in the invoice
     * sequence is the first thing an auditor asks about, and every quote that
     * was never accepted would leave one.
     */
    number: text('number').notNull().default(''),

    /** Priced the same way an invoice is, through the same GST engine. */
    jurisdiction: text('jurisdiction', { enum: ['NZ', 'AU'] }).notNull().default('NZ'),
    gstTreatment: text('gst_treatment', {
      enum: ['standard', 'zero-rated-export', 'exempt', 'not-registered'],
    })
      .notNull()
      .default('standard'),
    subtotal: integer('subtotal').notNull().default(0),
    gstAmount: integer('gst_amount').notNull().default(0),
    total: integer('total').notNull().default(0),
    fxRateToResidence: real('fx_rate_to_residence').notNull().default(1),

    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    terms: text('terms').notNull().default(''),

    /**
     * Who accepted it and from where. A quote accepted in a browser is the
     * agreement the invoice rests on, so the record of that acceptance is
     * worth as much as the figures.
     */
    acceptedName: text('accepted_name').notNull().default(''),
    acceptedIp: text('accepted_ip'),
    declineReason: text('decline_reason').notNull().default(''),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('proposals_user_status_idx').on(t.userId, t.status),
    uniqueIndex('proposals_public_token_idx').on(t.publicToken),
  ],
);

/** Line items on a quote. Mirrors invoice_lines so conversion is a copy. */
export const proposalLines = sqliteTable(
  'proposal_lines',
  {
    id: id(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    description: text('description').notNull(),
    /** Thousandths, as on an invoice. 1500 == 1.5 */
    quantity: integer('quantity').notNull().default(1000),
    unit: text('unit').notNull().default('hours'),
    unitPrice: integer('unit_price').notNull().default(0),
    discount: real('discount').notNull().default(0),
    lineTotal: integer('line_total').notNull().default(0),
    taxable: integer('taxable', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('proposal_lines_proposal_idx').on(t.proposalId, t.position)],
);

export type ProposalLine = typeof proposalLines.$inferSelect;

/**
 * Businesses surfaced by the AI prospecting mode — a niche in a region with
 * a weak or absent web presence.
 */
export const prospects = sqliteTable(
  'prospects',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    searchId: text('search_id').references(() => prospectSearches.id, { onDelete: 'set null' }),

    businessName: text('business_name').notNull(),
    niche: text('niche').notNull().default(''),
    region: text('region').notNull().default(''),
    country: text('country').notNull().default('NZ'),

    website: text('website').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    address: text('address').notNull().default(''),
    mapsUrl: text('maps_url').notNull().default(''),
    socialLinks: text('social_links').notNull().default('[]'),

    /** Why this one is worth approaching. */
    signal: text('signal', {
      enum: ['no-website', 'dated-website', 'no-google-presence', 'maps-only', 'poor-mobile', 'other'],
    })
      .notNull()
      .default('other'),
    /** 0..100, how good a fit this looks. */
    score: integer('score').notNull().default(0),
    findings: text('findings').notNull().default('{}'),

    status: text('status', {
      enum: ['new', 'qualified', 'contacted', 'responded', 'converted', 'rejected'],
    })
      .notNull()
      .default('new'),
    convertedClientId: text('converted_client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('prospects_user_status_idx').on(t.userId, t.status),
    index('prospects_score_idx').on(t.userId, t.score),
  ],
);

export const prospectSearches = sqliteTable(
  'prospect_searches',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    niche: text('niche').notNull(),
    region: text('region').notNull(),
    country: text('country').notNull().default('NZ'),
    /** Which of the saved reference styles to base mockups on. */
    styleRepertoireId: text('style_repertoire_id'),
    status: text('status', { enum: ['queued', 'running', 'complete', 'failed'] })
      .notNull()
      .default('queued'),
    resultCount: integer('result_count').notNull().default(0),
    error: text('error').notNull().default(''),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('prospect_searches_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Reference sites and brand directions the AI uses as a basis for generated
 * mockups, plus the editable prompt that drives the generation.
 */
export const styleRepertoire = sqliteTable(
  'style_repertoire',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    referenceUrls: text('reference_urls').notNull().default('[]'),
    /** The editable instruction block sent to the model. */
    prompt: text('prompt').notNull().default(''),
    suitableFor: text('suitable_for').notNull().default(''),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('style_repertoire_user_idx').on(t.userId)],
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

/* ------------------------------------------------------------------ */
/* Email templates and send tracking                                   */
/* ------------------------------------------------------------------ */

/**
 * A reusable outbound email, authored in the editor at /templates.
 *
 * Three representations of the same document are stored together because each
 * is needed at a different moment and none can be cheaply derived from the
 * others inside a Worker:
 *
 *   doc   Tiptap JSON. The source of truth, and the only thing the editor can
 *         reload without losing structure.
 *   html  Rendered by the editor in the browser at save time. What is mailed.
 *   text  The plain-text alternative, for clients that refuse HTML.
 *
 * The Worker never runs React Email — rendering happens client-side, so the
 * editor and its Tiptap dependencies stay out of the Worker bundle entirely.
 *
 * Bodies here contain {{variable}} tokens, substituted at send time by
 * ~/lib/mail/render. The sign-in email is deliberately NOT templatable: a
 * malformed template there would lock you out of the app.
 */
export const emailTemplates = sqliteTable(
  'email_templates',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    kind: text('kind', { enum: ['invoice', 'reminder', 'proposal', 'general'] })
      .notNull()
      .default('general'),

    subject: text('subject').notNull().default(''),
    doc: text('doc').notNull().default('{}'),
    html: text('html').notNull().default(''),
    text: text('text').notNull().default(''),

    /** Pre-selected for its kind on the send form. At most one per kind. */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    /** Soft delete, so templates referenced by past sends stay resolvable. */
    archivedAt: text('archived_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('email_templates_user_kind_idx').on(t.userId, t.kind),
    index('email_templates_default_idx').on(t.userId, t.kind, t.isDefault),
  ],
);

/**
 * One row per message that left the building.
 *
 * Carries the open-tracking state. Read the counts with suspicion: Apple Mail
 * Privacy Protection prefetches every image whether or not the message was
 * read, and Gmail proxies and caches images so repeat opens often go
 * unrecorded and the IP belongs to Google rather than the recipient. Blocked
 * images mean a genuine open records nothing at all.
 *
 * Which is why this NEVER drives invoice status. The hard signal is the client
 * loading /pay/<token>, which stamps invoices.viewed_at — see
 * src/pages/pay/[token].astro. Pixel opens are supporting colour beside it.
 */
export const emailSends = sqliteTable(
  'email_sends',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    entityType: text('entity_type', { enum: ['invoice', 'proposal', 'client', 'test'] })
      .notNull()
      .default('invoice'),
    entityId: text('entity_id').notNull().default(''),
    /** Null once the template is deleted; the send still stands on its own. */
    templateId: text('template_id').references(() => emailTemplates.id, { onDelete: 'set null' }),

    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull().default(''),

    /** Random, unguessable. Addresses the tracking pixel at /e/<token>.gif. */
    token: text('token').notNull(),

    provider: text('provider').notNull().default(''),
    providerMessageId: text('provider_message_id'),

    sentAt: text('sent_at').notNull(),
    firstOpenedAt: text('first_opened_at'),
    lastOpenedAt: text('last_opened_at'),
    openCount: integer('open_count').notNull().default(0),
    openUserAgent: text('open_user_agent'),
    openIp: text('open_ip'),
    /**
     * The first hit looked like a scanner rather than a person — it arrived
     * within seconds of sending, or the user agent is a known prefetcher.
     */
    likelyPrefetch: integer('likely_prefetch', { mode: 'boolean' }).notNull().default(false),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('email_sends_token_idx').on(t.token),
    index('email_sends_entity_idx').on(t.entityType, t.entityId),
    index('email_sends_user_idx').on(t.userId, t.sentAt),
  ],
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
export type ProspectSearch = typeof prospectSearches.$inferSelect;
export type StyleRepertoire = typeof styleRepertoire.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type EmailSend = typeof emailSends.$inferSelect;
