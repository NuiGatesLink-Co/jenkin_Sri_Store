import { describe, expect, it } from 'vitest';
import { parseSettingsPatch } from './settings.dto.js';

describe('settings.dto', () => {
  it('parses valid settings patch', () => {
    const patch = parseSettingsPatch({
      shopName: 'New Shop Name',
      taxRate: 7,
      quoteValidDays: 30,
      phone: '0812345678',
    });

    expect(patch).toEqual({
      shopName: 'New Shop Name',
      taxRate: 7,
      quoteValidDays: 30,
      phone: '0812345678',
    });
  });

  it('allows null for optional string fields', () => {
    const patch = parseSettingsPatch({
      address: null,
      phone: null,
      cashierName: null,
    });

    expect(patch).toEqual({
      address: null,
      phone: null,
      cashierName: null,
    });
  });

  it('throws on non-object body', () => {
    expect(() => parseSettingsPatch('not an object')).toThrow('JSON object');
  });

  it('throws on empty shopName', () => {
    expect(() => parseSettingsPatch({ shopName: '  ' })).toThrow("Field 'shopName' must be a non-empty string");
  });

  it('throws on invalid taxRate', () => {
    expect(() => parseSettingsPatch({ taxRate: -5 })).toThrow("Field 'taxRate' must be a number between 0 and 100");
    expect(() => parseSettingsPatch({ taxRate: 105 })).toThrow("Field 'taxRate' must be a number between 0 and 100");
    expect(() => parseSettingsPatch({ taxRate: 7.123 })).toThrow("Field 'taxRate' must have at most 2 decimal places");
  });

  it('throws on non-integer quoteValidDays', () => {
    expect(() => parseSettingsPatch({ quoteValidDays: 12.5 })).toThrow("Field 'quoteValidDays' must be an integer >= 1");
  });
});
