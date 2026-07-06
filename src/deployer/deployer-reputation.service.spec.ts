import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeployerReputationService } from './deployer-reputation.service';

describe('DeployerReputationService', () => {
  let tempDir: string;

  const prismaMock = {
    deployer: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    token: {
      findMany: jest.fn(),
    },
    gemCandidate: {
      findMany: jest.fn(),
    },
  };

  const configMock = {
    get: jest.fn((key: string) => {
      const cfg: Record<string, unknown> = {
        'collector.deployerGateMinDeployments': 2,
        'collector.deployerGateMinRugLike': 2,
        'collector.deployerGateMinRugRate': 0.5,
        'collector.blockedDeployers': [],
        'app.logDir': tempDir,
      };
      return cfg[key];
    }),
  };

  let service: DeployerReputationService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-reputation-test-'));
    jest.clearAllMocks();
    prismaMock.deployer.findUnique.mockResolvedValue(null);
    prismaMock.deployer.upsert.mockResolvedValue({});
    prismaMock.token.findMany.mockResolvedValue([]);
    prismaMock.gemCandidate.findMany.mockResolvedValue([]);
    service = new DeployerReputationService(
      prismaMock as any,
      configMock as unknown as ConfigService,
    );
  });

  it('persists and reads manual deployer blocklist entries', async () => {
    await service.addBlocklistEntry(
      'base',
      '0xF7FB648752D1cF4B18fCbA3D3F33D2C44e4E80fC',
      'repeat openhuman rugs',
      'operator',
    );

    await expect(
      service.findBlocklistHit('base', '0xf7fb648752d1cf4b18fcba3d3f33d2c44e4e80fc'),
    ).resolves.toEqual({
      chain: 'base',
      address: '0xf7fb648752d1cf4b18fcba3d3f33d2c44e4e80fc',
      source: 'operator',
      reason: 'repeat openhuman rugs',
    });
  });

  it('summarizes paper and shadow rug-like history for one deployer', async () => {
    prismaMock.token.findMany.mockResolvedValue([
      {
        tokenAddress: '0xaaa',
        paperPositions: [{ outcomeClass: 'RUG' }],
      },
      {
        tokenAddress: '0xbbb',
        paperPositions: [{ outcomeClass: 'WIN' }],
      },
    ]);
    prismaMock.gemCandidate.findMany.mockResolvedValue([
      { tokenAddress: '0xccc', ticks: [{ id: 'tick-1' }] },
    ]);

    const summary = await service.summarize('base', '0xDeployer');

    expect(summary).toEqual({
      chain: 'base',
      address: '0xdeployer',
      deploymentsCount: 3,
      rugLikeCount: 2,
      rugRate: 2 / 3,
      riskScore: 66.67,
    });
    expect(service.isRepeatRugger(summary!)).toBe(true);
  });

  it('does not mark a deployer as repeat rugger from one bad token', () => {
    expect(
      service.isRepeatRugger({
        chain: 'ethereum',
        address: '0xonebad',
        deploymentsCount: 2,
        rugLikeCount: 1,
        rugRate: 0.5,
        riskScore: 50,
      }),
    ).toBe(false);
  });

  it('refreshAll upserts deployer aggregates from paper and gem data', async () => {
    prismaMock.token.findMany.mockResolvedValue([
      {
        chain: 'base',
        tokenAddress: '0xaaa',
        deployerAddress: '0xDeployer',
        paperPositions: [{ outcomeClass: 'LIQ_PULL' }],
      },
      {
        chain: 'base',
        tokenAddress: '0xbbb',
        deployerAddress: '0xDeployer',
        paperPositions: [{ outcomeClass: 'LOSS' }],
      },
    ]);
    prismaMock.gemCandidate.findMany.mockResolvedValue([
      {
        chain: 'base',
        tokenAddress: '0xccc',
        deployerAddress: '0xDeployer',
        ticks: [{ id: 'tick-1' }],
      },
    ]);

    const result = await service.refreshAll();

    expect(result).toEqual({
      deployersUpdated: 1,
      deploymentsTracked: 3,
      rugLikeTokens: 2,
    });
    expect(prismaMock.deployer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chain_address: { chain: 'base', address: '0xdeployer' } },
        update: expect.objectContaining({
          deploymentsCount: 3,
          rugLikeCount: 2,
          riskScore: 66.67,
        }),
      }),
    );
  });
});
