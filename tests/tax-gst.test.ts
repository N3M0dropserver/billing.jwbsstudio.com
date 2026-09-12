import { describe, it, expect } from 'vitest';
import {
  calculateGst,
  netFromGross,
  grossFromNet,
  assessExportTreatment,
  checkTurnoverThreshold,
  summariseGstPeriod,
} from '~/lib/tax/gst';

const $ = (d: number) => Math.round(d * 100);

describe('GST arithmetic', () => {
  it('adds 15% NZ GST', () => {
    const r = calculateGst({ net: $(1_000), treatment: 'standard' }, 'NZ', '2026-27');
    expect(r.gst).toBe($(150));
    expect(r.gross).toBe($(1_150));
  });

  it('adds 10% AU GST', () => {
    const r = calculateGst({ net: $(1_000), treatment: 'standard' }, 'AU', '2026-27');
    expect(r.gst).toBe($(100));
    expect(r.gross).toBe($(1_100));
  });

  it('charges nothing on a zero-rated export', () => {
    const r = calculateGst({ net: $(5_000), treatment: 'zero-rated-export' }, 'NZ', '2026-27');
    expect(r.gst).toBe(0);
    expect(r.gross).toBe($(5_000));
    expect(r.label).toMatch(/zero-rated/i);
  });

  it('round-trips net to gross and back at 15%', () => {
    const net = $(1_234.56);
    expect(netFromGross(grossFromNet(net, 0.15), 0.15)).toBe(net);
  });

  it('extracts GST from a tax-inclusive amount', () => {
    // 1,150 inclusive of 15% => 1,000 net
    expect(netFromGross($(1_150), 0.15)).toBe($(1_000));
  });
});

describe('export treatment', () => {
  const nzBase = {
    supplierJurisdiction: 'NZ' as const,
    supplierRegistered: true,
    clientPresentInSupplierCountry: false,
    connectedWithLocalLand: false,
  };

  it('zero-rates NZ design work for an Australian client', () => {
    const r = assessExportTreatment({ ...nzBase, clientCountry: 'AU' });
    expect(r.eligible).toBe(true);
    expect(r.treatment).toBe('zero-rated-export');
    expect(r.evidenceNeeded.length).toBeGreaterThan(0);
  });

  it('standard-rates work for a domestic NZ client', () => {
    const r = assessExportTreatment({ ...nzBase, clientCountry: 'NZ' });
    expect(r.treatment).toBe('standard');
  });

  it('loses the relief when the client was in NZ during the work', () => {
    const r = assessExportTreatment({
      ...nzBase,
      clientCountry: 'AU',
      clientPresentInSupplierCountry: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.treatment).toBe('standard');
  });

  it('loses the relief for work connected with local land', () => {
    const r = assessExportTreatment({
      ...nzBase,
      clientCountry: 'AU',
      connectedWithLocalLand: true,
    });
    expect(r.eligible).toBe(false);
  });

  it('charges no GST at all when not registered', () => {
    const r = assessExportTreatment({
      ...nzBase,
      supplierRegistered: false,
      clientCountry: 'AU',
    });
    expect(r.treatment).toBe('not-registered');
  });

  it('marks AU exports GST-free rather than zero-rated', () => {
    const r = assessExportTreatment({
      supplierJurisdiction: 'AU',
      supplierRegistered: true,
      clientCountry: 'NZ',
      clientPresentInSupplierCountry: false,
      connectedWithLocalLand: false,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toMatch(/GST-free/);
  });
});

describe('registration threshold monitoring', () => {
  it('flags compulsory registration over NZ$60k', () => {
    const r = checkTurnoverThreshold({
      jurisdiction: 'NZ',
      year: '2026-27',
      registered: false,
      rollingTwelveMonthTurnover: $(61_000),
    });
    expect(r.mustRegister).toBe(true);
  });

  it('warns when approaching the threshold', () => {
    const r = checkTurnoverThreshold({
      jurisdiction: 'NZ',
      year: '2026-27',
      registered: false,
      rollingTwelveMonthTurnover: $(52_000),
    });
    expect(r.mustRegister).toBe(false);
    expect(r.approaching).toBe(true);
  });

  it('stays quiet well under the threshold', () => {
    const r = checkTurnoverThreshold({
      jurisdiction: 'NZ',
      year: '2026-27',
      registered: false,
      rollingTwelveMonthTurnover: $(20_000),
    });
    expect(r.approaching).toBe(false);
    expect(r.mustRegister).toBe(false);
  });

  it('uses the AU$75k threshold for Australia', () => {
    const r = checkTurnoverThreshold({
      jurisdiction: 'AU',
      year: '2026-27',
      registered: false,
      rollingTwelveMonthTurnover: $(70_000),
    });
    expect(r.mustRegister).toBe(false);
    expect(r.threshold).toBe($(75_000));
  });
});

describe('GST period summary', () => {
  it('nets input credits against output GST', () => {
    const sales = [
      calculateGst({ net: $(10_000), treatment: 'standard' }, 'NZ', '2026-27'),
      calculateGst({ net: $(5_000), treatment: 'zero-rated-export' }, 'NZ', '2026-27'),
    ];
    const purchases = [calculateGst({ net: $(2_000), treatment: 'standard' }, 'NZ', '2026-27')];
    const s = summariseGstPeriod(sales, purchases);
    expect(s.gstOnSales).toBe($(1_500));
    expect(s.gstOnPurchases).toBe($(300));
    expect(s.netGstPayable).toBe($(1_200));
  });

  it('produces a refund position when inputs exceed outputs', () => {
    const sales = [calculateGst({ net: $(1_000), treatment: 'zero-rated-export' }, 'NZ', '2026-27')];
    const purchases = [calculateGst({ net: $(4_000), treatment: 'standard' }, 'NZ', '2026-27')];
    const s = summariseGstPeriod(sales, purchases);
    // Zero-rated exports still allow input credits — this is the refund case
    // a designer billing only offshore clients should expect.
    expect(s.netGstPayable).toBeLessThan(0);
    expect(s.netGstPayable).toBe(-$(600));
  });
});
