import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SupportedChain } from '../collector/collector.types';

export const RUG_LIKE_OUTCOMES = new Set(['RUG', 'UNSELLABLE', 'LIQ_PULL']);

export interface DeployerReputationSummary {
  chain: SupportedChain;
  address: string;
  deploymentsCount: number;
  rugLikeCount: number;
  rugRate: number;
  riskScore: number;
}

export interface DeployerReputationRefreshResult {
  deployersUpdated: number;
  deploymentsTracked: number;
  rugLikeTokens: number;
}

interface MutableSummary {
  chain: SupportedChain;
  address: string;
  deployments: Set<string>;
  rugLikeTokens: Set<string>;
}

@Injectable()
export class DeployerReputationService {
  private readonly logger = new Logger(DeployerReputationService.name);
  private readonly minDeployments: number;
  private readonly minRugLike: number;
  private readonly minRugRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.minDeployments =
      this.config.get<number>('collector.deployerGateMinDeployments') ?? 2;
    this.minRugLike =
      this.config.get<number>('collector.deployerGateMinRugLike') ?? 2;
    this.minRugRate =
      this.config.get<number>('collector.deployerGateMinRugRate') ?? 0.5;
  }

  isRepeatRugger(summary: DeployerReputationSummary): boolean {
    return (
      summary.deploymentsCount >= this.minDeployments &&
      summary.rugLikeCount >= this.minRugLike &&
      summary.rugRate >= this.minRugRate
    );
  }

  async summarize(
    chain: SupportedChain,
    deployerAddress: string,
  ): Promise<DeployerReputationSummary | null> {
    const address = this.normalizeAddress(deployerAddress);
    if (!address) return null;

    const [deployerRow, tokens, gemCandidates] = await Promise.all([
      this.prisma.deployer.findUnique({
        where: { chain_address: { chain, address } },
      }),
      this.prisma.token.findMany({
        where: { chain, deployerAddress: address },
        select: {
          tokenAddress: true,
          paperPositions: { select: { outcomeClass: true } },
        },
      }),
      this.prisma.gemCandidate.findMany({
        where: { chain, deployerAddress: address },
        select: {
          tokenAddress: true,
          ticks: {
            where: { rugFlag: true },
            select: { id: true },
            take: 1,
          },
        },
      }),
    ]);

    const deployments = new Set<string>();
    const rugLikeTokens = new Set<string>();

    for (const token of tokens) {
      const tokenAddress = token.tokenAddress.toLowerCase();
      deployments.add(tokenAddress);
      if (
        token.paperPositions.some((position) =>
          position.outcomeClass ? RUG_LIKE_OUTCOMES.has(position.outcomeClass) : false,
        )
      ) {
        rugLikeTokens.add(tokenAddress);
      }
    }

    for (const candidate of gemCandidates) {
      const tokenAddress = candidate.tokenAddress.toLowerCase();
      deployments.add(tokenAddress);
      if (candidate.ticks.length > 0) {
        rugLikeTokens.add(tokenAddress);
      }
    }

    const deploymentsCount = Math.max(
      deployerRow?.deploymentsCount ?? 0,
      deployments.size,
    );
    const rugLikeCount = Math.max(
      deployerRow?.rugLikeCount ?? 0,
      rugLikeTokens.size,
    );
    const riskScore = this.riskScore(deploymentsCount, rugLikeCount);

    return {
      chain,
      address,
      deploymentsCount,
      rugLikeCount,
      rugRate: deploymentsCount > 0 ? rugLikeCount / deploymentsCount : 0,
      riskScore,
    };
  }

  async refreshAll(): Promise<DeployerReputationRefreshResult> {
    const summaries = new Map<string, MutableSummary>();

    const ensure = (chain: SupportedChain, address: string): MutableSummary => {
      const key = `${chain}:${address}`;
      let summary = summaries.get(key);
      if (!summary) {
        summary = {
          chain,
          address,
          deployments: new Set<string>(),
          rugLikeTokens: new Set<string>(),
        };
        summaries.set(key, summary);
      }
      return summary;
    };

    const tokens = await this.prisma.token.findMany({
      where: { deployerAddress: { not: null } },
      select: {
        chain: true,
        tokenAddress: true,
        deployerAddress: true,
        paperPositions: { select: { outcomeClass: true } },
      },
    });

    for (const token of tokens) {
      const chain = token.chain as SupportedChain;
      const address = this.normalizeAddress(token.deployerAddress);
      if (!address) continue;

      const summary = ensure(chain, address);
      const tokenAddress = token.tokenAddress.toLowerCase();
      summary.deployments.add(tokenAddress);
      if (
        token.paperPositions.some((position) =>
          position.outcomeClass ? RUG_LIKE_OUTCOMES.has(position.outcomeClass) : false,
        )
      ) {
        summary.rugLikeTokens.add(tokenAddress);
      }
    }

    const gemCandidates = await this.prisma.gemCandidate.findMany({
      where: { deployerAddress: { not: null } },
      select: {
        chain: true,
        tokenAddress: true,
        deployerAddress: true,
        ticks: {
          where: { rugFlag: true },
          select: { id: true },
          take: 1,
        },
      },
    });

    for (const candidate of gemCandidates) {
      const chain = candidate.chain as SupportedChain;
      const address = this.normalizeAddress(candidate.deployerAddress);
      if (!address) continue;

      const summary = ensure(chain, address);
      const tokenAddress = candidate.tokenAddress.toLowerCase();
      summary.deployments.add(tokenAddress);
      if (candidate.ticks.length > 0) {
        summary.rugLikeTokens.add(tokenAddress);
      }
    }

    let deploymentsTracked = 0;
    let rugLikeTokens = 0;

    for (const summary of summaries.values()) {
      const deploymentsCount = summary.deployments.size;
      const rugLikeCount = summary.rugLikeTokens.size;
      deploymentsTracked += deploymentsCount;
      rugLikeTokens += rugLikeCount;

      await this.prisma.deployer.upsert({
        where: {
          chain_address: { chain: summary.chain, address: summary.address },
        },
        create: {
          chain: summary.chain,
          address: summary.address,
          deploymentsCount,
          rugLikeCount,
          riskScore: this.riskScore(deploymentsCount, rugLikeCount),
          summary: this.summaryText(deploymentsCount, rugLikeCount),
        },
        update: {
          deploymentsCount,
          rugLikeCount,
          riskScore: this.riskScore(deploymentsCount, rugLikeCount),
          summary: this.summaryText(deploymentsCount, rugLikeCount),
        },
      });
    }

    const result = {
      deployersUpdated: summaries.size,
      deploymentsTracked,
      rugLikeTokens,
    };
    this.logger.log(
      `Deployer reputation refreshed: deployers=${result.deployersUpdated} ` +
      `deployments=${result.deploymentsTracked} rug_like=${result.rugLikeTokens}`,
    );
    return result;
  }

  private normalizeAddress(value?: string | null): string | null {
    return value ? value.toLowerCase() : null;
  }

  private riskScore(deploymentsCount: number, rugLikeCount: number): number {
    if (deploymentsCount <= 0) return 0;
    return Number(((rugLikeCount / deploymentsCount) * 100).toFixed(2));
  }

  private summaryText(deploymentsCount: number, rugLikeCount: number): string {
    const pct = this.riskScore(deploymentsCount, rugLikeCount).toFixed(2);
    return `${rugLikeCount}/${deploymentsCount} rug-like outcomes (${pct}%)`;
  }
}
