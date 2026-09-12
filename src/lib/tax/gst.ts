/**
 * GST/BAS handling for supplies made from NZ and from Australia.
 *
 * The case that matters here: a designer in one country billing a client in
 * the other. Both NZ and Australia relieve exported services of GST, but
 * they use different words for it and the conditions are not identical.
 *
 *   NZ  — "zero-rated". The supply is still a taxable supply, it goes in
 *         your return at 0%, and you still recover input GST on the costs of
 *         making it.
 *   AU  — "GST-free". Same practical effect: no GST charged, input tax
 *         credits still claimable.
 *
 * The condition in both is essentially that the client is a non-resident who
 * is outside the country when the service is performed, and that the service
 * is not connected with local land. Design and brand work delivered
 * electronically to an offshore client normally qualifies. Two pieces of
 * evidence of the client's location should be kept — a billing address alone
 * is thin.
 *
 * The trap in both countries is the same: if the client is physically in
 * your country when they receive the service, the relief is lost and the
 * supply is taxable at the standard rate.
 */

import { type Cents, applyRate } from './money';
import { nzRates, auRates } from './rates';
import type { Jurisdiction } from './rates';

export type GstTreatment =
  | 'standard'
  | 'zero-rated-export'
  | 'exempt'
  | 'not-registered';

export interface GstLine {
  /** Amount excluding GST. */
  net: Cents;
  treatment: GstTreatment;
}

export interface GstCalculation {
  net: Cents;
  gst: Cents;
  gross: Cents;
  rate: number;
  treatment: GstTreatment;
  /** Label to print on the invoice. */
  label: string;
}

export function gstRateFor(jurisdiction: Jurisdiction, year: string): number {
  return jurisdiction === 'NZ' ? nzRates(year).gst.rate.value : auRates(year).gst.rate.value;
}

export function gstRegistrationThreshold(jurisdiction: Jurisdiction, year: string): Cents {
  return jurisdiction === 'NZ'
    ? nzRates(year).gst.registrationThreshold.value
    : auRates(year).gst.registrationThreshold.value;
}

export function calculateGst(
  line: GstLine,
  jurisdiction: Jurisdiction,
  year: string,
): GstCalculation {
  const standardRate = gstRateFor(jurisdiction, year);

  let rate = 0;
  let label: string;

  switch (line.treatment) {
    case 'standard':
      rate = standardRate;
      label = jurisdiction === 'NZ' ? 'GST 15%' : 'GST 10%';
      break;
    case 'zero-rated-export':
      rate = 0;
      label = jurisdiction === 'NZ' ? 'Zero-rated export (0%)' : 'GST-free export';
      break;
    case 'exempt':
      rate = 0;
      label = jurisdiction === 'NZ' ? 'Exempt supply' : 'Input taxed';
      break;
    case 'not-registered':
      rate = 0;
      label = 'No GST — not registered';
      break;
  }

  const gst = applyRate(line.net, rate);
  return { net: line.net, gst, gross: line.net + gst, rate, treatment: line.treatment, label };
}

/** Strip GST out of a GST-inclusive amount. */
export function netFromGross(gross: Cents, rate: number): Cents {
  return Math.round(gross / (1 + rate));
}

/** Add GST to a GST-exclusive amount. */
export function grossFromNet(net: Cents, rate: number): Cents {
  return net + applyRate(net, rate);
}

export interface ExportEligibility {
  eligible: boolean;
  treatment: GstTreatment;
  reason: string;
  evidenceNeeded: string[];
}

/**
 * Decide the GST treatment for a supply, given where you are registered and
 * where the client is. Deliberately conservative: anything uncertain falls
 * back to the standard rate, because under-charging GST means paying it out
 * of your own pocket later.
 */
