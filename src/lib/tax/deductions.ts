/**
 * Depreciation schedules and claimable-expense guidance.
 *
 * The guidance here is deliberately opinionated about the things that
 * actually catch out self-employed designers: entertainment limits, the
 * clothing rule, home office apportionment, and the difference between an
 * expense and a capital asset.
 */

import { type Cents, applyRate, atLeastZero } from './money';
import { nzRates, auRates, type Jurisdiction, type VehicleType } from './rates';

export type DepreciationMethod = 'DV' | 'SL';

export interface DepreciationInput {
  jurisdiction: Jurisdiction;
  year: string;
  /** Cost, GST-exclusive if you are GST registered. */
  cost: Cents;
  /** Annual depreciation rate as a decimal, e.g. 0.40 for 40%. */
  rate: number;
  method: DepreciationMethod;
  /** Share of use that is business, 0..1. */
  businessUsePercent: number;
  /** Accumulated depreciation already claimed in prior years. */
  openingAccumulated?: Cents;
  /** Months held in the first year, for pro-rating. Defaults to 12. */
  monthsHeld?: number;
  /** Aggregated turnover, for the AU instant asset write-off eligibility test. */
  turnover?: Cents;
}

export interface DepreciationResult {
  /** Whether the asset was written off in full rather than depreciated. */
  immediateWriteOff: boolean;
  writeOffReason?: string;
  openingAdjustedValue: Cents;
  depreciationForYear: Cents;
  /** The portion actually claimable after applying business use. */
  claimableForYear: Cents;
  closingAdjustedValue: Cents;
  notes: string[];
}

/**
 * One year of depreciation.
 *
 *   DV (diminishing value) — rate applied to the written-down value. Front
 *       loads the deduction. IRD's default and usually the better cashflow
 *       choice for equipment that loses value fast.
 *   SL (straight line) — rate applied to original cost every year.
 *
 * Both countries let you write an asset off immediately if it is cheap
 * enough, and those thresholds differ by two orders of magnitude: NZ$1,000
 * against AU$20,000.
 */
export function depreciateYear(input: DepreciationInput): DepreciationResult {
  const notes: string[] = [];
  const businessUse = Math.min(Math.max(input.businessUsePercent, 0), 1);
  const monthsHeld = Math.min(Math.max(input.monthsHeld ?? 12, 0), 12);
  const accumulated = input.openingAccumulated ?? 0;
  const openingAdjustedValue = atLeastZero(input.cost - accumulated);

  // Immediate write-off tests, applied only in the first year.
  if (accumulated === 0) {
    if (input.jurisdiction === 'NZ') {
      const threshold = nzRates(input.year).deductions.lowValueAssetThreshold.value;
      if (input.cost <= threshold) {
        return {
          immediateWriteOff: true,
          writeOffReason: `Cost is at or under the NZ$${threshold / 100} low-value asset threshold, so it is deducted in full this year instead of being depreciated.`,
          openingAdjustedValue,
          depreciationForYear: input.cost,
          claimableForYear: applyRate(input.cost, businessUse),
          closingAdjustedValue: 0,
          notes: [
            'Watch the "set" rule: items bought at the same time from the same supplier with the same depreciation rate can be treated as one asset, which can push you over the threshold.',
          ],
        };
      }
    } else {
      const rates = auRates(input.year).deductions;
      const threshold = rates.instantAssetWriteOff.value;
      const turnoverCap = rates.instantAssetWriteOffTurnoverCap.value;
      const turnoverOk = input.turnover === undefined || input.turnover < turnoverCap;
      if (input.cost < threshold && turnoverOk) {
        return {
          immediateWriteOff: true,
          writeOffReason: `Cost is under the AU$${threshold / 100 / 1000}k instant asset write-off limit, so the business portion is deducted in full this year.`,
          openingAdjustedValue,
          depreciationForYear: input.cost,
          claimableForYear: applyRate(input.cost, businessUse),
          closingAdjustedValue: 0,
          notes: [
            'The asset must be first used or installed ready for use within the income year.',
            rates.instantAssetWriteOff.note ?? '',
          ].filter(Boolean),
        };
      }
      if (input.cost >= threshold) {
        notes.push(
          `Over the AU$${threshold / 100 / 1000}k instant write-off limit, so this goes into the small business pool or is depreciated over its effective life.`,
        );
      }
    }
  }

  const base = input.method === 'DV' ? openingAdjustedValue : input.cost;
  let depreciationForYear = applyRate(base, input.rate);

  if (monthsHeld < 12) {
    depreciationForYear = Math.round((depreciationForYear * monthsHeld) / 12);
    notes.push(`Pro-rated for ${monthsHeld} month${monthsHeld === 1 ? '' : 's'} of ownership.`);
  }

  // Never depreciate below zero.
  depreciationForYear = Math.min(depreciationForYear, openingAdjustedValue);

  if (businessUse < 1) {
    notes.push(
      `Only ${Math.round(businessUse * 100)}% of the depreciation is claimable, matching business use. Keep the records that support that split.`,
    );
  }

  return {
    immediateWriteOff: false,
    openingAdjustedValue,
    depreciationForYear,
    claimableForYear: applyRate(depreciationForYear, businessUse),
    closingAdjustedValue: openingAdjustedValue - depreciationForYear,
    notes,
  };
}

