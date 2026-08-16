// Simplified annuity math shared by the forward ("what will my payout be")
// and reverse ("what do I need to invest for a desired income") calculators.
// These are illustrative estimates -- monthly compounding, fixed rates, no
// fees/taxes/mortality tables -- the same simplifying assumptions consumer
// calculators like annuity.org's use. Not financial advice.

export interface ForwardInput {
  initialInvestment: number;
  monthlyContribution: number;
  yearsUntilPayout: number;
  accumulationRate: number; // annual %, e.g. 5 for 5%
  payoutYears: number;
  payoutRate: number; // annual %
}

export interface ForwardResult {
  totalContributions: number;
  totalGrowth: number;
  valueAtPayoutStart: number;
  monthlyIncome: number;
  annualIncome: number;
  totalIncomePaid: number;
}

export interface ReverseInput {
  desiredMonthlyIncome: number;
  payoutYears: number;
  payoutRate: number; // annual %
  yearsUntilIncomeStarts: number;
  accumulationRate: number; // annual %
  currentSavings: number;
}

export interface ReverseResult {
  lumpSumNeededAtPayoutStart: number;
  lumpSumNeededToday: number;
  additionalLumpSumNeededToday: number;
  requiredMonthlyContribution: number;
}

/** Future value of a lump sum plus level monthly contributions, compounded monthly. */
function futureValue(
  principal: number,
  monthlyContribution: number,
  annualRate: number,
  years: number
): number {
  const n = years * 12;
  const i = annualRate / 100 / 12;

  const principalFv = i === 0 ? principal : principal * Math.pow(1 + i, n);
  const contributionsFv =
    i === 0 ? monthlyContribution * n : monthlyContribution * ((Math.pow(1 + i, n) - 1) / i);

  return principalFv + contributionsFv;
}

/** Level monthly payment an ordinary annuity of `lumpSum` can sustain over `years`. */
function paymentFromLumpSum(lumpSum: number, annualRate: number, years: number): number {
  const n = years * 12;
  const i = annualRate / 100 / 12;
  if (n <= 0) return 0;
  return i === 0 ? lumpSum / n : (lumpSum * i) / (1 - Math.pow(1 + i, -n));
}

/** Lump sum (present value, at payout start) needed to fund a level monthly payment over `years`. */
function lumpSumFromPayment(monthlyPayment: number, annualRate: number, years: number): number {
  const n = years * 12;
  const i = annualRate / 100 / 12;
  if (n <= 0) return 0;
  return i === 0 ? monthlyPayment * n : monthlyPayment * ((1 - Math.pow(1 + i, -n)) / i);
}

/** Monthly contribution needed to grow `principal` to `targetFv` over `years`. */
function contributionForTarget(
  targetFv: number,
  principal: number,
  annualRate: number,
  years: number
): number {
  const n = years * 12;
  const i = annualRate / 100 / 12;
  const principalFv = i === 0 ? principal : principal * Math.pow(1 + i, n);
  const remaining = targetFv - principalFv;
  if (remaining <= 0) return 0;

  const annuityFactor = i === 0 ? n : (Math.pow(1 + i, n) - 1) / i;
  return remaining / annuityFactor;
}

export function calculateForward(input: ForwardInput): ForwardResult {
  const { initialInvestment, monthlyContribution, yearsUntilPayout, accumulationRate, payoutYears, payoutRate } =
    input;

  const valueAtPayoutStart = futureValue(
    initialInvestment,
    monthlyContribution,
    accumulationRate,
    yearsUntilPayout
  );
  const totalContributions = initialInvestment + monthlyContribution * yearsUntilPayout * 12;
  const totalGrowth = valueAtPayoutStart - totalContributions;

  const monthlyIncome = paymentFromLumpSum(valueAtPayoutStart, payoutRate, payoutYears);
  const annualIncome = monthlyIncome * 12;
  const totalIncomePaid = monthlyIncome * payoutYears * 12;

  return { totalContributions, totalGrowth, valueAtPayoutStart, monthlyIncome, annualIncome, totalIncomePaid };
}

export function calculateReverse(input: ReverseInput): ReverseResult {
  const { desiredMonthlyIncome, payoutYears, payoutRate, yearsUntilIncomeStarts, accumulationRate, currentSavings } =
    input;

  const lumpSumNeededAtPayoutStart = lumpSumFromPayment(desiredMonthlyIncome, payoutRate, payoutYears);

  const discountFactor = Math.pow(1 + accumulationRate / 100, yearsUntilIncomeStarts);
  const lumpSumNeededToday = lumpSumNeededAtPayoutStart / discountFactor;

  const additionalLumpSumNeededToday = Math.max(0, lumpSumNeededToday - currentSavings);

  const requiredMonthlyContribution = contributionForTarget(
    lumpSumNeededAtPayoutStart,
    currentSavings,
    accumulationRate,
    yearsUntilIncomeStarts
  );

  return {
    lumpSumNeededAtPayoutStart,
    lumpSumNeededToday,
    additionalLumpSumNeededToday,
    requiredMonthlyContribution,
  };
}
