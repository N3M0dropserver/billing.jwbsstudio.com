/**
 * Versioned statutory rate tables for New Zealand and Australia.
 *
 * ------------------------------------------------------------------
 * HOW TO MAINTAIN THIS FILE
 * ------------------------------------------------------------------
 * Every rate here has a `source` and a `confidence`. When a new tax year
 * starts, ADD a new entry — never edit an old one. Prior-year figures are
 * needed to recalculate old returns, amend assessments, and compute
 * provisional/PAYG uplift from a prior year's liability.
 *
 * Figures marked `confidence: 'verify'` were assembled from secondary
 * sources and MUST be confirmed against the IRD/ATO page cited before you
 * rely on them for a filing. The app surfaces these to the user rather
 * than hiding them.
 *
 * Note on derived figures: cumulative bracket bases (the "$4,288 plus 30c
 * for each $1 over $45,000" style numbers the ATO publishes) are NOT stored
 * here. They are computed from the thresholds in `progressiveTax()`. Storing
 * them invites transcription errors and they are pure arithmetic anyway.
 *
 * All money values are in CENTS.
 */

import type { Cents } from './money';

export type Jurisdiction = 'NZ' | 'AU';
export type Confidence = 'confirmed' | 'verify';

export interface Bracket {
  /** Income above this amount (in cents) is taxed at `rate`. */
  from: Cents;
  /** Marginal rate as a decimal, e.g. 0.175 for 17.5%. */
  rate: number;
}

export interface SourcedValue<T> {
  value: T;
  source: string;
  confidence: Confidence;
  note?: string;
}

function sourced<T>(
  value: T,
  source: string,
  confidence: Confidence = 'confirmed',
  note?: string,
): SourcedValue<T> {
  return { value, source, confidence, note };
}

const $ = (dollars: number): Cents => Math.round(dollars * 100);

/* ------------------------------------------------------------------ */
/* New Zealand                                                         */
/* ------------------------------------------------------------------ */

export interface NzRates {
  /** Tax year label, e.g. "2026-27" for the year ended 31 March 2027. */
  year: string;
  startsOn: string;
  endsOn: string;

  incomeTax: SourcedValue<Bracket[]>;

  acc: {
    /**
     * Earner levy rate applied through PAYE on salary/wages. This published
     * rate is GST-INCLUSIVE.
     */
    earnerLevyRatePaye: SourcedValue<number>;
    /**
     * Earner levy rate used on an ACC invoice to a self-employed person.
     * ACC bills self-employed levies GST-EXCLUSIVE and adds GST on top, so
     * this is the PAYE rate divided by 1.15. If you are GST registered the
     * GST portion is claimable, so the real cost to you is this rate.
     */
    earnerLevyRateExGst: SourcedValue<number>;
    /** Earner levy stops applying above this level of liable earnings. */
    maxLiableEarnings: SourcedValue<Cents>;
    /**
     * Work levy for a self-employed person on standard CoverPlus. This is
     * set by your ACC classification unit (CU) and varies a lot by trade —
     * the default here is the scheme average, NOT your rate. Override it in
     * Settings with the rate from your own ACC invoice.
     */
    defaultWorkLevyRateExGst: SourcedValue<number>;
    /** Working Safer levy (funds WorkSafe NZ), per dollar of liable earnings. */
    workingSaferLevyRateExGst: SourcedValue<number>;
    /** Minimum liable earnings ACC applies to a full-time self-employed person. */
    minLiableEarningsFullTime: SourcedValue<Cents>;
  };

  studentLoan: {
    annualThreshold: SourcedValue<Cents>;
    rate: SourcedValue<number>;
    /**
     * Self-employed/other income under this amount does not trigger an
     * end-of-year repayment obligation on its own.
     */
    adjustedNetIncomeDeMinimis: SourcedValue<Cents>;
  };

  gst: {
    rate: SourcedValue<number>;
    registrationThreshold: SourcedValue<Cents>;
  };

  provisionalTax: {
    /** Residual income tax above this triggers provisional tax next year. */
    threshold: SourcedValue<Cents>;
    /** Standard option: prior-year RIT uplifted by this factor. */
    standardUpliftPriorYear: SourcedValue<number>;
    /** Standard option fallback: RIT from two years ago, uplifted. */
    standardUpliftTwoYearsAgo: SourcedValue<number>;
  };

