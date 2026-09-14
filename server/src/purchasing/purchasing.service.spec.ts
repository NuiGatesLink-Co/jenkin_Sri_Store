import { describe, expect, it } from 'vitest';
import { satangOf, fromSatang } from '../common/money.js';

function computeWeightedAverage(
  oldStock: number,
  oldCostStr: string,
  newQty: number,
  newCostStr: string,
): { stockAfter: number; costAfter: string } {
  const oldCostSatang = satangOf(oldCostStr);
  const incomingCostSatang = satangOf(newCostStr);

  const effectiveNewCostSatang = incomingCostSatang > 0 ? incomingCostSatang : oldCostSatang;
  const totalQty = oldStock + newQty;

  let newCostSatang: number;
  if (totalQty <= 0) {
    newCostSatang = effectiveNewCostSatang;
  } else {
    const rawNewCost = (oldStock * oldCostSatang + newQty * effectiveNewCostSatang) / totalQty;
    newCostSatang = Math.round(rawNewCost);
  }

  return {
    stockAfter: totalQty,
    costAfter: fromSatang(newCostSatang),
  };
}

describe('Weighted-Average Cost Calculation Unit Tests', () => {
  it('calculates standard weighted average cost', () => {
    // 10 units @ 100.00, receive 5 units @ 120.00 -> total 15 units @ 106.67
    const result = computeWeightedAverage(10, '100.00', 5, '120.00');
    expect(result.stockAfter).toBe(15);
    expect(result.costAfter).toBe('106.67');
  });

  it('leaves average cost unchanged when receiving a line with cost zero', () => {
    // 10 units @ 100.00, receive 5 free units @ 0.00 -> total 15 units @ 100.00
    const result = computeWeightedAverage(10, '100.00', 5, '0.00');
    expect(result.stockAfter).toBe(15);
    expect(result.costAfter).toBe('100.00');
  });

  it('sets cost to incoming cost when receiving into zero stock', () => {
    // 0 units @ 50.00, receive 10 units @ 80.00 -> total 10 units @ 80.00
    const result = computeWeightedAverage(0, '50.00', 10, '80.00');
    expect(result.stockAfter).toBe(10);
    expect(result.costAfter).toBe('80.00');
  });

  it('handles half-satang rounding (1@1.00 + 1@1.01 = 1.01)', () => {
    // 1 unit @ 1.00, receive 1 unit @ 1.01 -> total 2 units @ (100 + 101)/2 = 100.5 -> 101 -> 1.01
    const result = computeWeightedAverage(1, '1.00', 1, '1.01');
    expect(result.stockAfter).toBe(2);
    expect(result.costAfter).toBe('1.01');
  });

  it('handles sequential line receives correctly', () => {
    // Start 0 @ 0.00
    let state = computeWeightedAverage(0, '0.00', 1, '1.00');
    expect(state.stockAfter).toBe(1);
    expect(state.costAfter).toBe('1.00');

    state = computeWeightedAverage(state.stockAfter, state.costAfter, 1, '1.01');
    expect(state.stockAfter).toBe(2);
    expect(state.costAfter).toBe('1.01');
  });
});
