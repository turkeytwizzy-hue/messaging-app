import { FastifyInstance } from 'fastify';
import '@fastify/jwt';
import { db } from '../db';
import { friendships, users, channels } from '../db/schema';
import { eq, or, and } from 'drizzle-orm';
import { redis } from '../lib/redis';

export async function friendRoutes(app: FastifyInstance) {

  function getKey(request: any): string | null {
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return null;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      return decoded.publicKey;
    } catch { return null; }
  }

  async function notify(publicKey: string, event: string) {
    try {
      await redis.publish(`user:${publicKey}`, JSON.stringify({ type: 'notification', event }));
    } catch { /* non-fatal */ }
  }

  // Send friend request
  app.post('/friends/request', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const { username } = request.body as { username: string };

    const target = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (target.length === 0) return reply.code(404).send({ error: 'User not found' });

    const addresseeKey = target[0].publicKey;
    if (addresseeKey === publicKey) return reply.code(400).send({ error: 'Cannot add yourself' });

    const existing = await db.select().from(friendships).where(
      or(
        and(eq(friendships.requesterKey, publicKey), eq(friendships.addresseeKey, addresseeKey)),
        and(eq(friendships.requesterKey, addresseeKey), eq(friendships.addresseeKey, publicKey))
      )
    ).limit(1);

    if (existing.length > 0) {
      const f = existing[0];
      if (f.status === 'accepted') return reply.code(409).send({ error: 'Already friends' });
      if (f.status === 'pending') return reply.code(409).send({ error: 'Request already sent' });
      // declined — allow retry
      await db.update(friendships)
        .set({ status: 'pending', requesterKey: publicKey, addresseeKey })
        .where(eq(friendships.id, f.id));
      await notify(addresseeKey, 'friend_request');
      return reply.send({ status: 'pending' });
    }

    await db.insert(friendships).values({ requesterKey: publicKey, addresseeKey }).returning();

    // Notify the recipient instantly
    await notify(addresseeKey, 'friend_request');

    return reply.code(201).send({ status: 'pending' });
  });

  // Get friends list + pending requests
  app.get('/friends', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const all = await db.select().from(friendships).where(
      or(eq(friendships.requesterKey, publicKey), eq(friendships.addresseeKey, publicKey))
    );

    const enriched = await Promise.all(all.map(async f => {
      const otherKey = f.requesterKey === publicKey ? f.addresseeKey : f.requesterKey;
      const user = await db
        .select({ username: users.username, avatar: users.avatar, publicKey: users.publicKey })
        .from(users).where(eq(users.publicKey, otherKey)).limit(1);
      return {
        id: f.id,
        status: f.status,
        direction: f.requesterKey === publicKey ? 'sent' : 'received',
        user: user[0] || null,
      };
    }));

    return reply.send(enriched);
  });

  // Accept friend request
  app.patch<{ Params: { id: string } }>('/friends/:id/accept', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const f = await db.select().from(friendships).where(eq(friendships.id, id)).limit(1);
    if (f.length === 0) return reply.code(404).send({ error: 'Not found' });
    if (f[0].addresseeKey !== publicKey) return reply.code(403).send({ error: 'Forbidden' });

    await db.update(friendships).set({ status: 'accepted' }).where(eq(friendships.id, id));

    // Create DM channel between the two
    const allChannels = await db.select().from(channels);
    const dmExists = allChannels.some(ch =>
      ch.category === 'dm' &&
      ch.memberKeyRefs?.includes(publicKey) &&
      ch.memberKeyRefs?.includes(f[0].requesterKey) &&
      ch.memberKeyRefs?.length === 2
    );

    if (!dmExists) {
      await db.insert(channels).values({
        name: 'dm',
        serverId: null,
        memberKeyRefs: [publicKey, f[0].requesterKey],
        category: 'dm',
      });
    }

    // Notify the requester that their request was accepted
    await notify(f[0].requesterKey, 'friend_accepted');

    return reply.send({ status: 'accepted' });
  });

  // Decline or unfriend
  app.delete<{ Params: { id: string } }>('/friends/:id', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const f = await db.select().from(friendships).where(eq(friendships.id, id)).limit(1);
    if (f.length === 0) return reply.code(404).send({ error: 'Not found' });

    const isSender = f[0].requesterKey === publicKey;
    const isReceiver = f[0].addresseeKey === publicKey;
    if (!isSender && !isReceiver) return reply.code(403).send({ error: 'Forbidden' });

    await db.update(friendships).set({ status: 'declined' }).where(eq(friendships.id, id));
    return reply.send({ status: 'declined' });
  });

  // Get DM channels for current user
  app.get('/dms', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const all = await db.select().from(channels);
    const dms = all.filter(ch => ch.category === 'dm' && ch.memberKeyRefs?.includes(publicKey));

    const enriched = await Promise.all(dms.map(async ch => {
      const otherKey = ch.memberKeyRefs?.find(k => k !== publicKey);
      const user = otherKey
        ? await db.select({ username: users.username, avatar: users.avatar, publicKey: users.publicKey })
            .from(users).where(eq(users.publicKey, otherKey)).limit(1)
        : [];
      return { id: ch.id, user: user[0] || null };
    }));

    return reply.send(enriched);
  });
}