  deductions: {
    /** Square metre rate for the home office (utilities portion only). */
    homeOfficeSquareMetreRate: SourcedValue<Cents>;
    /** Tier 1 covers fixed + running costs, first 14,000 km of total travel. */
    vehicleTier1RatePerKm: SourcedValue<Record<VehicleType, Cents>>;
    /** Tier 2 covers running costs only, for travel beyond 14,000 km. */
    vehicleTier2RatePerKm: SourcedValue<Record<VehicleType, Cents>>;
    vehicleTier1KmCap: SourcedValue<number>;
    /** Assets at or below this cost are deducted in full in year one. */
    lowValueAssetThreshold: SourcedValue<Cents>;
  };
}

export type VehicleType = 'petrol' | 'diesel' | 'hybrid' | 'electric';

const IRD_RATES = 'https://www.ird.govt.nz/income-tax/income-tax-for-individuals/tax-codes-and-tax-rates-for-individuals/tax-rates-for-individuals';
const IRD_KM = 'https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/claiming-vehicle-expenses/kilometre-rates-2025-2026';
const IRD_PROV = 'https://www.ird.govt.nz/income-tax/provisional-tax/provisional-tax-options/standard-option';
const IRD_SL = 'https://www.ird.govt.nz/student-loans/living-in-new-zealand-with-a-student-loan/repaying-my-student-loan-when-i-am-self-employed-or-earn-other-income';
const ACC_LEVIES = 'https://www.acc.co.nz/for-business/understanding-levies-if-you-work-or-own-a-business/';

/**
 * NZ income tax brackets have been unchanged since the 31 July 2024 change
 * and apply for both years below.
 */
const NZ_BRACKETS: Bracket[] = [
  { from: $(0), rate: 0.105 },
  { from: $(15_600), rate: 0.175 },
  { from: $(53_500), rate: 0.30 },
  { from: $(78_100), rate: 0.33 },
  { from: $(180_000), rate: 0.39 },
];

const NZ_COMMON = {
  studentLoan: {
    annualThreshold: sourced($(24_128), IRD_SL),
    rate: sourced(0.12, IRD_SL),
    adjustedNetIncomeDeMinimis: sourced($(500), IRD_SL),
  },
  gst: {
    rate: sourced(0.15, 'https://www.ird.govt.nz/gst'),
    registrationThreshold: sourced(
      $(60_000),
      'https://www.ird.govt.nz/gst/registering-for-gst',
      'confirmed',
      'Turnover in any 12-month period, past or projected — not a financial-year test.',
    ),
  },
  provisionalTax: {
    threshold: sourced($(5_000), IRD_PROV),
    standardUpliftPriorYear: sourced(1.05, IRD_PROV),
    standardUpliftTwoYearsAgo: sourced(1.10, IRD_PROV),
  },
} as const;

