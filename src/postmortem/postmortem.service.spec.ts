import { PostmortemService } from './postmortem.service';

describe('PostmortemService', () => {
  it('excludes the Robinhood experimental cohort from the primary post-mortem', async () => {
    const prisma = {
      paperPosition: {
        findMany: jest.fn().mockResolvedValue([
          { outcomeClass: 'LOSS', entryFeatures: { finalScore: 60 }, lastSellersToBuyersRatio: null, lastSellSimOk: null },
          {
            outcomeClass: 'WIN',
            entryFeatures: { finalScore: 99, riskCohort: 'ROBINHOOD_EXPERIMENTAL_NO_PROVIDER' },
            lastSellersToBuyersRatio: null,
            lastSellSimOk: null,
          },
        ]),
      },
    };
    const logger = { writeReport: jest.fn() };
    const service = new PostmortemService({ get: jest.fn(() => 1) } as any, prisma as any, logger as any);

    const report = await service.run();

    expect(report).toContain('RUGGED/LOSS group (BAD):   n=1');
    expect(report).toContain('SURVIVED/WIN group (GOOD): n=0');
    expect(report).toContain('EXPERIMENTAL COHORT EXCLUDED FROM PRIMARY POST-MORTEM: 1');
  });
});
