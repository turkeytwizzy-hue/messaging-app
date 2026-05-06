import { FastifyInstance } from 'fastify';
import '@fastify/jwt';
import { db } from '../db';
import { channels, messages } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

interface CreateChannelBody {
  name: string;
  memberKeyRefs: string[];
}

export async function channelRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateChannelBody }>('/channels', async (request, reply) => {
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let publicKey: string;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      publicKey = decoded.publicKey;
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const { name, memberKeyRefs } = request.body;

    if (!name || !memberKeyRefs || memberKeyRefs.length === 0) {
      return reply.code(400).send({ error: 'name and memberKeyRefs are required' });
    }

    if (!memberKeyRefs.includes(publicKey)) {
      memberKeyRefs.push(publicKey);
    }

    const [channel] = await db
      .insert(channels)
      .values({ name, memberKeyRefs })
      .returning();

    return reply.code(201).send(channel);
  });

  app.get('/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    let publicKey: string;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      publicKey = decoded.publicKey;
    } catch {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const channel = await db
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (channel.length === 0) return reply.code(404).send({ error: 'Channel not found' });

    if (!channel[0].memberKeyRefs?.includes(publicKey)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return reply.send(channel[0]);
  });

  app.get('/channels', async (request, reply) => {
  const token = request.headers['authorization']?.replace('Bearer ', '');
  if (!token) return reply.code(401).send({ error: 'Unauthorized' });

  let publicKey: string;
  try {
    const decoded = (app as any).jwt.verify(token) as { publicKey: string };
    publicKey = decoded.publicKey;
  } catch {
    return reply.code(401).send({ error: 'Invalid token' });
  }

  const result = await db
    .select()
    .from(channels)
    .where(sql`${channels.memberKeyRefs} @> ARRAY[${publicKey}]::text[]`);

  return reply.send(result);
  });

  app.get('/channels/:id/messages', async (request, reply) => {
  const { id } = request.params as { id: string };
  const token = request.headers['authorization']?.replace('Bearer ', '');
  if (!token) return reply.code(401).send({ error: 'Unauthorized' });

  let publicKey: string;
  try {
    const decoded = (app as any).jwt.verify(token) as { publicKey: string };
    publicKey = decoded.publicKey;
  } catch {
    return reply.code(401).send({ error: 'Invalid token' });
  }

  const channel = await db
    .select()
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);

  if (channel.length === 0) return reply.code(404).send({ error: 'Channel not found' });
  if (!channel[0].memberKeyRefs?.includes(publicKey)) return reply.code(403).send({ error: 'Forbidden' });

  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.channelId, id))
    .orderBy(messages.createdAt);

  return reply.send(result);
  });
}

