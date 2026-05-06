import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import '@fastify/jwt';
import { authRoutes } from './auth';
import { generateIdentity, signChallenge } from '@187/core';

const buildApp = async () => {
  const app = Fastify();
  app.register(fastifyJwt, { secret: 'test-secret' });
  app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
};

describe('Auth endpoints', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let publicKey: string;
  let privateKey: string;

  beforeAll(async () => {
    app = await buildApp();
    const identity = await generateIdentity();
    publicKey = identity.publicKey;
    privateKey = identity.privateKey;
  });

  it('registers a new public key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { publicKey },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.publicKey).toBe(publicKey);
  });

  it('rejects registering the same key twice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { publicKey },
    });
    expect(res.statusCode).toBe(409);
  });

  it('issues a challenge for a registered key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/challenge/${publicKey}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.challenge).toBeTruthy();
  });

  it('verifies a real signature and returns tokens', async () => {
    const challengeRes = await app.inject({
      method: 'GET',
      url: `/auth/challenge/${publicKey}`,
    });
    const { challenge } = JSON.parse(challengeRes.body);
    const signature = await signChallenge(privateKey, challenge);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { publicKey, challenge, signature },
    });

    expect(verifyRes.statusCode).toBe(200);
    const body = JSON.parse(verifyRes.body);
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('rejects a fake signature', async () => {
    const challengeRes = await app.inject({
      method: 'GET',
      url: `/auth/challenge/${publicKey}`,
    });
    const { challenge } = JSON.parse(challengeRes.body);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { publicKey, challenge, signature: 'fakesignature' },
    });

    expect(verifyRes.statusCode).toBe(401);
  });
});