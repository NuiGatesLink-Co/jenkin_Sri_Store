import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseCreatePO } from './purchasing.dto.js';

describe('parseCreatePO', () => {
  it('parses valid purchase order body with items', () => {
    const raw = {
      supplier: '  ACME Parts Co. ',
      items: [
        {
          partNo: 'BP-1234',
          name: 'Front Brake Pad',
          qty: 10,
          cost: '250.50',
        },
        {
          partNo: 'SP-9999',
          name: 'Spark Plug',
          qty: 50,
          cost: 15,
        },
      ],
    };

    const parsed = parseCreatePO(raw);

    expect(parsed.supplier).toBe('ACME Parts Co.');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toEqual({
      lineNo: 1,
      partNo: 'BP-1234',
      name: 'Front Brake Pad',
      qty: 10,
      costSatang: 25050,
      cost: '250.50',
    });
    expect(parsed.items[1]).toEqual({
      lineNo: 2,
      partNo: 'SP-9999',
      name: 'Spark Plug',
      qty: 50,
      costSatang: 1500,
      cost: '15.00',
    });
  });

  it('rejects empty supplier', () => {
    expect(() => parseCreatePO({ supplier: '   ', items: [{ partNo: 'P1', name: 'N1', qty: 1, cost: '10.00' }] })).toThrow(
      BadRequestException,
    );
  });

  it('rejects empty items array', () => {
    expect(() => parseCreatePO({ supplier: 'Supplier A', items: [] })).toThrow(BadRequestException);
  });

  it('rejects items with zero or negative qty', () => {
    expect(() =>
      parseCreatePO({
        supplier: 'Supplier A',
        items: [{ partNo: 'P1', name: 'N1', qty: 0, cost: '10.00' }],
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      parseCreatePO({
        supplier: 'Supplier A',
        items: [{ partNo: 'P1', name: 'N1', qty: -5, cost: '10.00' }],
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects negative cost', () => {
    expect(() =>
      parseCreatePO({
        supplier: 'Supplier A',
        items: [{ partNo: 'P1', name: 'N1', qty: 1, cost: '-5.00' }],
      }),
    ).toThrow(BadRequestException);
  });

  it('accepts zero cost for freebies/promotional items', () => {
    const parsed = parseCreatePO({
      supplier: 'Supplier A',
      items: [{ partNo: 'P1', name: 'N1', qty: 1, cost: '0.00' }],
    });
    expect(parsed.items[0].costSatang).toBe(0);
    expect(parsed.items[0].cost).toBe('0.00');
  });
});
