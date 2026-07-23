import { Module } from '@nestjs/common';
import { SolanaLaunchPaperService } from './solana-launch-paper.service';
import { SolanaMultiLaunchService } from './solana-multi-launch.service';
import { SolanaProtocolQuoteService } from './solana-protocol-quote.service';

@Module({
  providers: [SolanaProtocolQuoteService, SolanaLaunchPaperService, SolanaMultiLaunchService],
  exports: [SolanaLaunchPaperService, SolanaMultiLaunchService],
})
export class SolanaModule {}
