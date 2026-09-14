import { jsNumber, weightedAverageCostSatang } from './weighted-average.js';

/** Every weighted-average case in `frontend/test/purchase_orders_repository_test.dart`. */
describe('weightedAverageCostSatang', () => {
  it('10@100 + 5@160 → 120.00 (the Dart exact-average case)', () => {
    expect(weightedAverageCostSatang(10, 10_000, 5, 16_000)).toBe(12_000);
  });

  it('a line at cost zero leaves the average at the old cost (Dart fallback case)', () => {
    expect(weightedAverageCostSatang(10, 10_000, 5, 0)).toBe(10_000);
  });

  it('zero stock takes the incoming cost, whatever the old cost was', () => {
    expect(weightedAverageCostSatang(0, 9_000, 4, 12_550)).toBe(12_550);
  });

  it('zero stock and a zero-cost line keeps the old cost', () => {
    expect(weightedAverageCostSatang(0, 9_000, 4, 0)).toBe(9_000);
  });

  it('rounds to the satang, half up: (1×100 + 2×100.01)/3 = 100.0066… → 100.01', () => {
    expect(weightedAverageCostSatang(1, 10_000, 2, 10_001)).toBe(10_001);
  });

  it('rounds an exact half satang up: (3×0.10 + 1×0.20)/4 = 0.125 → 0.13', () => {
    expect(weightedAverageCostSatang(3, 10, 1, 20)).toBe(13);
  });

  it('matches Dart round2 on a non-terminating average: (7×33.33 + 3×41.07)/10 = 35.652 → 35.65', () => {
    expect(weightedAverageCostSatang(7, 3_333, 3, 4_107)).toBe(3_565);
  });

  it('stays exact where stock × cost passes 2^53', () => {
    const stock = 2_000_000_000;
    const cost = 999_999_999_999; // 9,999,999,999.99 baht
    expect(weightedAverageCostSatang(stock, cost, 1, cost)).toBe(cost);
  });

  it('the total-qty fallback returns the effective cost instead of dividing by zero', () => {
    expect(weightedAverageCostSatang(-5, 10_000, 5, 16_000)).toBe(16_000);
  });
});

describe('jsNumber', () => {
  it('renders like a JS template literal', () => {
    expect(jsNumber(12_000)).toBe('120');
    expect(jsNumber(13_333)).toBe('133.33');
    expect(jsNumber(12_050)).toBe('120.5');
  });
});
