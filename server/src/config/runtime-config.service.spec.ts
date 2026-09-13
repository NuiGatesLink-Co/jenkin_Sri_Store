import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { RuntimeConfigService, LOG_LEVEL_KEY } from './runtime-config.service.js';
import type { AppConfig } from './config.js';

describe('RuntimeConfigService', () => {
  let mockLogger: Partial<Logger> & { level: string };
  let mockConfig: AppConfig;
  let service: RuntimeConfigService;

  beforeEach(() => {
    mockLogger = {
      level: 'info',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockConfig = {
      port: 3000,
      instanceId: 'api-1',
      logLevel: 'info',
      databaseUrl: 'postgres://localhost/pos',
      adminDatabaseUrl: 'postgres://localhost/pos',
      dbPoolSize: 5,
      redisCacheUrl: 'redis://localhost:6379',
      redisQueueUrl: 'redis://localhost:6380',
      jwtPlatformSecret: 'secret',
      jwtTenantSecret: 'secret',
      etcdUrl: 'http://127.0.0.1:2379',
    };

    service = new RuntimeConfigService(mockConfig, mockLogger as Logger);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('does nothing when etcdUrl is not defined', async () => {
    mockConfig.etcdUrl = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await service.start();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogger.level).toBe('info');
  });

  it('fails open and logs warning once when etcd is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await service.start();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ECONNREFUSED' }),
      'etcd unavailable, using environment configuration',
    );
    expect(mockLogger.level).toBe('info');
  });

  it('fetches initial log_level from etcd and updates logger.level', async () => {
    const keyBase64 = Buffer.from(LOG_LEVEL_KEY).toString('base64');
    const valBase64 = Buffer.from('debug').toString('base64');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        kvs: [{ key: keyBase64, value: valBase64 }],
      }),
    } as Response);

    // Mock watchLoop so it does not block
    vi.spyOn<any, any>(service, 'runWatchLoop').mockImplementation(async () => {});

    await service.start();

    expect(mockLogger.level).toBe('debug');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ oldLevel: 'info', newLevel: 'debug' }),
      expect.stringContaining("Runtime config updated log level to 'debug'"),
    );
  });

  it('authenticates with etcd when etcdPassword is configured', async () => {
    mockConfig.etcdPassword = 'secret-root-password';

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'mock-jwt-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ kvs: [] }),
      } as Response);

    vi.spyOn<any, any>(service, 'runWatchLoop').mockImplementation(async () => {});

    await service.start();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:2379/v3/auth/authenticate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'root', password: 'secret-root-password' }),
      }),
    );

    // Check subsequent call contains token header
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:2379/v3/kv/range',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'mock-jwt-token',
        }),
      }),
    );
  });

  it('updates logger.level dynamically on watch event', () => {
    const valBase64 = Buffer.from('warn').toString('base64');
    const payload = {
      result: {
        events: [
          {
            type: 'PUT',
            kv: {
              key: Buffer.from(LOG_LEVEL_KEY).toString('base64'),
              value: valBase64,
            },
          },
        ],
      },
    };

    service.handleWatchPayload(payload);

    expect(mockLogger.level).toBe('warn');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ oldLevel: 'info', newLevel: 'warn' }),
      expect.stringContaining("Runtime config updated log level to 'warn'"),
    );
  });

  it('ignores invalid log levels and logs a warning', () => {
    const valBase64 = Buffer.from('not-a-valid-level').toString('base64');
    const payload = {
      result: {
        events: [
          {
            type: 'PUT',
            kv: {
              key: Buffer.from(LOG_LEVEL_KEY).toString('base64'),
              value: valBase64,
            },
          },
        ],
      },
    };

    service.handleWatchPayload(payload);

    expect(mockLogger.level).toBe('info');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invalidLevel: 'not-a-valid-level' }),
      'Ignoring invalid log level received from etcd',
    );
  });

  it('aborts watch controller onModuleDestroy', async () => {
    mockConfig.etcdUrl = 'http://127.0.0.1:2379';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvs: [] }),
    } as Response);

    vi.spyOn<any, any>(service, 'runWatchLoop').mockImplementation(async () => {});

    await service.start();
    expect((service as any).abortController.signal.aborted).toBe(false);

    service.onModuleDestroy();
    expect((service as any).abortController.signal.aborted).toBe(true);
    expect((service as any).isStopped).toBe(true);
  });
});
