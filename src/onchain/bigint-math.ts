export function rawToDecimalNumber(raw: bigint, decimals: number): number {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = abs % scale;

  if (fraction === 0n) {
    return Number(`${negative ? '-' : ''}${whole.toString()}`);
  }

  const fractionText = fraction
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return Number(`${negative ? '-' : ''}${whole.toString()}.${fractionText}`);
}

export function decimalToRawAmount(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const text = value.toString();
  const fixed = /e/i.test(text) ? value.toFixed(decimals) : text;
  const [whole, fraction = ''] = fixed.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '') || '0');
}

export function bigintRatioToNumber(numerator: bigint, denominator: bigint, precision = 24): number {
  if (denominator === 0n) throw new Error('Cannot divide by zero');
  if (precision < 0 || !Number.isInteger(precision)) {
    throw new Error(`Invalid precision: ${precision}`);
  }

  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const whole = n / d;
  const remainder = n % d;

  if (remainder === 0n || precision === 0) {
    return Number(`${negative ? '-' : ''}${whole.toString()}`);
  }

  const scale = 10n ** BigInt(precision);
  const fraction = (remainder * scale) / d;
  const fractionText = fraction
    .toString()
    .padStart(precision, '0')
    .replace(/0+$/, '');

  return Number(`${negative ? '-' : ''}${whole.toString()}.${fractionText || '0'}`);
}
