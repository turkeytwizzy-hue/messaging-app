import { FastifyInstance } from 'fastify';
import '@fastify/jwt';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { verifyChallenge } from '../crypto.js';

interface RegisterBody {
  publicKey: string;
  username: string;
}

interface ChallengeParams {
  publicKey: string;
}

interface VerifyBody {
  publicKey: string;
  challenge: string;
  signature: string;
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: RegisterBody }>('/register', async (request, reply) => {
    const { publicKey, username } = request.body;

    if (!publicKey || typeof publicKey !== 'string') {
      return reply.code(400).send({ error: 'publicKey is required' });
    }

    if (!username || typeof username !== 'string' || username.length < 3) {
      return reply.code(400).send({ error: 'username must be at least 3 characters' });
    }

    if (username.length > 32) {
      return reply.code(400).send({ error: 'Username cannot exceed 32 characters' });
    }

    if (!/^[a-z0-9_]+$/.test(username)) {
      return reply.code(400).send({ error: 'username can only contain letters, numbers and underscores' });
    }

    const existingKey = await db.select().from(users).where(eq(users.publicKey, publicKey)).limit(1);
    if (existingKey.length > 0) return reply.code(409).send({ error: 'Public key already registered' });

    const existingUsername = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existingUsername.length > 0) return reply.code(409).send({ error: 'Username already taken' });

    const [user] = await db
      .insert(users)
      .values({ publicKey, username })
      .returning({ id: users.id, publicKey: users.publicKey, username: users.username });

    return reply.code(201).send(user);
  });

  app.get<{ Params: ChallengeParams }>('/challenge/:publicKey', async (request, reply) => {
    const { publicKey } = request.params;

    const user = await db.select().from(users).where(eq(users.publicKey, publicKey)).limit(1);
    if (user.length === 0) return reply.code(404).send({ error: 'Public key not found' });

    const challenge = crypto.randomUUID();
    await db.update(users).set({ prekeyBundle: challenge }).where(eq(users.publicKey, publicKey));

    return reply.send({ challenge });
  });

  app.post<{ Body: VerifyBody }>('/verify', async (request, reply) => {
    const { publicKey, challenge, signature } = request.body;

    if (!publicKey || !challenge || !signature) {
      return reply.code(400).send({ error: 'publicKey, challenge and signature are required' });
    }

    const user = await db.select().from(users).where(eq(users.publicKey, publicKey)).limit(1);
    if (user.length === 0) return reply.code(404).send({ error: 'Public key not found' });

    if (user[0].prekeyBundle !== challenge) {
      return reply.code(401).send({ error: 'Challenge mismatch' });
    }

    let isValidSignature = false;
    try {
      isValidSignature = await verifyChallenge(publicKey, challenge, signature);
    } catch {
      isValidSignature = false;
    }

    if (!isValidSignature) return reply.code(401).send({ error: 'Invalid signature' });

    const token = (app as any).jwt.sign({ publicKey });

    await db.update(users).set({ prekeyBundle: null }).where(eq(users.publicKey, publicKey));

    return reply.send({ token });
  });

  app.patch('/users/username', async (request, reply) => {
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let publicKey: string;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      publicKey = decoded.publicKey;
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const { username } = request.body as { username: string };

    if (!username || username.length < 3) {
      return reply.code(400).send({ error: 'username must be at least 3 characters' });
    }

    if (username.length > 32) {
      return reply.code(400).send({ error: 'Username cannot exceed 32 characters' });
    }

    if (!/^[a-z0-9_]+$/.test(username)) {
      return reply.code(400).send({ error: 'username can only contain letters, numbers and underscores' });
    }

    const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0 && existing[0].publicKey !== publicKey) {
      return reply.code(409).send({ error: 'Username already taken' });
    }

    await db.update(users).set({ username }).where(eq(users.publicKey, publicKey));
    return reply.send({ username });
  });

  app.patch('/users/avatar', async (request, reply) => {
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let publicKey: string;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      publicKey = decoded.publicKey;
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const { avatar } = request.body as { avatar: string };
    if (!avatar) return reply.code(400).send({ error: 'avatar is required' });

    await db.update(users).set({ avatar }).where(eq(users.publicKey, publicKey));
    return reply.send({ avatar });
  });

  app.get<{ Params: { username: string } }>('/users/:username', async (request, reply) => {
    const { username } = request.params;
    const user = await db
      .select({ publicKey: users.publicKey, username: users.username })
      .from(users).where(eq(users.username, username)).limit(1);
    if (user.length === 0) return reply.code(404).send({ error: 'User not found' });
    return reply.send(user[0]);
  });

  app.get<{ Params: { publicKey: string } }>('/users/by-key/:publicKey', async (request, reply) => {
    const { publicKey } = request.params;
    const user = await db
      .select({ publicKey: users.publicKey, username: users.username, avatar: users.avatar })
      .from(users).where(eq(users.publicKey, publicKey)).limit(1);
    if (user.length === 0) return reply.code(404).send({ error: 'User not found' });
    return reply.send(user[0]);
  });
}