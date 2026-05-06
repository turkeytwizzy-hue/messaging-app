import { FastifyInstance } from 'fastify';
import '@fastify/jwt';
import { db } from '../db';
import { servers, channels, users, friendships, messages } from '../db/schema';
import { eq, and, or, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { redis } from '../lib/redis';

interface CreateServerBody { name: string; }
interface CreateChannelBody { name: string; serverId: string; category?: string; }

export async function serverRoutes(app: FastifyInstance) {

  function getKey(request: any): string | null {
    const token = request.headers['authorization']?.replace('Bearer ', '');
    if (!token) return null;
    try {
      const decoded = (app as any).jwt.verify(token) as { publicKey: string };
      return decoded.publicKey;
    } catch { return null; }
  }

  async function notify(publicKey: string, event: string, data?: object) {
    try {
      await redis.publish(`user:${publicKey}`, JSON.stringify({ type: 'notification', event, ...data }));
    } catch { /* non-fatal */ }
  }

  // Create server
  app.post<{ Body: CreateServerBody }>('/servers', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const { name } = request.body;
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const [server] = await db.insert(servers).values({ name, ownerKeyRef: publicKey }).returning();
    const [general] = await db.insert(channels).values({
      name: 'general', serverId: server.id, memberKeyRefs: [publicKey], category: 'Text Channels',
    }).returning();

    return reply.code(201).send({ ...server, channels: [general] });
  });

  // Get servers for current user
  app.get('/servers', async (request, reply) => {
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const memberChannels = await db
      .select({ serverId: channels.serverId })
      .from(channels)
      .where(sql`${channels.memberKeyRefs} @> ARRAY[${publicKey}]::text[]`);

    const serverIds = [...new Set(memberChannels.map(c => c.serverId).filter(Boolean))] as string[];
    if (serverIds.length === 0) return reply.send([]);

    const result = await db.select().from(servers).where(inArray(servers.id, serverIds));
    return reply.send(result);
  });

  // Get channels in a server
  app.get('/servers/:id/channels', async (request, reply) => {
    const { id } = request.params as { id: string };
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const result = await db.select().from(channels).where(eq(channels.serverId, id));
    return reply.send(result);
  });

  // Create channel in a server
  app.post<{ Body: CreateChannelBody }>('/servers/:id/channels', async (request, reply) => {
    const { id } = request.params as { id: string };
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const { name, category } = request.body;
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const [channel] = await db.insert(channels).values({
      name, serverId: id, memberKeyRefs: [publicKey], category: category || 'Text Channels',
    }).returning();

    return reply.code(201).send(channel);
  });

  // Send a server invite to a friend via DM
  app.post<{ Params: { id: string }; Body: { inviteeKey: string } }>('/servers/:id/invite', async (request, reply) => {
    const { id: serverId } = request.params;
    const { inviteeKey } = request.body;
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    // Check inviter is a member
    const serverChannels = await db.select().from(channels).where(eq(channels.serverId, serverId));
    const isMember = serverChannels.some(ch => ch.memberKeyRefs?.includes(publicKey));
    if (!isMember) return reply.code(403).send({ error: 'You are not a member of this server' });

    // Check they are friends
    const friendship = await db.select().from(friendships).where(
      and(
        or(
          and(eq(friendships.requesterKey, publicKey), eq(friendships.addresseeKey, inviteeKey)),
          and(eq(friendships.requesterKey, inviteeKey), eq(friendships.addresseeKey, publicKey))
        ),
        eq(friendships.status, 'accepted')
      )
    ).limit(1);
    if (friendship.length === 0) return reply.code(403).send({ error: 'You can only invite friends' });

    // Find DM channel between the two
    const allChannels = await db.select().from(channels);
    const dmChannel = allChannels.find(ch =>
      ch.category === 'dm' &&
      ch.memberKeyRefs?.includes(publicKey) &&
      ch.memberKeyRefs?.includes(inviteeKey) &&
      ch.memberKeyRefs?.length === 2
    );
    if (!dmChannel) return reply.code(400).send({ error: 'No DM channel exists with this user' });

    // Get server info
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));

    // Insert invite message into DM channel
    const invitePayload = JSON.stringify({ type: 'server_invite', serverId, serverName: server.name });
    const ciphertext = Buffer.from(invitePayload).toString('base64');

    const [msg] = await db.insert(messages).values({
      channelId: dmChannel.id,
      senderKeyRef: publicKey,
      ciphertext,
    }).returning();

    // Broadcast the message over WebSocket so it appears instantly in the DM
    await redis.publish(`channel:${dmChannel.id}`, JSON.stringify({
      type: 'message',
      channelId: dmChannel.id,
      ciphertext,
      senderKeyRef: publicKey,
      createdAt: msg.createdAt,
    }));

    // Also send a user-level notification so the recipient's sidebar refreshes
    await notify(inviteeKey, 'server_invite');

    return reply.send({ success: true });
  });

  // Join a server (accept an invite)
  app.post<{ Params: { id: string } }>('/servers/:id/join', async (request, reply) => {
    const { id: serverId } = request.params;
    const publicKey = getKey(request);
    if (!publicKey) return reply.code(401).send({ error: 'Unauthorized' });

    const serverChannels = await db.select().from(channels).where(eq(channels.serverId, serverId));
    if (serverChannels.length === 0) return reply.code(404).send({ error: 'Server not found' });

    for (const channel of serverChannels) {
      if (channel.memberKeyRefs?.includes(publicKey)) continue;
      await db.update(channels)
        .set({ memberKeyRefs: [...(channel.memberKeyRefs || []), publicKey] })
        .where(eq(channels.id, channel.id));
    }

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    return reply.send(server);
  });
}