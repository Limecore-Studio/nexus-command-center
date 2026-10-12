import { describe, it, expect } from 'vitest';
import { numberInput } from './numberInput';

// v1.18.1 (NCC#144) — parseFloat("12,50") is 12. Every money and quantity
// field now reads typed values through numberInput.
describe('numberInput', () => {
  it('reads a decimal comma', () => {
    expect(numberInput('12,50')).toBe(12.5);
    expect(numberInput('0,99')).toBe(0.99);
    expect(numberInput('-3,5')).toBe(-3.5);
    expect(numberInput('€ 12,50')).toBe(12.5);
  });

  it('reads both separators, the last one being the decimal', () => {
    expect(numberInput('1.234,56')).toBe(1234.56);
    expect(numberInput('1,234.56')).toBe(1234.56);
    expect(numberInput('1 234,56')).toBe(1234.56);
  });

  it('reads repeated separators as thousands', () => {
    expect(numberInput('1.234.567')).toBe(1234567);
    expect(numberInput('1,234,567')).toBe(1234567);
  });

  // Review of the first version: a locale guess read these as ×1000, and edit
  // forms prefill stored values with String(n).
  it('round-trips every stored value an edit form prefills with String(n)', () => {
    for (const x of [0.125, 1.125, 12.345, 1234.567, 52345.678, 0.001, 1.5, 1500, 9e-7, 1e21, 0.1 + 0.2]) {
      expect(numberInput(String(x))).toBe(x);
    }
  });

  it('keeps plain numbers and NaN for nothing', () => {
    expect(numberInput('12')).toBe(12);
    expect(numberInput('12.5')).toBe(12.5);
    expect(numberInput('')).toBeNaN();
    expect(numberInput('abc')).toBeNaN();
    expect(numberInput(undefined)).toBeNaN();
  });
});
