/**
 * The combined tax position across both jurisdictions.
 *
 * IMPORTANT — what this does and does not do.
 *
 * This models the common case for a self-employed designer: tax resident of
 * one country, earning in both, with a mix of employment (PAYE/PAYG) and
 * self-employed income. It applies the residence country's tax to worldwide
 * income and credits foreign tax paid, capped at the domestic tax on that
 * same foreign income — which is how both the NZ-AU DTA and each country's
 * domestic foreign tax credit rules work in outline.
 *
 * It does NOT decide your residence for you. Residence turns on the
 * permanent place of abode test (NZ) and the resides/domicile/183-day tests
 * (AU), and where both countries claim you, on the DTA tie-breaker. Those are
 * facts-and-circumstances questions. The app asks you to state your residence
 * and shows you what follows from it.
 *
 * Treat the output as a planning estimate for setting money aside, not as a
 * return. File with an accountant.
 */

import { type Cents, atLeastZero } from './money';
import { calculateNz, nzTaxYearFor, type NzInput, type NzResult } from './nz';
import { calculateAu, auFinancialYearFor, type AuInput, type AuResult } from './au';
import { unverifiedFigures, type Jurisdiction } from './rates';

export type Residence = 'NZ' | 'AU';

export interface CombinedInput {
  /** Where you are tax resident. Drives which country taxes worldwide income. */
  residence: Residence;
  nz: NzInput;
  au: AuInput;
  /**
   * Income earned in the non-residence country, converted to the residence
   * country's currency. Needed because the residence country taxes it too.
   */
  foreignIncomeInResidenceCurrency?: Cents;
  /** Foreign tax paid on that income, in residence-country currency. */
  foreignTaxPaidInResidenceCurrency?: Cents;
}

export interface ReserveBand {
  label: string;
  rate: number;
  amount: Cents;
  explanation: string;
}

export interface CombinedResult {
  residence: Residence;
  nz: NzResult;
  au: AuResult;

  /** Currency the headline figures are expressed in. */
  currency: 'NZD' | 'AUD';

  /** Total tax and levies across both countries, after foreign tax credits. */
  totalLiability: Cents;
  foreignTaxCredit: {
    claimed: Cents;
    available: Cents;
    capped: boolean;
    note: string;
  };

  /**
   * Three reserve positions, replacing the spreadsheet's flat 15%/33% split.
   * "Set aside this share of every dollar that lands in the account."
   */
  reserve: {
    best: ReserveBand;
    likely: ReserveBand;
    worst: ReserveBand;
  };

  warnings: string[];
  /** Figures in the rate tables that still need confirming against source. */
  unverified: Array<{ jurisdiction: Jurisdiction; path: string; source: string; note?: string }>;
}

/**
 * The foreign tax credit is capped at the residence country's own tax on the
 * foreign income — you never get back more than you would have paid at home.
 */
function foreignTaxCredit(
  foreignIncome: Cents,
  foreignTaxPaid: Cents,
  domesticEffectiveRate: number,
): { claimed: Cents; available: Cents; capped: boolean; note: string } {
  if (foreignIncome <= 0 || foreignTaxPaid <= 0) {
    return {
      claimed: 0,
      available: 0,
      capped: false,
      note: 'No foreign income recorded, so no foreign tax credit applies.',
    };
  }
  const cap = Math.round(foreignIncome * domesticEffectiveRate);
  const claimed = Math.min(foreignTaxPaid, cap);
  return {
    claimed,
    available: foreignTaxPaid,
    capped: foreignTaxPaid > cap,
    note:
      foreignTaxPaid > cap
        ? 'The foreign tax you paid is more than the tax your residence country would charge on the same income, so the credit is capped. The excess is not refundable and generally cannot be carried forward.'
        : 'Foreign tax paid is fully credited against your residence-country liability.',
  };
}