export const NZ_RATES: Record<string, NzRates> = {
  '2025-26': {
    year: '2025-26',
    startsOn: '2025-04-01',
    endsOn: '2026-03-31',
    incomeTax: sourced(NZ_BRACKETS, IRD_RATES),
    acc: {
      earnerLevyRatePaye: sourced(0.0167, ACC_LEVIES),
      earnerLevyRateExGst: sourced(0.0145, ACC_LEVIES, 'verify', 'Derived as the PAYE rate / 1.15.'),
      maxLiableEarnings: sourced($(152_790), ACC_LEVIES),
      defaultWorkLevyRateExGst: sourced(
        0.0066,
        ACC_LEVIES,
        'verify',
        'Scheme average, not your classification unit. Replace with the rate on your ACC invoice.',
      ),
      workingSaferLevyRateExGst: sourced(0.0008, ACC_LEVIES),
      minLiableEarningsFullTime: sourced($(49_365), ACC_LEVIES, 'verify'),
    },
    ...NZ_COMMON,
    deductions: {
      homeOfficeSquareMetreRate: sourced(
        $(57.30),
        'https://www.ird.govt.nz/updates/news-folder/2025/square-metre-rate-for-home-office-calculations-2025',
        'confirmed',
        'Covers utilities only. Rent, rates, mortgage interest and insurance are claimed separately on floor-area percentage.',
      ),
      vehicleTier1RatePerKm: sourced(
        { petrol: $(1.20), diesel: $(1.30), hybrid: $(0.90), electric: $(1.22) },
        IRD_KM,
      ),
      vehicleTier2RatePerKm: sourced(
        { petrol: $(0.37), diesel: $(0.38), hybrid: $(0.24), electric: $(0.23) },
        IRD_KM,
      ),
      vehicleTier1KmCap: sourced(14_000, IRD_KM),
      lowValueAssetThreshold: sourced(
        $(1_000),
        'https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/depreciation',
        'confirmed',
        'GST-exclusive if you are GST registered. Items bought together from one supplier with the same depreciation rate may count as one asset.',
      ),
    },
  },

  '2026-27': {
    year: '2026-27',
    startsOn: '2026-04-01',
    endsOn: '2027-03-31',
    incomeTax: sourced(NZ_BRACKETS, IRD_RATES, 'confirmed', 'Thresholds unchanged from 2025-26.'),
    acc: {
      earnerLevyRatePaye: sourced(0.0175, ACC_LEVIES),
      earnerLevyRateExGst: sourced(0.0152, ACC_LEVIES),
      maxLiableEarnings: sourced($(156_641), ACC_LEVIES),
      defaultWorkLevyRateExGst: sourced(
        0.0066,
        ACC_LEVIES,
        'verify',
        'Scheme average, not your classification unit. Replace with the rate on your ACC invoice.',
      ),
      workingSaferLevyRateExGst: sourced(0.0008, ACC_LEVIES),
      minLiableEarningsFullTime: sourced($(50_549), ACC_LEVIES, 'verify'),
    },
    ...NZ_COMMON,
    deductions: {
      homeOfficeSquareMetreRate: sourced(
        $(57.30),
        'https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/using-your-home-for-your-business',
        'verify',
        'IRD sets this annually after the year ends; 2025-26 rate carried forward until published.',
      ),
      vehicleTier1RatePerKm: sourced(
        { petrol: $(1.20), diesel: $(1.30), hybrid: $(0.90), electric: $(1.22) },
        IRD_KM,
        'verify',
        '2025-26 rates carried forward until IRD publishes the 2026-27 operational statement.',
      ),
      vehicleTier2RatePerKm: sourced(
        { petrol: $(0.37), diesel: $(0.38), hybrid: $(0.24), electric: $(0.23) },
        IRD_KM,
        'verify',
      ),
      vehicleTier1KmCap: sourced(14_000, IRD_KM),
      lowValueAssetThreshold: sourced($(1_000), 'https://www.ird.govt.nz/'),
    },
  },
};

/* ------------------------------------------------------------------ */
/* Australia                                                           */
/* ------------------------------------------------------------------ */

export interface AuRates {
  /** Financial year label, e.g. "2026-27" for the year ended 30 June 2027. */
  year: string;
  startsOn: string;
  endsOn: string;

  incomeTax: SourcedValue<Bracket[]>;

  medicareLevy: {
    rate: SourcedValue<number>;
    /** Below this taxable income, no levy is payable (single, no dependants). */
    lowIncomeThresholdSingle: SourcedValue<Cents>;
    /**
     * Shade-in rate: between the lower threshold and the point where the
     * full levy applies, the levy is this share of income over the
     * threshold. The upper threshold is derived, not stored.
     */
    shadeInRate: SourcedValue<number>;
    seniorLowIncomeThreshold: SourcedValue<Cents>;
  };

  help: {
    /** Marginal repayment brackets, applied to repayment income. */
    brackets: SourcedValue<Bracket[]>;
    /**
     * At or above this repayment income, the repayment is a flat share of
     * TOTAL repayment income rather than a marginal calculation.
     */
    flatRateFloor: SourcedValue<Cents>;
    flatRate: SourcedValue<number>;
  };

  gst: {
    rate: SourcedValue<number>;
    registrationThreshold: SourcedValue<Cents>;
  };

  paygInstalments: {
    /** Both conditions must be met to be entered into the PAYG system. */
    instalmentIncomeThreshold: SourcedValue<Cents>;
    taxPayableThreshold: SourcedValue<Cents>;
  };

