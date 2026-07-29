import * as fs from 'fs';
import * as path from 'path';

describe('runtime ownership', () => {
  it('keeps Solana services out of the main runtime', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'app.module.ts'), 'utf8');
    expect(source).not.toContain("from './solana/solana.module'");
  });

  it('keeps Solana services in the dedicated headless runtime', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'solana', 'solana-app.module.ts'), 'utf8');
    expect(source).toContain("from './solana.module'");
    expect(source).toContain('SolanaModule');
  });
});