export function calculateCombined(input: CombinedInput): CombinedResult {
  const nz = calculateNz(input.nz);
  const au = calculateAu(input.au);

  const isNz = input.residence === 'NZ';
  const currency = isNz ? ('NZD' as const) : ('AUD' as const);

  const home = isNz ? nz : au;
  const domesticEffectiveRate = home.effectiveRate;

  const credit = foreignTaxCredit(
    input.foreignIncomeInResidenceCurrency ?? 0,
    input.foreignTaxPaidInResidenceCurrency ?? 0,
    domesticEffectiveRate,
  );

  const homeLiability = isNz
    ? nz.residualIncomeTax + nz.studentLoanRepayment + nz.acc.totalIncGst
    : au.balanceOwing;

  const totalLiability = atLeastZero(homeLiability - credit.claimed);

  // Reserve bands. The self-employed slice is what needs reserving —
  // employment income is already taxed at source.
  const selfEmployedSlice = isNz
    ? atLeastZero(nz.netBusinessProfit)
    : atLeastZero(au.netBusinessProfit);
  const grossSelfEmployed = isNz ? input.nz.selfEmployedIncome : input.au.businessIncome;

  const likelyRate = home.recommendedReserveRate;
  // Best case: all claimed deductions hold, so you reserve against net profit
  // rather than gross receipts.
  const bestRate = grossSelfEmployed > 0 ? (likelyRate * selfEmployedSlice) / grossSelfEmployed : 0;
  // Worst case: deductions disallowed AND you tip into the next bracket.
  const topRate = isNz ? 0.39 : 0.45;
  const worstRate = Math.min(
    topRate + (isNz ? 0.12 : 0.17) + (isNz ? 0.02 : 0.02),
    likelyRate + 0.12,
  );

  const warnings: string[] = [];

  if (isNz) {
    const gstThreshold = nz.rates.gst.registrationThreshold.value;
    if (input.nz.selfEmployedIncome > gstThreshold * 0.8 && input.nz.selfEmployedIncome <= gstThreshold) {
      warnings.push(
        `You are within 20% of the NZ$${gstThreshold / 100 / 1000}k GST registration threshold. The test is turnover in ANY rolling 12 months — including projected — not the tax year, so watch this before you cross it.`,
      );
    }
    if (input.nz.selfEmployedIncome > gstThreshold) {
      warnings.push(
        'Your turnover is over the NZ GST registration threshold. Registration is compulsory, and GST is payable on supplies made from the date you were required to register even if you had not registered yet.',
      );
    }
    if (nz.provisionalTax.required) {
      warnings.push(nz.provisionalTax.note);
    }
  } else {
    const gstThreshold = au.rates.gst.registrationThreshold.value;
    if (input.au.businessIncome > gstThreshold) {
      warnings.push(
        'Your turnover is over the AU$75,000 GST registration threshold. You must register within 21 days of crossing it.',
      );
    }
    if (au.paygInstalments.required) {
      warnings.push(au.paygInstalments.note);
    }
  }

  if ((input.foreignIncomeInResidenceCurrency ?? 0) > 0) {
    warnings.push(
      'You have income from both countries. Which country taxes what depends on your residence and, if both countries treat you as resident, on the DTA tie-breaker. Get this confirmed — it changes the whole calculation, not just a line of it.',
    );
  }

  const unverified = [
    ...unverifiedFigures('NZ', input.nz.year).map((u) => ({ jurisdiction: 'NZ' as const, ...u })),
    ...unverifiedFigures('AU', input.au.year).map((u) => ({ jurisdiction: 'AU' as const, ...u })),
  ];

  return {
    residence: input.residence,
    nz,
    au,
    currency,
    totalLiability,
    foreignTaxCredit: credit,
    reserve: {
      best: {
        label: 'Best case',
        rate: bestRate,
        amount: Math.round(grossSelfEmployed * bestRate),
        explanation:
          'Every deduction you have claimed is accepted, and your income stays in its current bracket. This is the least you should ever hold back.',
      },
      likely: {
        label: 'Likely',
        rate: likelyRate,
        amount: Math.round(selfEmployedSlice * likelyRate),
        explanation: isNz
          ? 'Income tax at your top marginal rate, plus ACC levies and student loan on the next dollar you earn. This is the number to reserve from each payment.'
          : 'Income tax at your top marginal rate, plus the 2% Medicare levy and your HELP repayment rate on the next dollar you earn.',
      },
      worst: {
        label: 'Worst case',
        rate: worstRate,
        amount: Math.round(grossSelfEmployed * worstRate),
        explanation:
          'Deductions are disallowed on review and the extra income pushes you into the top bracket. Holding this much is cautious, not paranoid, in a year where income is climbing fast.',
      },
    },
    warnings,
    unverified,
  };
}

export { nzTaxYearFor, auFinancialYearFor };
export type { NzInput, NzResult, AuInput, AuResult };