  deductions: {
    /** Working-from-home fixed rate, per hour worked from home. */
    workFromHomeRatePerHour: SourcedValue<Cents>;
    /** Cents-per-kilometre method rate. */
    vehicleRatePerKm: SourcedValue<Cents>;
    /** Cents-per-km method is capped at this many business kilometres. */
    vehicleKmCap: SourcedValue<number>;
    /** Instant asset write-off limit, per asset. */
    instantAssetWriteOff: SourcedValue<Cents>;
    instantAssetWriteOffTurnoverCap: SourcedValue<Cents>;
  };

  super: {
    concessionalCap: SourcedValue<Cents>;
    /** Carry-forward of unused cap is only available below this balance. */
    carryForwardBalanceLimit: SourcedValue<Cents>;
  };
}

const ATO_RATES = 'https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents';
const ATO_MEDICARE = 'https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners';
const ATO_GST = 'https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst';
const ATO_PAYG = 'https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/payg-instalments/starting-payg-instalments';
const ATO_WFH = 'https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/fixed-rate-method';
const ATO_KM = 'https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/income-and-deductions-for-business/deductions/deductions-for-motor-vehicle-expenses/cents-per-kilometre-method';
const ATO_IAWO = 'https://www.ato.gov.au/businesses-and-organisations/small-business-newsroom/20000-instant-asset-write-off-for-2025-26';
const ATO_HELP = 'https://www.ato.gov.au/tax-rates-and-codes';

const AU_COMMON = {
  gst: {
    rate: sourced(0.10, ATO_GST),
    registrationThreshold: sourced(
      $(75_000),
      ATO_GST,
      'confirmed',
      'GST turnover over any 12 months. You must register within 21 days of crossing it.',
    ),
  },
  paygInstalments: {
    instalmentIncomeThreshold: sourced($(4_000), ATO_PAYG),
    taxPayableThreshold: sourced($(1_000), ATO_PAYG),
  },
  super: {
    concessionalCap: sourced($(30_000), 'https://www.ato.gov.au/individuals-and-families/super-for-individuals-and-families/super/growing-your-super/caps-limits-and-tax-on-super-contributions'),
    carryForwardBalanceLimit: sourced($(500_000), 'https://www.ato.gov.au/individuals-and-families/super-for-individuals-and-families/super/growing-your-super/caps-limits-and-tax-on-super-contributions'),
  },
} as const;

