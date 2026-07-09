import { bigintRatioToNumber, decimalToRawAmount, rawToDecimalNumber } from './bigint-math';

describe('bigint math helpers', () => {
  it('converts raw token amounts without Number(bigint) precision loss', () => {
    const raw = 123456789012345678901234567890n;

    expect(rawToDecimalNumber(raw, 18)).toBeCloseTo(123456789012.34567, 5);
  });

  it('converts decimal amounts to raw bigint units', () => {
    expect(decimalToRawAmount(0.025, 18)).toBe(25_000_000_000_000_000n);
    expect(decimalToRawAmount(12.345678, 6)).toBe(12_345_678n);
  });

  it('converts bigint ratios without casting operands to Number first', () => {
    expect(bigintRatioToNumber(1n, 4n)).toBe(0.25);
    expect(bigintRatioToNumber(12345678901234567890n, 10n ** 18n)).toBeCloseTo(12.345678901234567, 12);
  });
});
