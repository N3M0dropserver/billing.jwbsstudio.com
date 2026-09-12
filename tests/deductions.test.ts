import { describe, it, expect } from 'vitest';
import {
  depreciateYear,
  depreciationSchedule,
  nzHomeOffice,
  auWorkFromHome,
  nzVehicleClaim,
  auVehicleClaim,
  guidanceFor,
  divergentCategories,
} from '~/lib/tax/deductions';

const $ = (d: number) => Math.round(d * 100);

describe('immediate write-off thresholds', () => {
  it('writes off a NZ$800 asset in full', () => {
    const r = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(800), rate: 0.5,
      method: 'DV', businessUsePercent: 1,
    });
    expect(r.immediateWriteOff).toBe(true);
    expect(r.claimableForYear).toBe($(800));
    expect(r.closingAdjustedValue).toBe(0);
  });

  it('depreciates a NZ$3,000 asset instead of writing it off', () => {
    const r = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(3_000), rate: 0.5,
      method: 'DV', businessUsePercent: 1,
    });
    expect(r.immediateWriteOff).toBe(false);
    expect(r.depreciationForYear).toBe($(1_500));
  });

  it('writes off the same AU$3,000 asset in full under the instant write-off', () => {
    const r = depreciateYear({
      jurisdiction: 'AU', year: '2026-27', cost: $(3_000), rate: 0.5,
      method: 'DV', businessUsePercent: 1,
    });
    expect(r.immediateWriteOff).toBe(true);
    expect(r.claimableForYear).toBe($(3_000));
  });

  it('does not write off an AU asset at or over the $20,000 limit', () => {
    const r = depreciateYear({
      jurisdiction: 'AU', year: '2026-27', cost: $(20_000), rate: 0.3,
      method: 'DV', businessUsePercent: 1,
    });
    expect(r.immediateWriteOff).toBe(false);
  });

  it('denies the AU instant write-off above the turnover cap', () => {
    const r = depreciateYear({
      jurisdiction: 'AU', year: '2026-27', cost: $(5_000), rate: 0.3,
      method: 'DV', businessUsePercent: 1, turnover: $(12_000_000),
    });
    expect(r.immediateWriteOff).toBe(false);
  });
});

describe('depreciation methods', () => {
  it('diminishing value applies the rate to the written-down value', () => {
    const y2 = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.4,
      method: 'DV', businessUsePercent: 1, openingAccumulated: $(4_000),
    });
    expect(y2.openingAdjustedValue).toBe($(6_000));
    expect(y2.depreciationForYear).toBe($(2_400));
  });

  it('straight line applies the rate to original cost every year', () => {
    const y2 = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.2,
      method: 'SL', businessUsePercent: 1, openingAccumulated: $(2_000),
    });
    expect(y2.depreciationForYear).toBe($(2_000));
  });

  it('front-loads more deduction under DV than SL in year one', () => {
    const common = {
      jurisdiction: 'NZ' as const, year: '2026-27', cost: $(10_000),
      rate: 0.3, businessUsePercent: 1,
    };
    const dv = depreciateYear({ ...common, method: 'DV' });
    const sl = depreciateYear({ ...common, method: 'SL' });
    expect(dv.depreciationForYear).toBe(sl.depreciationForYear);
    const dv2 = depreciateYear({ ...common, method: 'DV', openingAccumulated: $(3_000) });
    const sl2 = depreciateYear({ ...common, method: 'SL', openingAccumulated: $(3_000) });
    expect(dv2.depreciationForYear).toBeLessThan(sl2.depreciationForYear);
  });

  it('never depreciates below zero', () => {
    const r = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.9,
      method: 'SL', businessUsePercent: 1, openingAccumulated: $(9_500),
    });
    expect(r.closingAdjustedValue).toBeGreaterThanOrEqual(0);
    expect(r.depreciationForYear).toBe($(500));
  });

  it('pro-rates the first year by months held', () => {
    const r = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(12_000), rate: 0.5,
      method: 'DV', businessUsePercent: 1, monthsHeld: 3,
    });
    expect(r.depreciationForYear).toBe($(1_500));
  });

  it('applies business use to the claimable amount only', () => {
    const r = depreciateYear({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.5,
      method: 'DV', businessUsePercent: 0.8,
    });
    expect(r.depreciationForYear).toBe($(5_000));
    expect(r.claimableForYear).toBe($(4_000));
  });
});