export const AU_RATES: Record<string, AuRates> = {
  '2025-26': {
    year: '2025-26',
    startsOn: '2025-07-01',
    endsOn: '2026-06-30',
    incomeTax: sourced(
      [
        { from: $(0), rate: 0 },
        { from: $(18_200), rate: 0.16 },
        { from: $(45_000), rate: 0.30 },
        { from: $(135_000), rate: 0.37 },
        { from: $(190_000), rate: 0.45 },
      ],
      ATO_RATES,
    ),
    medicareLevy: {
      rate: sourced(0.02, ATO_MEDICARE),
      lowIncomeThresholdSingle: sourced(
        $(28_011),
        ATO_MEDICARE,
        'verify',
        'Raised from $27,222 and applied retrospectively to 1 July 2025.',
      ),
      shadeInRate: sourced(0.10, ATO_MEDICARE),
      seniorLowIncomeThreshold: sourced($(44_242), ATO_MEDICARE, 'verify'),
    },
    help: {
      brackets: sourced(
        [
          { from: $(0), rate: 0 },
          { from: $(67_000), rate: 0.15 },
          { from: $(125_000), rate: 0.17 },
        ],
        ATO_HELP,
        'confirmed',
        'Marginal from 1 July 2025; the old 19-tier whole-of-income system is gone.',
      ),
      flatRateFloor: sourced($(179_286), ATO_HELP, 'verify'),
      flatRate: sourced(0.10, ATO_HELP, 'verify'),
    },
    ...AU_COMMON,
    deductions: {
      workFromHomeRatePerHour: sourced(
        $(0.70),
        ATO_WFH,
        'confirmed',
        'Covers energy, internet, phone, stationery and consumables. You cannot also claim those separately.',
      ),
      vehicleRatePerKm: sourced($(0.88), ATO_KM),
      vehicleKmCap: sourced(5_000, ATO_KM, 'confirmed', 'Beyond 5,000 business km you must use the logbook method.'),
      instantAssetWriteOff: sourced($(20_000), ATO_IAWO),
      instantAssetWriteOffTurnoverCap: sourced($(10_000_000), ATO_IAWO),
    },
  },

  '2026-27': {
    year: '2026-27',
    startsOn: '2026-07-01',
    endsOn: '2027-06-30',
    incomeTax: sourced(
      [
        { from: $(0), rate: 0 },
        { from: $(18_200), rate: 0.15 },
        { from: $(45_000), rate: 0.30 },
        { from: $(135_000), rate: 0.37 },
        { from: $(190_000), rate: 0.45 },
      ],
      ATO_RATES,
      'confirmed',
      'The 16% rate dropped to 15% from 1 July 2026. It drops again to 14% from 1 July 2027.',
    ),
    medicareLevy: {
      rate: sourced(0.02, ATO_MEDICARE),
      lowIncomeThresholdSingle: sourced(
        $(28_011),
        ATO_MEDICARE,
        'verify',
        '2025-26 threshold carried forward; indexed figures are announced at Budget.',
      ),
      shadeInRate: sourced(0.10, ATO_MEDICARE),
      seniorLowIncomeThreshold: sourced($(44_242), ATO_MEDICARE, 'verify'),
    },
    help: {
      brackets: sourced(
        [
          { from: $(0), rate: 0 },
          { from: $(69_528), rate: 0.15 },
          { from: $(129_717), rate: 0.17 },
        ],
        ATO_HELP,
        'verify',
        'Thresholds indexed ~3.8% for 2026-27; rates unchanged.',
      ),
      flatRateFloor: sourced($(186_051), ATO_HELP, 'verify'),
      flatRate: sourced(0.10, ATO_HELP, 'verify'),
    },
    ...AU_COMMON,
    deductions: {
      workFromHomeRatePerHour: sourced($(0.70), ATO_WFH, 'verify', '2025-26 rate carried forward.'),
      vehicleRatePerKm: sourced($(0.88), ATO_KM, 'verify', '2025-26 rate carried forward until the ATO publishes 2026-27.'),
      vehicleKmCap: sourced(5_000, ATO_KM),
      instantAssetWriteOff: sourced(
        $(20_000),
        ATO_IAWO,
        'verify',
        'The 2026-27 Budget proposed making $20,000 permanent from 1 July 2026, but that was not yet legislated as at the last check. If it lapses the limit reverts to $1,000.',
      ),
      instantAssetWriteOffTurnoverCap: sourced($(10_000_000), ATO_IAWO),
    },
  },
};

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

export const NZ_YEARS = Object.keys(NZ_RATES).sort();
export const AU_YEARS = Object.keys(AU_RATES).sort();

export function nzRates(year: string): NzRates {
  const r = NZ_RATES[year];
  if (!r) {
    throw new Error(
      `No NZ rate table for ${year}. Available: ${NZ_YEARS.join(', ')}. Add one to src/lib/tax/rates.ts.`,
    );
  }
  return r;
}

export function auRates(year: string): AuRates {
  const r = AU_RATES[year];
  if (!r) {
    throw new Error(
      `No AU rate table for ${year}. Available: ${AU_YEARS.join(', ')}. Add one to src/lib/tax/rates.ts.`,
    );
  }
  return r;
}

/** Every figure in a year's table that still needs confirming against the source. */
export function unverifiedFigures(jurisdiction: Jurisdiction, year: string): Array<{
  path: string;
  source: string;
  note?: string;
}> {
  const table: unknown = jurisdiction === 'NZ' ? nzRates(year) : auRates(year);
  const out: Array<{ path: string; source: string; note?: string }> = [];

  const walk = (node: unknown, path: string[]): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if ('confidence' in record && 'source' in record) {
      if (record.confidence === 'verify') {
        out.push({
          path: path.join('.'),
          source: String(record.source),
          note: record.note ? String(record.note) : undefined,
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      walk(child, [...path, key]);
    }
  };

  walk(table, []);
  return out;
}
