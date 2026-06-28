import { Global, Module } from '@nestjs/common';
import { FileLoggerService } from './file-logger.service';

@Global()
@Module({
  providers: [FileLoggerService],
  exports: [FileLoggerService],
})
export class FileLoggerModule {}