export interface ScheduleRow {
  year: number;
  opening: Cents;
  depreciation: Cents;
  claimable: Cents;
  closing: Cents;
}

/** Project a full depreciation schedule until the asset is written down. */
export function depreciationSchedule(
  input: DepreciationInput,
  maxYears = 15,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let accumulated = input.openingAccumulated ?? 0;

  for (let year = 1; year <= maxYears; year++) {
    const result = depreciateYear({
      ...input,
      openingAccumulated: accumulated,
      monthsHeld: year === 1 ? input.monthsHeld : 12,
    });
    if (result.depreciationForYear <= 0) break;

    rows.push({
      year,
      opening: result.openingAdjustedValue,
      depreciation: result.depreciationForYear,
      claimable: result.claimableForYear,
      closing: result.closingAdjustedValue,
    });

    accumulated += result.depreciationForYear;
    if (result.immediateWriteOff || result.closingAdjustedValue <= 0) break;
    // DV never reaches exactly zero; stop once the remainder is trivial.
    if (result.closingAdjustedValue < 100) break;
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/* Home office                                                         */
/* ------------------------------------------------------------------ */

export interface HomeOfficeResult {
  method: string;
  claimable: Cents;
  breakdown: Array<{ label: string; amount: Cents }>;
  notes: string[];
}

/**
 * NZ square metre rate method.
 *
 * The square metre rate covers utilities ONLY. Rent, mortgage interest,
 * rates and house insurance are claimed separately on the floor-area
 * percentage. Missing that second half is the most common under-claim.
 */
export function nzHomeOffice(params: {
  year: string;
  businessAreaSqm: number;
  totalAreaSqm: number;
  annualPremisesCosts: Cents;
}): HomeOfficeResult {
  const rate = nzRates(params.year).deductions.homeOfficeSquareMetreRate.value;
  const utilities = Math.round(params.businessAreaSqm * rate);
  const proportion =
    params.totalAreaSqm > 0 ? params.businessAreaSqm / params.totalAreaSqm : 0;
  const premises = applyRate(params.annualPremisesCosts, proportion);

  return {
    method: 'Square metre rate',
    claimable: utilities + premises,
    breakdown: [
      { label: `Utilities — ${params.businessAreaSqm}m² at the square metre rate`, amount: utilities },
      {
        label: `Premises costs — ${(proportion * 100).toFixed(1)}% of rent, rates, interest and insurance`,
        amount: premises,
      },
    ],
    notes: [
      'The square metre rate replaces itemising power, gas and internet. Do not claim those separately as well.',
      'Premises costs are apportioned on floor area and claimed on top of the square metre rate.',
      'The space does not have to be a whole room, but it does have to be genuinely used for work.',
    ],
  };
}

/**
 * AU fixed-rate working-from-home method.
 *
 * 70c per hour covers energy, internet, phone, stationery and consumables.
 * Claiming any of those separately as well disqualifies the fixed rate.
 * A record of actual hours is required — an estimate is not enough.
 */
export function auWorkFromHome(params: {
  year: string;
  hoursWorkedFromHome: number;
}): HomeOfficeResult {
  const rate = auRates(params.year).deductions.workFromHomeRatePerHour.value;
  const claimable = Math.round(params.hoursWorkedFromHome * rate);
  return {
    method: 'Fixed rate (70c/hour)',
    claimable,
    breakdown: [
      { label: `${params.hoursWorkedFromHome} hours at the fixed rate`, amount: claimable },
    ],
    notes: [
      'Covers energy, internet, mobile and home phone, stationery and computer consumables. You cannot claim any of those separately on top.',
      'You must keep a record of the ACTUAL hours worked from home for the whole year — a four-week sample is no longer accepted.',
      'Depreciation on the desk, chair and computer is claimed separately and is not covered by the fixed rate.',
      'The actual cost method can give a larger deduction if your running costs are high, but it needs full receipts and an apportionment basis.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Vehicle                                                             */
/* ------------------------------------------------------------------ */

export interface VehicleResult {
  claimable: Cents;
  breakdown: Array<{ label: string; amount: Cents }>;
  notes: string[];
}

export function nzVehicleClaim(params: {
  year: string;
  vehicleType: VehicleType;
  businessKm: number;
  /** Total km driven including private, which determines the tier split. */
  totalKm: number;
}): VehicleResult {
  const d = nzRates(params.year).deductions;
  const cap = d.vehicleTier1KmCap.value;
  const tier1Rate = d.vehicleTier1RatePerKm.value[params.vehicleType];
  const tier2Rate = d.vehicleTier2RatePerKm.value[params.vehicleType];

  // Tier 1 applies to the business share of the first 14,000 TOTAL km.
  const businessProportion = params.totalKm > 0 ? params.businessKm / params.totalKm : 0;
  const tier1BusinessKm = Math.min(params.businessKm, Math.round(cap * businessProportion));
  const tier2BusinessKm = atLeastZero(params.businessKm - tier1BusinessKm);

  const tier1 = Math.round(tier1BusinessKm * tier1Rate);
  const tier2 = Math.round(tier2BusinessKm * tier2Rate);

  return {
    claimable: tier1 + tier2,
    breakdown: [
      { label: `Tier 1 — ${tier1BusinessKm} business km`, amount: tier1 },
      { label: `Tier 2 — ${tier2BusinessKm} business km`, amount: tier2 },
    ],
    notes: [
      'The 14,000 km tier boundary counts TOTAL kilometres driven, business and private together — not just business kilometres.',
      'You need a logbook kept for at least 90 consecutive days to establish the business proportion. It stays valid for three years unless your usage changes by more than 20%.',
      'The alternative is claiming actual costs on the logbook percentage, which is usually better for an expensive vehicle.',
    ],
  };
}

export function auVehicleClaim(params: {
  year: string;
  businessKm: number;
}): VehicleResult {
  const d = auRates(params.year).deductions;
  const cap = d.vehicleKmCap.value;
  const claimableKm = Math.min(params.businessKm, cap);
  const claimable = Math.round(claimableKm * d.vehicleRatePerKm.value);

  const notes = [
    'The cents-per-kilometre rate already includes depreciation and all running costs. You cannot claim fuel, servicing or insurance on top.',
    'You still need a reasonable basis for the kilometres claimed — a diary or app record.',
  ];
  if (params.businessKm > cap) {
    notes.unshift(
      `You have driven ${params.businessKm} business km but the cents-per-kilometre method caps at ${cap}. Above that you must use the logbook method, which will almost certainly give you a larger deduction.`,
    );
  }

  return {
    claimable,
    breakdown: [{ label: `${claimableKm} business km at the cents-per-km rate`, amount: claimable }],
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Claimable expense guidance                                          */
/* ------------------------------------------------------------------ */

export type ExpenseCategory =
  | 'software'
  | 'hardware'
  | 'home-office'
  | 'vehicle'
  | 'travel'
  | 'meals-entertainment'
  | 'clothing'
  | 'education'
  | 'marketing'
  | 'subcontractors'
  | 'professional-fees'
  | 'insurance'
  | 'bank-fees'
  | 'phone-internet'
  | 'assets'
  | 'other';

export interface CategoryGuidance {
  category: ExpenseCategory;
  label: string;
  /** Typical deductible proportion, or null when it depends entirely on use. */
  defaultBusinessUse: number | null;
  deductible: 'yes' | 'partial' | 'usually-no' | 'capital';
  nz: string;
  au: string;
  watchOut?: string;
}

export const EXPENSE_GUIDANCE: Record<ExpenseCategory, CategoryGuidance> = {
  software: {
    category: 'software',
    label: 'Software and subscriptions',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Adobe CC, Figma, fonts, hosting and domains are fully deductible when used for the business. Annual licences are deductible when incurred.',
    au: 'Same treatment. A prepaid subscription of 12 months or less is immediately deductible under the prepayment rules for small business.',
    watchOut:
      'If you also use a tool personally (a Spotify or a personal Dropbox), apportion it. Claiming 100% of something obviously mixed is the sort of thing that starts a wider look at your return.',
  },
  hardware: {
    category: 'hardware',
    label: 'Computers, cameras, tablets, monitors',
    defaultBusinessUse: 0.9,
    deductible: 'capital',
    nz: 'Under NZ$1,000 it is written off immediately. Over that it is depreciated — computers are typically 50% DV / 40% SL under IRD rates.',
    au: 'Under AU$20,000 it can be written off immediately under the instant asset write-off. Over that, depreciate over its effective life.',
    watchOut:
      'This is the biggest single difference between the two countries. A AU$5,000 machine is an immediate deduction in Australia and a multi-year depreciation claim in New Zealand.',
  },
  'home-office': {
    category: 'home-office',
    label: 'Home office',
    defaultBusinessUse: null,
    deductible: 'partial',
    nz: 'Square metre rate for utilities, plus a floor-area share of rent, rates, mortgage interest and house insurance.',
    au: '70c per hour fixed rate covering energy, internet, phone and consumables — or actual costs with full records.',
    watchOut:
      'In NZ people routinely forget the premises half. In Australia people routinely double-claim internet and phone on top of the fixed rate, which is not allowed.',
  },
  vehicle: {
    category: 'vehicle',
    label: 'Vehicle running costs',
    defaultBusinessUse: null,
    deductible: 'partial',
    nz: 'Kilometre rates by tier, a flat 25% of running costs, or actual costs on a logbook percentage.',
    au: '88c per business kilometre up to 5,000 km, or the logbook method above that.',
    watchOut:
      'Home to office is private travel in both countries, even when the office is a client site you attend regularly.',
  },
  travel: {
    category: 'travel',
    label: 'Travel and accommodation',
    defaultBusinessUse: null,
    deductible: 'partial',
    nz: 'Deductible where the purpose of the trip is business. Apportion where a trip is genuinely mixed.',
    au: 'Same. Keep a travel diary for trips of six or more consecutive nights.',
    watchOut:
      'A trans-Tasman trip with two client meetings and five days off is not a deductible trip with a small private part — it is a private trip with a small deductible part. Apportion honestly.',
  },
  'meals-entertainment': {
    category: 'meals-entertainment',
    label: 'Meals and entertainment',
    defaultBusinessUse: 0.5,
    deductible: 'partial',
    nz: 'Most business entertainment is 50% deductible — client meals, drinks, venue hire. Some things are 100%, such as food while travelling on business.',
    au: 'Entertainment is generally NOT deductible at all for a sole trader, and no GST credit is available either.',
    watchOut:
      'This one genuinely differs. A client lunch is half deductible in New Zealand and normally not deductible at all in Australia. Do not carry a NZ habit across the Tasman.',
  },
  clothing: {
    category: 'clothing',
    label: 'Clothing',
    defaultBusinessUse: 0,
    deductible: 'usually-no',
    nz: 'Ordinary clothing is not deductible even if you only wear it to client meetings. Protective gear and branded uniforms are.',
    au: 'Same rule. Occupation-specific, protective, or a compulsory logo uniform only.',
    watchOut:
      'A designer buying good clothes to look the part is making a private expense. There is no version of this that is deductible.',
  },
  education: {
    category: 'education',
    label: 'Courses, books and conferences',
    defaultBusinessUse: 1,
    deductible: 'partial',
    nz: 'Deductible where it maintains or improves skills used in your CURRENT business.',
    au: 'Same test — sufficient connection to current income-earning activity.',
    watchOut:
      'Training to move into a new field is not deductible. A web designer learning motion graphics is fine; a designer studying to become an accountant is not.',
  },
  marketing: {
    category: 'marketing',
    label: 'Marketing and advertising',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Fully deductible — ads, portfolio site, print, sponsorship.',
    au: 'Fully deductible on the same basis.',
  },
  subcontractors: {
    category: 'subcontractors',
    label: 'Subcontractors and freelancers',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Fully deductible. Schedular payment withholding may apply to some contractor types.',
    au: 'Fully deductible, but you must collect their ABN — without one you may have to withhold 47% under the no-ABN rule.',
    watchOut:
      'Paying an Australian subcontractor without their ABN and without withholding makes the payment non-deductible and leaves you liable for the withholding.',
  },
  'professional-fees': {
    category: 'professional-fees',
    label: 'Accounting and legal fees',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Deductible, including the cost of preparing your business accounts and tax return.',
    au: 'Deductible, including managing your tax affairs.',
  },
  insurance: {
    category: 'insurance',
    label: 'Business insurance',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Public liability and professional indemnity are deductible. ACC levies are deductible. Personal life and health cover is not.',
    au: 'Public liability and professional indemnity are deductible. Income protection premiums are deductible; life and trauma cover are not.',
  },
  'bank-fees': {
    category: 'bank-fees',
    label: 'Bank fees, merchant fees and interest',
    defaultBusinessUse: 1,
    deductible: 'yes',
    nz: 'Business account fees, Stripe/PayPal fees and interest on business borrowing are deductible.',
    au: 'Same treatment.',
    watchOut:
      'Merchant fees are easy to miss because they come out of the payment before it hits your account. Record the gross invoice as income and the fee as an expense — do not just bank the net.',
  },
  'phone-internet': {
    category: 'phone-internet',
    label: 'Phone and internet',
    defaultBusinessUse: 0.5,
    deductible: 'partial',
    nz: 'Claim the business proportion, supported by a representative sample of use.',
    au: 'Claim the business proportion — BUT not if you are already using the 70c fixed rate, which includes it.',
  },
  assets: {
    category: 'assets',
    label: 'Other capital assets',
    defaultBusinessUse: 1,
    deductible: 'capital',
    nz: 'Depreciated at the IRD rate for the asset class unless under the NZ$1,000 threshold.',
    au: 'Instant write-off under AU$20,000, otherwise depreciated over effective life.',
  },
  other: {
    category: 'other',
    label: 'Other',
    defaultBusinessUse: 1,
    deductible: 'partial',
    nz: 'Deductible if incurred in deriving income. Keep the receipt and a note of the business purpose.',
    au: 'Same test. Records must be kept for five years.',
  },
};

export function guidanceFor(category: ExpenseCategory): CategoryGuidance {
  return EXPENSE_GUIDANCE[category] ?? EXPENSE_GUIDANCE.other;
}

/** Categories whose treatment differs meaningfully between NZ and AU. */
export function divergentCategories(): CategoryGuidance[] {
  return Object.values(EXPENSE_GUIDANCE).filter((g) => g.watchOut && g.nz !== g.au);
}
