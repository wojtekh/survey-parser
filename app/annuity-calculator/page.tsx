'use client';

import { useMemo, useState } from 'react';
import { calculateForward, calculateReverse } from '@/lib/annuityMath';

type Mode = 'forward' | 'reverse';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  return currency.format(n);
}

function num(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default function AnnuityCalculatorPage() {
  const [mode, setMode] = useState<Mode>('forward');

  // Forward ("what will my payout be") inputs.
  const [initialInvestment, setInitialInvestment] = useState('50000');
  const [monthlyContribution, setMonthlyContribution] = useState('200');
  const [yearsUntilPayout, setYearsUntilPayout] = useState('15');
  const [accumulationRate, setAccumulationRate] = useState('5');
  const [payoutYears, setPayoutYears] = useState('20');
  const [payoutRate, setPayoutRate] = useState('4');

  // Reverse ("what do I need to invest for a desired income") inputs.
  const [desiredMonthlyIncome, setDesiredMonthlyIncome] = useState('3000');
  const [rPayoutYears, setRPayoutYears] = useState('20');
  const [rPayoutRate, setRPayoutRate] = useState('4');
  const [yearsUntilIncomeStarts, setYearsUntilIncomeStarts] = useState('15');
  const [rAccumulationRate, setRAccumulationRate] = useState('5');
  const [currentSavings, setCurrentSavings] = useState('0');

  const forward = useMemo(
    () =>
      calculateForward({
        initialInvestment: num(initialInvestment),
        monthlyContribution: num(monthlyContribution),
        yearsUntilPayout: num(yearsUntilPayout),
        accumulationRate: num(accumulationRate),
        payoutYears: num(payoutYears),
        payoutRate: num(payoutRate),
      }),
    [initialInvestment, monthlyContribution, yearsUntilPayout, accumulationRate, payoutYears, payoutRate]
  );

  const reverse = useMemo(
    () =>
      calculateReverse({
        desiredMonthlyIncome: num(desiredMonthlyIncome),
        payoutYears: num(rPayoutYears),
        payoutRate: num(rPayoutRate),
        yearsUntilIncomeStarts: num(yearsUntilIncomeStarts),
        accumulationRate: num(rAccumulationRate),
        currentSavings: num(currentSavings),
      }),
    [desiredMonthlyIncome, rPayoutYears, rPayoutRate, yearsUntilIncomeStarts, rAccumulationRate, currentSavings]
  );

  return (
    <div className="stack">
      <div>
        <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Annuity calculator</h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
          Estimate what a fixed annuity could pay you, or work backward from the monthly income
          you want to find out how much you&apos;d need to invest.
        </p>
      </div>

      <div className="tabs">
        <div className={`tab ${mode === 'forward' ? 'active' : ''}`} onClick={() => setMode('forward')}>
          Estimate my payout
        </div>
        <div className={`tab ${mode === 'reverse' ? 'active' : ''}`} onClick={() => setMode('reverse')}>
          I want a target income
        </div>
      </div>

      {mode === 'forward' ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <form className="card stack" style={{ flex: 1, minWidth: 320 }}>
            <div className="field-group" style={{ marginTop: 0 }}>
              <label className="field-label" htmlFor="initialInvestment">
                Initial investment
              </label>
              <input
                id="initialInvestment"
                type="number"
                min={0}
                value={initialInvestment}
                onChange={(e) => setInitialInvestment(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="monthlyContribution">
                Monthly contribution (optional)
              </label>
              <input
                id="monthlyContribution"
                type="number"
                min={0}
                value={monthlyContribution}
                onChange={(e) => setMonthlyContribution(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="yearsUntilPayout">
                Years until payout starts
              </label>
              <input
                id="yearsUntilPayout"
                type="number"
                min={0}
                value={yearsUntilPayout}
                onChange={(e) => setYearsUntilPayout(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="accumulationRate">
                Expected annual return while accumulating (%)
              </label>
              <input
                id="accumulationRate"
                type="number"
                min={0}
                step="0.1"
                value={accumulationRate}
                onChange={(e) => setAccumulationRate(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="payoutYears">
                Payout period (years)
              </label>
              <input
                id="payoutYears"
                type="number"
                min={1}
                value={payoutYears}
                onChange={(e) => setPayoutYears(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="payoutRate">
                Expected annual return during payout (%)
              </label>
              <input
                id="payoutRate"
                type="number"
                min={0}
                step="0.1"
                value={payoutRate}
                onChange={(e) => setPayoutRate(e.target.value)}
              />
            </div>
          </form>

          <div className="card stack" style={{ flex: 1, minWidth: 320 }}>
            <h3 style={{ fontSize: 14, margin: 0, color: 'var(--text-secondary)' }}>Estimated results</h3>

            <ResultRow label="Value when payout begins" value={fmt(forward.valueAtPayoutStart)} emphasize />
            <ResultRow label="Total contributions" value={fmt(forward.totalContributions)} />
            <ResultRow label="Total growth" value={fmt(forward.totalGrowth)} />

            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

            <ResultRow label="Estimated monthly income" value={fmt(forward.monthlyIncome)} emphasize />
            <ResultRow label="Estimated annual income" value={fmt(forward.annualIncome)} />
            <ResultRow
              label={`Total paid out over ${num(payoutYears)} years`}
              value={fmt(forward.totalIncomePaid)}
            />
          </div>
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <form className="card stack" style={{ flex: 1, minWidth: 320 }}>
            <div className="field-group" style={{ marginTop: 0 }}>
              <label className="field-label" htmlFor="desiredMonthlyIncome">
                Desired monthly income
              </label>
              <input
                id="desiredMonthlyIncome"
                type="number"
                min={0}
                value={desiredMonthlyIncome}
                onChange={(e) => setDesiredMonthlyIncome(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="rPayoutYears">
                How many years should the income last?
              </label>
              <input
                id="rPayoutYears"
                type="number"
                min={1}
                value={rPayoutYears}
                onChange={(e) => setRPayoutYears(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="rPayoutRate">
                Expected annual return during payout (%)
              </label>
              <input
                id="rPayoutRate"
                type="number"
                min={0}
                step="0.1"
                value={rPayoutRate}
                onChange={(e) => setRPayoutRate(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="yearsUntilIncomeStarts">
                Years until you want income to start
              </label>
              <input
                id="yearsUntilIncomeStarts"
                type="number"
                min={0}
                value={yearsUntilIncomeStarts}
                onChange={(e) => setYearsUntilIncomeStarts(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="rAccumulationRate">
                Expected annual return while accumulating (%)
              </label>
              <input
                id="rAccumulationRate"
                type="number"
                min={0}
                step="0.1"
                value={rAccumulationRate}
                onChange={(e) => setRAccumulationRate(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="currentSavings">
                Amount already saved toward this (optional)
              </label>
              <input
                id="currentSavings"
                type="number"
                min={0}
                value={currentSavings}
                onChange={(e) => setCurrentSavings(e.target.value)}
              />
            </div>
          </form>

          <div className="card stack" style={{ flex: 1, minWidth: 320 }}>
            <h3 style={{ fontSize: 14, margin: 0, color: 'var(--text-secondary)' }}>
              What you&apos;d need to invest
            </h3>

            <ResultRow
              label="Lump sum needed when payout starts"
              value={fmt(reverse.lumpSumNeededAtPayoutStart)}
            />
            <ResultRow
              label="Equivalent lump sum needed today"
              value={fmt(reverse.lumpSumNeededToday)}
              emphasize
            />
            <ResultRow
              label="Additional lump sum needed today"
              value={fmt(reverse.additionalLumpSumNeededToday)}
            />

            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

            <ResultRow
              label="…or, required monthly contribution"
              value={fmt(reverse.requiredMonthlyContribution)}
              emphasize
            />
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
              Investing this much per month, starting from your current savings, would reach the
              lump sum needed by the time payout starts.
            </p>
          </div>
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
        These figures are simplified estimates -- fixed rates of return, monthly compounding, no
        fees, taxes, riders, or mortality tables -- and don&apos;t represent an offer or quote from
        any insurer. Actual annuity products vary. Not financial or tax advice; consult a licensed
        financial advisor before purchasing an annuity.
      </p>
    </div>
  );
}

function ResultRow({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: emphasize ? 18 : 14, fontWeight: emphasize ? 700 : 600 }}>{value}</span>
    </div>
  );
}
