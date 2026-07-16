import { Module } from '@nestjs/common';
import { FourMemeSourceService } from './four-meme-source.service';
import { LaunchSniperService } from './launch-sniper.service';
import { SniperJournalService } from './sniper-journal.service';

@Module({
  providers: [FourMemeSourceService, SniperJournalService, LaunchSniperService],
  exports: [LaunchSniperService],
})
export class SniperModule {}

