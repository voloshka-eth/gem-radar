import { EdgeService } from './edge.service';

describe('EdgeService', () => {
  it('excludes the Robinhood experimental cohort from primary edge statistics', async () => {
    const prisma = {
      paperPosition: {
        findMany: jest.fn().mockResolvedValue([
          { realizedMultiple: 2, entryFeatures: { finalScore: 80, band: 'candidate', fdvUsd: 10_000 } },
          {
            realizedMultiple: 1_000,
            entryFeatures: {
              finalScore: 99,
              band: 'high_band',
              fdvUsd: 10_000,
              riskCohort: 'ROBINHOOD_EXPERIMENTAL_NO_PROVIDER',
            },
          },
        ]),
      },
    };
    const logger = { writeReport: jest.fn() };
    const service = new EdgeService({ get: jest.fn(() => 1) } as any, prisma as any, logger as any);

    const report = await service.run();

    expect(report).toContain('Closed positions:        1');
    expect(report).toContain('EXPERIMENTAL/RESEARCH COHORTS EXCLUDED FROM PRIMARY EDGE: 1');
  });
});
