import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { SniperJournalRecord } from './sniper.types';

@Injectable()
export class SniperJournalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SniperJournalService.name);
  private readonly directory: string;
  private readonly journalPath: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private lockFd: number | null = null;

  constructor(config: ConfigService) {
    const logDir = config.get<string>('app.logDir') ?? './logs';
    this.directory = path.join(logDir, 'sniper');
    this.journalPath = path.join(this.directory, 'paper_journal.ndjson');
    this.statePath = path.join(this.directory, 'state.json');
    this.lockPath = path.join(this.directory, 'watcher.lock');
  }

  onModuleInit(): void {
    this.ensureProcessLock();
  }

  ensureProcessLock(): void {
    if (this.lockFd != null) return;
    fs.mkdirSync(this.directory, { recursive: true });
    this.acquireProcessLock();
  }

  onModuleDestroy(): void {
    if (this.lockFd != null) {
      fs.closeSync(this.lockFd);
      this.lockFd = null;
    }
    try {
      if (fs.existsSync(this.lockPath) && fs.readFileSync(this.lockPath, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch (error) {
      this.logger.warn(`Sniper process lock cleanup failed: ${(error as Error).message}`);
    }
  }

  append(record: SniperJournalRecord): void {
    try {
      fs.appendFileSync(this.journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      this.logger.error(`Sniper journal write failed: ${(error as Error).message}`);
    }
  }

  readState<T>(): T | null {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as T;
    } catch (error) {
      this.logger.error(`Sniper state restore failed: ${(error as Error).message}`);
      return null;
    }
  }

  writeState(state: unknown): void {
    const temporaryPath = `${this.statePath}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.statePath);
    } catch (error) {
      this.logger.error(`Sniper state write failed: ${(error as Error).message}`);
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  private acquireProcessLock(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.lockFd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(this.lockFd, String(process.pid), 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existingPid = this.readLockPid();
        if (existingPid != null && isProcessAlive(existingPid)) {
          throw new Error(
            `Another launch sniper is already running (pid=${existingPid}). ` +
            'Stop it before starting a second watcher.',
          );
        }
        fs.unlinkSync(this.lockPath);
      }
    }
    throw new Error('Unable to acquire launch sniper process lock');
  }

  private readLockPid(): number | null {
    try {
      const value = Number(fs.readFileSync(this.lockPath, 'utf8').trim());
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
