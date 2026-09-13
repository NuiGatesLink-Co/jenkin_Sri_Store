import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from './config.js';
import { LOGGER } from '../infra/logger.provider.js';

export const LOG_LEVEL_KEY = '/pos/config/log_level';
export const VALID_LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

const CONNECT_TIMEOUT_MS = 1_500;
const RECONNECT_DELAY_MS = 3_000;

/**
 * RuntimeConfigService: Dynamic runtime configuration via etcd v3 (ADR-0013, 07_CICD_DEPLOY.md §8).
 *
 * - Reads and watches `/pos/config/log_level` over etcd v3's gRPC-gateway HTTP API (/v3/kv/range, /v3/watch)
 *   using Node.js native `fetch` (no external grpc-js/etcd3 dependencies).
 * - Mutates `logger.level` in real-time without requiring application restart.
 * - Fail-open invariant: If etcd is unreachable or unconfigured, logs a warning once and gracefully
 *   falls back to the environment configuration (`LOG_LEVEL`).
 */
@Injectable()
export class RuntimeConfigService implements OnModuleInit, OnModuleDestroy {
  private abortController?: AbortController;
  private isStopped = false;
  private authToken?: string;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initiate background connection and watch loop (does not block application bootstrap)
    await this.start();
  }

  onModuleDestroy(): void {
    this.isStopped = true;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async start(): Promise<void> {
    const rawUrl = this.config.etcdUrl;
    if (!rawUrl) {
      return;
    }
    const etcdUrl = rawUrl.replace(/\/+$/, '');

    this.abortController = new AbortController();

    try {
      // 1. Authenticate if password provided
      if (this.config.etcdPassword) {
        await this.authenticate(etcdUrl);
      }

      // 2. Fetch initial log_level from etcd
      await this.fetchInitialLogLevel(etcdUrl);

      // 3. Start background watch loop for real-time updates
      void this.runWatchLoop(etcdUrl);
    } catch (err: any) {
      this.logger.warn(
        { err: err?.message || String(err) },
        'etcd unavailable, using environment configuration',
      );
    }
  }

  /**
   * Authenticate against etcd v3 gRPC-gateway endpoint POST /v3/auth/authenticate.
   */
  async authenticate(etcdUrl: string): Promise<void> {
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const resp = await fetch(`${etcdUrl}/v3/auth/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'root',
        password: this.config.etcdPassword,
      }),
      signal,
    });

    if (!resp.ok) {
      throw new Error(`etcd auth failed with HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as { token?: string };
    if (data.token) {
      this.authToken = data.token;
    }
  }

  /**
   * Fetch initial log_level key via POST /v3/kv/range.
   */
  async fetchInitialLogLevel(etcdUrl: string): Promise<void> {
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers.Authorization = this.authToken;
      headers.token = this.authToken;
    }

    const keyBase64 = Buffer.from(LOG_LEVEL_KEY).toString('base64');
    const resp = await fetch(`${etcdUrl}/v3/kv/range`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: keyBase64 }),
      signal,
    });

    if (!resp.ok) {
      throw new Error(`etcd range request failed with HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      kvs?: Array<{ key: string; value: string }>;
    };

    if (data.kvs && data.kvs.length > 0) {
      const rawVal = Buffer.from(data.kvs[0].value, 'base64')
        .toString('utf8')
        .trim()
        .toLowerCase();

      this.applyLogLevel(rawVal, 'initial');
    }
  }

  /**
   * Validates and applies a log level change to pino logger.
   */
  applyLogLevel(newLevel: string, source: 'initial' | 'watch'): boolean {
    if (!VALID_LOG_LEVELS.has(newLevel)) {
      this.logger.warn(
        { invalidLevel: newLevel, source },
        'Ignoring invalid log level received from etcd',
      );
      return false;
    }

    const oldLevel = this.logger.level;
    if (oldLevel !== newLevel) {
      this.logger.level = newLevel;
      this.logger.info(
        { oldLevel, newLevel, source },
        `Runtime config updated log level to '${newLevel}' from etcd`,
      );
    }
    return true;
  }

  /**
   * Persistent watch loop against POST /v3/watch.
   */
  private async runWatchLoop(etcdUrl: string): Promise<void> {
    while (!this.isStopped) {
      try {
        if (this.config.etcdPassword && !this.authToken) {
          await this.authenticate(etcdUrl);
        }
        await this.watchStream(etcdUrl);
      } catch (err: any) {
        if (this.isStopped) break;
        if (String(err?.message).includes('401')) {
          this.authToken = undefined;
        }
        this.logger.warn(
          { err: err?.message || String(err) },
          'etcd watch stream interrupted; reconnecting...',
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RECONNECT_DELAY_MS);
          this.abortController?.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }

  /**
   * Single watch streaming connection.
   */
  async watchStream(etcdUrl: string): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers.Authorization = this.authToken;
      headers.token = this.authToken;
    }

    const keyBase64 = Buffer.from(LOG_LEVEL_KEY).toString('base64');
    const resp = await fetch(`${etcdUrl}/v3/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        create_request: { key: keyBase64 },
      }),
      signal: this.abortController?.signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`etcd watch initiation failed with HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!this.isStopped) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const payload = JSON.parse(trimmed);
          this.handleWatchPayload(payload);
        } catch {
          // ignore chunk boundary JSON fragments
        }
      }
    }
  }

  /**
   * Parses gRPC-gateway JSON event payload from watch stream.
   */
  handleWatchPayload(payload: any): void {
    const events = payload?.result?.events;
    if (!Array.isArray(events)) return;

    for (const event of events) {
      // type can be 0 or 'PUT' or undefined for a PUT event
      const isPut =
        event.type === 'PUT' || event.type === 0 || event.type === undefined;
      if (isPut && event.kv?.value) {
        const val = Buffer.from(event.kv.value, 'base64')
          .toString('utf8')
          .trim()
          .toLowerCase();

        this.applyLogLevel(val, 'watch');
      }
    }
  }
}
