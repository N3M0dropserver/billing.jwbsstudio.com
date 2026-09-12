# Tax research: New Zealand and Australia

Research current as at **September 2026**, covering the NZ 2025-26 and 2026-27 tax
years and the AU 2025-26 and 2026-27 financial years.

Every figure below is encoded in `src/lib/tax/rates.ts` with its source URL and a
confidence marker. Anything marked `verify` was assembled from secondary sources
and is surfaced in the app's UI rather than quietly trusted — see *Figures to
confirm* on the Tax page.

> This is research to build software against. It is not tax advice, and the
> cross-border position in particular needs an accountant who can look at your
> actual facts.

---

## 1. The two tax years do not line up

| | New Zealand | Australia |
|---|---|---|
| Tax year | 1 April – 31 March | 1 July – 30 June |
| Labelled | by the year it ends (2026-27 ends 31 Mar 2027) | by both years (2026-27 ends 30 Jun 2027) |

This is the first thing that breaks a naive design. An invoice issued on 15 May
2026 falls in NZ 2026-27 **and** AU 2025-26. The app stores a `jurisdiction` on
every invoice and expense, and derives the tax year from the transaction date
*and* that jurisdiction — never from a single global "current year".

## 2. Income tax rates

### New Zealand — 2025-26 and 2026-27 (unchanged)

| Income | Rate |
|---|---|
| $0 – $15,600 | 10.5% |
| $15,601 – $53,500 | 17.5% |
| $53,501 – $78,100 | 30% |
| $78,101 – $180,000 | 33% |
| $180,001+ | 39% |

Thresholds have been frozen since the 31 July 2024 change. **There is no
tax-free threshold** — the first dollar is taxed.

### Australia — resident rates

| Income | 2025-26 | 2026-27 |
|---|---|---|
| $0 – $18,200 | Nil | Nil |
| $18,201 – $45,000 | 16% | **15%** |
| $45,001 – $135,000 | 30% | 30% |
| $135,001 – $190,000 | 37% | 37% |
| $190,001+ | 45% | 45% |

The 16% rate dropped to 15% from 1 July 2026 and drops again to 14% from
1 July 2027. Worth about $268/year to anyone earning over $45,000.

**A note on the published "base amounts".** The ATO expresses brackets as
"$4,288 plus 30c for each $1 over $45,000". Those bases are pure arithmetic, and
secondary sources routinely quote the wrong year's. The engine derives them
rather than storing them, and the test suite asserts it reproduces the ATO's
published figures exactly — $4,288 and $31,288 and $51,638 for 2025-26, and
$4,020 / $31,020 / $51,370 for 2026-27.

## 3. Levies and loans — the part people forget

Income tax is not the whole bill. On the self-employed slice, a New Zealander
adds ACC and possibly student loan; an Australian adds Medicare and possibly
HELP. This is why a flat "put aside 15%" is dangerous.

### NZ — ACC

| | 2025-26 | 2026-27 |
|---|---|---|
| Earner levy (PAYE, GST-inclusive) | 1.67% | 1.75% |
| Earner levy (self-employed, ex GST) | ~1.45% | 1.52% |
| Max liable earnings | $152,790 | $156,641 |
| Max earner levy | $2,551.59 | $2,741.22 |

**The GST-inclusive/exclusive distinction matters and is widely missed.** The
headline 1.75% is the PAYE rate and is GST-inclusive. ACC invoices a
self-employed person on the GST-*exclusive* rate (1.52%) and adds GST on top —
and if you are GST registered you claim that GST back. 1.52 × 1.15 = 1.748.
The engine models both.

A self-employed person on standard CoverPlus pays three components:

- **Earner levy** — funds non-work injuries, flat rate above.
- **Work levy** — set by your ACC classification unit, varies enormously by
  trade. The app defaults to the scheme average (~$0.66 per $100) and says
  loudly that this is not your rate. Put your own in from your ACC invoice.
- **Working Safer levy** — $0.08 per $100, funds WorkSafe NZ.

ACC also applies a **minimum level of liable earnings** to full-time
self-employed people, so a low-profit year still attracts a levy on that
minimum, not on the actual profit.

### NZ — student loan

12% of every dollar over an annual threshold of **$24,128** (unchanged across
both years). For self-employed income this is settled at year end rather than
deducted as you go.

### AU — Medicare levy

2% of taxable income, with a low-income shade-in. Below the threshold
(**$28,011** for 2025-26, raised from $27,222 and applied retrospectively) no
levy is payable; above it the levy phases in at 10c in the dollar until the full
2% applies.

The upper end of the shade-in is *derived*, not stored: it is where
`0.10 × (income − lower) = 0.02 × income`, i.e. `lower ÷ 0.8`. Secondary sources
frequently pair a current-year lower threshold with a prior-year upper one —
computing it removes the whole class of error.

### AU — HELP/HECS

