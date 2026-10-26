/**
 * Mortgage quotes with standard French amortisation (fixed payment).
 * Rates are plausible for Mexico 2026: bank mortgages ≈ 10.4% + risk spread; INFONAVIT 7.9–10.45%;
 * FOVISSSTE ≈ 9.15–10.3%; COFINAVIT (bank + INFONAVIT co-financing) slightly above bank rates.
 */
import type { MortgageParams, MortgageQuote } from '../core/types';
import { BASE_MORTGAGE_RATE } from './market';
import { clamp, clamp01 } from './util';

type Product = NonNullable<MortgageParams['product']>;

const LABEL: Record<Product, string> = {
  bancario: 'Crédito bancario',
  infonavit: 'INFONAVIT',
  fovissste: 'FOVISSSTE',
  cofinavit: 'COFINAVIT',
};

/** annual rate % for a product given the cell rate (bank pricing) and credit risk 0..1 */
export function productRate(product: Product, cellRate: number, risk: number): number {
  switch (product) {
    case 'infonavit':
      return 7.9 + 2.55 * clamp01(risk);
    case 'fovissste':
      return 9.15 + 1.15 * clamp01(risk);
    case 'cofinavit':
      return cellRate + 0.6;
    case 'bancario':
    default:
      return cellRate;
  }
}

/** CAT (Costo Anual Total) = rate + insurance, commissions and fees: +1.5…3.5 pts */
function catFor(product: Product, rate: number, risk: number): number {
  const extra: Record<Product, number> = { bancario: 2.1 + 0.9 * risk, infonavit: 1.6, fovissste: 1.5, cofinavit: 2.4 + 0.8 * risk };
  return rate + clamp(extra[product], 1.5, 3.5);
}

export function quoteMortgage(p: MortgageParams, cellRate: number | null, cellRisk: number | null): MortgageQuote {
  const product: Product = p.product ?? 'bancario';
  const price = Math.max(0, p.price || 0);
  const down = clamp(p.downPayment || 0, 0, price);
  const principal = Math.max(0, price - down);
  const years = clamp(Math.round(p.years || 20), 1, 30);
  const risk = cellRisk ?? 0.3;
  const bankRate = cellRate ?? BASE_MORTGAGE_RATE + 1.2;
  const rate = p.rate !== undefined && p.rate > 0 ? p.rate : productRate(product, bankRate, risk);
  const cat = catFor(product, rate, risk);
  const nper = years * 12;
  const r = rate / 100 / 12;
  const monthlyPayment = principal <= 0 ? 0 : r > 0 ? (principal * r) / (1 - Math.pow(1 + r, -nper)) : principal / nper;
  const totalPaid = monthlyPayment * nper;
  const ltv = price > 0 ? principal / price : 0;
  // risk: property / borrower risk + leverage + long terms
  const score = risk * 0.6 + Math.max(0, ltv - 0.7) * 1.5 + (years > 20 ? 0.05 : 0);
  const riskLabel: MortgageQuote['risk'] = score < 0.3 ? 'bajo' : score < 0.5 ? 'medio' : 'alto';
  return {
    principal,
    rate,
    cat,
    years,
    monthlyPayment,
    totalPaid,
    requiredIncome: monthlyPayment / 0.3, // payment ≤ 30% of monthly income
    ltv,
    risk: riskLabel,
    product: LABEL[product],
  };
}