describe('depreciation schedule', () => {
  it('runs down to a trivial residual under DV', () => {
    const rows = depreciationSchedule({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.5,
      method: 'DV', businessUsePercent: 1,
    });
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[rows.length - 1]!.closing).toBeLessThan($(100));
    expect(rows[0]!.depreciation).toBe($(5_000));
    expect(rows[1]!.depreciation).toBe($(2_500));
  });

  it('returns a single row for an immediately written off asset', () => {
    const rows = depreciationSchedule({
      jurisdiction: 'AU', year: '2026-27', cost: $(2_000), rate: 0.5,
      method: 'DV', businessUsePercent: 1,
    });
    expect(rows).toHaveLength(1);
  });

  it('never claims more in total than the original cost', () => {
    const rows = depreciationSchedule({
      jurisdiction: 'NZ', year: '2026-27', cost: $(10_000), rate: 0.4,
      method: 'DV', businessUsePercent: 1,
    });
    const total = rows.reduce((a, r) => a + r.depreciation, 0);
    expect(total).toBeLessThanOrEqual($(10_000));
  });
});

describe('home office', () => {
  it('claims utilities at the square metre rate plus a share of premises costs', () => {
    const r = nzHomeOffice({
      year: '2026-27', businessAreaSqm: 12, totalAreaSqm: 100,
      annualPremisesCosts: $(30_000),
    });
    // 12 * 57.30 = 687.60 utilities; 12% of 30,000 = 3,600 premises
    expect(r.breakdown[0]!.amount).toBe($(687.6));
    expect(r.breakdown[1]!.amount).toBe($(3_600));
    expect(r.claimable).toBe($(4_287.6));
  });

  it('warns not to double-claim utilities', () => {
    const r = nzHomeOffice({
      year: '2026-27', businessAreaSqm: 10, totalAreaSqm: 100, annualPremisesCosts: 0,
    });
    expect(r.notes.some((n) => /do not claim those separately/i.test(n))).toBe(true);
  });

  it('claims the AU fixed rate per hour', () => {
    const r = auWorkFromHome({ year: '2026-27', hoursWorkedFromHome: 1_200 });
    expect(r.claimable).toBe($(840));
  });

  it('warns that AU actual hours must be recorded', () => {
    const r = auWorkFromHome({ year: '2026-27', hoursWorkedFromHome: 100 });
    expect(r.notes.some((n) => /ACTUAL hours/i.test(n))).toBe(true);
  });
});

describe('vehicle claims', () => {
  it('splits NZ km across tiers on total distance driven', () => {
    const r = nzVehicleClaim({
      year: '2026-27', vehicleType: 'petrol', businessKm: 10_000, totalKm: 20_000,
    });
    // Business proportion 50%, so tier 1 covers 7,000 business km of the
    // first 14,000 total km; the remaining 3,000 fall into tier 2.
    expect(r.breakdown[0]!.amount).toBe(Math.round(7_000 * $(1.20)));
    expect(r.breakdown[1]!.amount).toBe(Math.round(3_000 * $(0.37)));
  });

  it('uses electric rates when the vehicle is electric', () => {
    const r = nzVehicleClaim({
      year: '2026-27', vehicleType: 'electric', businessKm: 5_000, totalKm: 5_000,
    });
    expect(r.claimable).toBe(Math.round(5_000 * $(1.22)));
  });

  it('caps the AU cents-per-km method at 5,000 km', () => {
    const r = auVehicleClaim({ year: '2026-27', businessKm: 8_000 });
    expect(r.claimable).toBe(Math.round(5_000 * $(0.88)));
    expect(r.notes[0]).toMatch(/logbook method/i);
  });

  it('does not warn below the AU cap', () => {
    const r = auVehicleClaim({ year: '2026-27', businessKm: 3_000 });
    expect(r.claimable).toBe(Math.round(3_000 * $(0.88)));
    expect(r.notes[0]).not.toMatch(/caps at/i);
  });
});

describe('expense guidance', () => {
  it('flags entertainment as the key NZ/AU divergence', () => {
    const g = guidanceFor('meals-entertainment');
    expect(g.nz).toMatch(/50%/);
    expect(g.au).toMatch(/NOT be deductible|not.*deductible/i);
    expect(g.watchOut).toBeTruthy();
  });

  it('treats clothing as not deductible in both countries', () => {
    expect(guidanceFor('clothing').deductible).toBe('usually-no');
  });

  it('treats hardware as capital in both countries', () => {
    expect(guidanceFor('hardware').deductible).toBe('capital');
  });

  it('falls back to the generic category for an unknown one', () => {
    // @ts-expect-error deliberately passing an invalid category
    expect(guidanceFor('nonsense').category).toBe('other');
  });

  it('lists the categories that differ across the Tasman', () => {
    const d = divergentCategories();
    expect(d.length).toBeGreaterThan(0);
    expect(d.some((g) => g.category === 'meals-entertainment')).toBe(true);
  });
});