**This changed fundamentally on 1 July 2025.** Repayment is now *marginal* —
you repay only on income above each threshold, like income tax. The old system
applied a single rate to your *whole* income, which produced brutal cliff edges.

| | 2025-26 | 2026-27 |
|---|---|---|
| Nil below | $67,000 | $69,528 |
| 15% from | $67,000 | $69,528 |
| 17% from | $125,000 | $129,717 |
| Flat 10% of total income at | $179,286 | $186,051 |

A one-off 20% reduction was applied to every student loan balance existing on
1 June 2025.

## 4. GST

| | New Zealand | Australia |
|---|---|---|
| Rate | 15% | 10% |
| Registration threshold | $60,000 | $75,000 |
| Test | turnover in **any** rolling 12 months | turnover in **any** rolling 12 months |
| Deadline | from the date you were required to register | within 21 days of crossing |
| Filing | monthly / 2-monthly / 6-monthly | BAS monthly / quarterly / annual |

**The threshold test is the single most common trap.** It is not a financial-year
test. It looks forward as well as back — if you can see the next twelve months
crossing it, you are required to register *now*. And in NZ, GST is payable on
supplies made from the date you were required to register, not the date you got
around to registering. The app monitors rolling 12-month turnover and warns at
80%.

### Exported services — the cross-Tasman case

Both countries relieve exported services, with different words:

- **NZ: "zero-rated"** — still a taxable supply, goes in the return at 0%, input
  GST on costs still recoverable.
- **AU: "GST-free"** — same practical effect.

Conditions are substantially the same: the client is a non-resident who is
outside the country when the service is performed, and the work is not connected
with local land. Design and brand work delivered electronically to an offshore
client normally qualifies.

**Two traps:**

1. If the client is physically in your country when they receive the service,
   the relief is lost and the supply is standard-rated.
2. Work connected with land or real property in your own country is
   standard-rated *even when the client is overseas*.

Evidence matters. A billing address alone is thin — keep evidence of
non-residence and of offshore delivery. The app's `assessExportTreatment()` is
deliberately conservative: anything uncertain falls back to the standard rate,
because under-charging GST means paying it out of your own pocket later.

## 5. Paying in advance

### NZ — provisional tax

If residual income tax (tax owed after credits) exceeds **$5,000**, you become a
provisional taxpayer the *following* year. The standard option uplifts the prior
year's RIT by 5% (or the year before that by 10%) and splits it into three
instalments — for a standard 31 March balance date, due 28 August, 15 January
and 7 May.

### AU — PAYG instalments

You enter the PAYG system when **both**: instalment income is $4,000 or more,
and tax payable on your latest assessment is $1,000 or more. Paid quarterly,
due 28 October, 28 February, 28 April and 28 July.

## 6. Deductions

### Where the two countries genuinely differ

These are the ones that will cost you if you carry a habit across the Tasman.

| | New Zealand | Australia |
|---|---|---|
| **Entertainment** | Most business entertainment **50% deductible** | Generally **not deductible at all** for a sole trader, and no GST credit |
| **Equipment write-off** | Immediate under **$1,000**, else depreciate | Immediate under **$20,000** (instant asset write-off), else depreciate |
| **Home office** | Square metre rate ($57.30/m², utilities only) **plus** floor-area share of rent/rates/interest/insurance | 70c per hour fixed rate covering energy, internet, phone, consumables — nothing claimed separately on top |
| **Vehicle** | Tier rates by fuel type; tier boundary at 14,000 km of **total** travel | 88c/km, capped at **5,000 business km**, then logbook |

The equipment one is a two-orders-of-magnitude difference. A AU$5,000 machine is
an immediate deduction in Australia and a multi-year depreciation claim in
New Zealand.

### NZ vehicle rates 2025-26

| Fuel | Tier 1 (first 14,000 km) | Tier 2 (beyond) |
|---|---|---|
| Petrol | $1.20/km | $0.37/km |
| Diesel | $1.30/km | $0.38/km |
| Petrol hybrid | $0.90/km | $0.24/km |
| Electric | $1.22/km | $0.23/km |

Tier 1 covers the business portion of the first 14,000 km driven **in total**,
business and private combined — not the first 14,000 business km. A 90-day
logbook establishes the business proportion and stays valid three years.

### Rules that are the same in both

- **Clothing** is not deductible unless protective or a branded uniform. Buying
  good clothes to look the part at client meetings is a private expense in both
  countries, full stop.
- **Education** must relate to your *current* business. Training to move into a
  new field is not deductible.
- **Home to office travel** is private, even to a client site you attend daily.

### AU — deductible super

The largest legal deduction available to an Australian sole trader. Personal
contributions are deductible up to the **$30,000** concessional cap and taxed at
15% inside the fund rather than at your marginal rate. Unused cap carries
forward five years if your total super balance is under $500,000.

**You must lodge a notice of intent with your fund and receive their
acknowledgement before lodging your return**, or the deduction is denied. The
app says so on the Tax page.