export function assessExportTreatment(params: {
  supplierJurisdiction: Jurisdiction;
  supplierRegistered: boolean;
  clientCountry: string;
  /** True if the client was physically in the supplier's country for the work. */
  clientPresentInSupplierCountry: boolean;
  /** True if the work relates to land or buildings in the supplier's country. */
  connectedWithLocalLand: boolean;
}): ExportEligibility {
  const {
    supplierJurisdiction,
    supplierRegistered,
    clientCountry,
    clientPresentInSupplierCountry,
    connectedWithLocalLand,
  } = params;

  if (!supplierRegistered) {
    return {
      eligible: false,
      treatment: 'not-registered',
      reason: 'You are not GST registered, so you do not charge GST on any supply.',
      evidenceNeeded: [],
    };
  }

  const homeCountry = supplierJurisdiction === 'NZ' ? 'NZ' : 'AU';
  const isDomestic = clientCountry.toUpperCase() === homeCountry;

  if (isDomestic) {
    return {
      eligible: false,
      treatment: 'standard',
      reason: 'Domestic client — the standard rate applies.',
      evidenceNeeded: [],
    };
  }

  if (connectedWithLocalLand) {
    return {
      eligible: false,
      treatment: 'standard',
      reason:
        supplierJurisdiction === 'NZ'
          ? 'Services connected with land or buildings in New Zealand are standard-rated even when the client is overseas.'
          : 'Services connected with Australian real property are taxable even when the client is overseas.',
      evidenceNeeded: [],
    };
  }

  if (clientPresentInSupplierCountry) {
    return {
      eligible: false,
      treatment: 'standard',
      reason:
        'The client was in your country when the service was performed, so the export relief does not apply.',
      evidenceNeeded: [],
    };
  }

  return {
    eligible: true,
    treatment: 'zero-rated-export',
    reason:
      supplierJurisdiction === 'NZ'
        ? 'Non-resident client outside New Zealand, work not connected with NZ land — zero-rated export of services.'
        : 'Non-resident client outside Australia, work not connected with Australian real property — GST-free export of services.',
    evidenceNeeded: [
      "The client's overseas billing address",
      'Evidence the client is a non-resident entity (company register extract, ABN/NZBN absence, or their own tax registration)',
      'Correspondence or a contract showing the work was delivered to them offshore',
    ],
  };
}

export interface TurnoverCheck {
  registered: boolean;
  rollingTurnover: Cents;
  threshold: Cents;
  mustRegister: boolean;
  approaching: boolean;
  message: string;
}

/**
 * Both countries test turnover over ANY rolling 12 months — past or
 * projected — not over a tax year. This is the single most common way a
 * sole trader ends up owing GST they never charged.
 */
export function checkTurnoverThreshold(params: {
  jurisdiction: Jurisdiction;
  year: string;
  registered: boolean;
  rollingTwelveMonthTurnover: Cents;
}): TurnoverCheck {
  const threshold = gstRegistrationThreshold(params.jurisdiction, params.year);
  const turnover = params.rollingTwelveMonthTurnover;
  const mustRegister = !params.registered && turnover > threshold;
  const approaching = !params.registered && !mustRegister && turnover > threshold * 0.8;

  let message: string;
  if (params.registered) {
    message = 'You are registered, so all supplies carry the correct treatment automatically.';
  } else if (mustRegister) {
    message =
      params.jurisdiction === 'NZ'
        ? 'Your rolling 12-month turnover is over NZ$60,000. Registration is compulsory and GST is payable on supplies from the date you were required to register — not the date you got around to registering.'
        : 'Your rolling 12-month turnover is over AU$75,000. You must register within 21 days of crossing the threshold.';
  } else if (approaching) {
    message =
      'You are within 20% of the registration threshold. The test looks forward as well as back, so if you can see the next 12 months crossing it, register now rather than after the fact.';
  } else {
    message = 'Comfortably under the registration threshold.';
  }

  return {
    registered: params.registered,
    rollingTurnover: turnover,
    threshold,
    mustRegister,
    approaching,
    message,
  };
}

export interface GstPeriodSummary {
  salesNet: Cents;
  gstOnSales: Cents;
  purchasesNet: Cents;
  gstOnPurchases: Cents;
  /** Positive means you pay; negative means a refund is due to you. */
  netGstPayable: Cents;
}

export function summariseGstPeriod(
  sales: GstCalculation[],
  purchases: GstCalculation[],
): GstPeriodSummary {
  const salesNet = sales.reduce((a, s) => a + s.net, 0);
  const gstOnSales = sales.reduce((a, s) => a + s.gst, 0);
  const purchasesNet = purchases.reduce((a, p) => a + p.net, 0);
  const gstOnPurchases = purchases.reduce((a, p) => a + p.gst, 0);
  return {
    salesNet,
    gstOnSales,
    purchasesNet,
    gstOnPurchases,
    netGstPayable: gstOnSales - gstOnPurchases,
  };
}
