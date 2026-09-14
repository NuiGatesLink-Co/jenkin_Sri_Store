import { Controller, Get, Module, Req, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from './app.setup.js';

@Controller('probe')
class IpProbeController {
  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [IpProbeController] })
class ProbeModule {}

describe('configureApp trust proxy', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    await configureApp(app, pino({ level: 'silent' }));
  });

  afterAll(async () => {
    await app.close();
  });

  const ipFor = async (xff: string) =>
    (await request(app.getHttpServer()).get('/api/v1/probe/ip').set('X-Forwarded-For', xff))
      .body.data.ip;

  it('takes the entry nginx appended, not the one the client wrote', async () => {
    expect(await ipFor('1.1.1.1, 10.0.0.5')).toBe('10.0.0.5');
  });

  it('gives two clients behind the same nginx different addresses', async () => {
    expect(await ipFor('10.0.0.5')).not.toBe(await ipFor('10.0.0.6'));
  });
});