## 7. Working across both countries

This is where it stops being arithmetic.

**Residence is the whole question.** New Zealand uses a 183-day test and a
permanent place of abode test — and the permanent place of abode test overrides
day counting entirely, so you can be out of NZ for a long time and still be
resident. Australia uses four tests (resides, domicile, 183-day, superannuation)
and meeting any one can make you resident.

Both can claim you at once. Where they do, the **NZ-AU double tax agreement**
has a tie-breaker in its Residence article that assigns you to one country for
treaty purposes.

Once residence is settled:

- The residence country taxes **worldwide income**.
- The source country may still tax income arising there.
- Double taxation is relieved by a **foreign tax credit** — capped at the
  domestic tax on that same foreign income. You never get back more than you
  would have paid at home, and the excess is generally neither refundable nor
  carried forward.

The app implements exactly that: `calculateCombined()` applies the residence
country's rules and credits foreign tax up to the cap. It does **not** decide
your residence, because that is a facts-and-circumstances question. It asks you
to state it and shows what follows.

**If you have income on both sides of the Tasman, get the residence position
confirmed by an accountant before relying on any number this app produces.** It
changes the whole calculation, not one line of it.

## 8. What the old spreadsheet got wrong

The attached `Jamie_Tax_Spread_sheet_2025.xlsx` had the right instincts —
invoice rows, paid/unpaid, GST at $60k, student loan, business-use percentage on
expenses — and three bugs worth naming, all now covered by tests:

1. **Wrong bracket threshold.** It used $10,000 as the boundary between the
   10.5% and 17.5% bands. The real boundary is $15,600.
2. **Flat-rating instead of stacking.** It applied a single rate to the *whole*
   income rather than taxing each slice at its own rate. At $120,000 this
   under-states the tax by over $8,000; at $180,000 by over $17,000.
3. **Levies missing from the reserve.** Reserving 15% ignores ACC and student
   loan entirely. On $90,000 of profit with a student loan, the true marginal
   cost of the next dollar is over 47%, not 15%.

The engine replaces the flat reserve with three bands — best case, likely and
worst case — computed from your actual marginal position.

---

## Sources

New Zealand:
- [IRD — tax rates for individuals](https://www.ird.govt.nz/income-tax/income-tax-for-individuals/tax-codes-and-tax-rates-for-individuals/tax-rates-for-individuals)
- [IRD — provisional tax, standard option](https://www.ird.govt.nz/income-tax/provisional-tax/provisional-tax-options/standard-option)
- [IRD — student loan repayments when self-employed](https://www.ird.govt.nz/student-loans/living-in-new-zealand-with-a-student-loan/repaying-my-student-loan-when-i-am-self-employed-or-earn-other-income)
- [IRD — kilometre rates 2025-26](https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-expenses/claiming-vehicle-expenses/kilometre-rates-2025-2026)
- [IRD — square metre rate for home office 2025](https://www.ird.govt.nz/updates/news-folder/2025/square-metre-rate-for-home-office-calculations-2025)
- [IRD — zero-rated supplies](https://www.ird.govt.nz/gst/charging-gst/zero-rated-supplies)
- [IRD — tax residency for individuals](https://www.ird.govt.nz/international-tax/individuals/tax-residency-status-for-individuals)
- [IRD — NZ tax residents and DTAs](https://www.ird.govt.nz/international-tax/double-tax-agreements/new-zealand-tax-residents)
- [NZ-Australia DTA 2009 (text)](https://www.taxpolicy.ird.govt.nz/-/media/project/ir/tp/tax-treaties/australia/2009-dta-nz-australia-pdf.pdf)
- [ACC — levies for business](https://www.acc.co.nz/for-business/understanding-levies-if-you-work-or-own-a-business/)

Australia:
- [ATO — tax rates, Australian residents](https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents)
- [ATO — personal income tax cuts](https://www.ato.gov.au/about-ato/new-legislation/in-detail/individuals/personal-income-tax-new-tax-cuts-for-every-australian-taxpayer)
- [ATO — Medicare levy reduction for low-income earners](https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners)
- [ATO — registering for GST](https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst)
- [ATO — exports and GST](https://www.ato.gov.au/businesses-and-organisations/international-tax-for-business/australians-doing-business-overseas/exports-and-gst)
- [ATO — starting PAYG instalments](https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/payg-instalments/starting-payg-instalments)
- [ATO — working from home, fixed rate method](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/fixed-rate-method)
- [ATO — cents per kilometre method](https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/income-and-deductions-for-business/deductions/deductions-for-motor-vehicle-expenses/cents-per-kilometre-method)
- [ATO — $20,000 instant asset write-off for 2025-26](https://www.ato.gov.au/businesses-and-organisations/small-business-newsroom/20000-instant-asset-write-off-for-2025-26)
- [ATO — residency tests](https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/residency-tests)
