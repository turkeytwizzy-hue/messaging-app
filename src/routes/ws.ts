import { FastifyInstance } from 'fastify';
import { WebSocket } from '@fastify/websocket';
import { db } from '../db';
import { messages, channels } from '../db/schema';
import { eq } from 'drizzle-orm';
import { redis, redisSub } from '../lib/redis';

const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface IncomingMessage {
  type: 'message' | 'subscribe' | 'subscribe_user';
  channelId?: string;
  ciphertext?: string;
  epoch?: string;
}

// channel:channelId -> sockets
const channelClients = new Map<string, Set<WebSocket>>();
// user:publicKey -> sockets
const userClients = new Map<string, Set<WebSocket>>();

redisSub.on('message', (channel, message) => {
  if (channel.startsWith('user:')) {
    const publicKey = channel.replace('user:', '');
    const clients = userClients.get(publicKey);
    if (!clients) return;
    for (const client of clients) {
      if (client.readyState === 1) client.send(message);
    }
    return;
  }

  if (channel.startsWith('channel:')) {
    const channelId = channel.replace('channel:', '');
    const clients = channelClients.get(channelId);
    console.log(`Redis message on ${channelId}, clients: ${clients?.size ?? 0}`);
    if (!clients) return;
    for (const client of clients) {
      if (client.readyState === 1) client.send(message);
    }
  }
});

export async function wsRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, async (socket, request) => {
    let authenticatedKey: string | null = null;
    const subscribedChannels = new Set<string>();
    let subscribedUserKey: string | null = null;

    const getKey = (): string | null => {
      if (authenticatedKey) return authenticatedKey;
      const token = (request.query as any).token || request.headers['authorization']?.replace('Bearer ', '');
      if (!token) return null;
      try {
        const decoded = (app as any).jwt.verify(token) as { publicKey: string };
        authenticatedKey = decoded.publicKey;
        return authenticatedKey;
      } catch { return null; }
    };

    socket.on('message', async (raw: Buffer) => {
      let parsed: IncomingMessage;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // ── subscribe_user — real-time notifications (friend requests, invites, etc.)
      if (parsed.type === 'subscribe_user') {
        const key = getKey();
        if (!key) { socket.send(JSON.stringify({ error: 'Unauthorized' })); return; }

        subscribedUserKey = key;
        if (!userClients.has(key)) userClients.set(key, new Set());
        userClients.get(key)!.add(socket);

        // Only subscribe Redis once per key
        if (userClients.get(key)!.size === 1) {
          await redisSub.subscribe(`user:${key}`);
          console.log(`Subscribed to Redis user channel: user:${key}`);
        }

        socket.send(JSON.stringify({ type: 'subscribed_user' }));
        return;
      }

      // ── subscribe — join a channel
      if (parsed.type === 'subscribe') {
        const key = getKey();
        if (!key) { socket.send(JSON.stringify({ error: 'Unauthorized' })); return; }

        const { channelId } = parsed;
        if (!channelId) { socket.send(JSON.stringify({ error: 'channelId required' })); return; }

        const channel = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
        if (channel.length === 0) { socket.send(JSON.stringify({ error: 'Channel not found' })); return; }

        const isMember = channel[0].memberKeyRefs?.includes(key);
        if (!isMember) { socket.send(JSON.stringify({ error: 'Not a channel member' })); return; }

        const isNewChannel = !channelClients.has(channelId);
        if (isNewChannel) {
          channelClients.set(channelId, new Set());
          await redisSub.subscribe(`channel:${channelId}`);
          console.log(`Subscribed to Redis channel: channel:${channelId}`);
        }

        channelClients.get(channelId)!.add(socket);
        subscribedChannels.add(channelId);
        console.log(`Client added to ${channelId}, total clients: ${channelClients.get(channelId)!.size}`);

        socket.send(JSON.stringify({ type: 'subscribed', channelId }));
        return;
      }

      // ── message — send a message
      if (parsed.type === 'message') {
        const key = getKey();
        if (!key) { socket.send(JSON.stringify({ error: 'Must subscribe before sending messages' })); return; }

        const { channelId, ciphertext, epoch } = parsed;
        if (!channelId || !ciphertext) { socket.send(JSON.stringify({ error: 'channelId and ciphertext required' })); return; }

        const channel = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
        if (channel.length === 0 || !channel[0].memberKeyRefs?.includes(key)) {
          socket.send(JSON.stringify({ error: 'Forbidden' })); return;
        }

        const [msg] = await db.insert(messages).values({
          channelId,
          senderKeyRef: key,
          ciphertext,
        }).returning();

        await redis.publish(`channel:${channelId}`, JSON.stringify({
          type: 'message',
          channelId,
          ciphertext,
          epoch,
          senderKeyRef: key,
          createdAt: msg.createdAt,
        }));

        console.log(`Published message to channel:${channelId}`);
      }
    });

    socket.on('close', () => {
      for (const channelId of subscribedChannels) {
        channelClients.get(channelId)?.delete(socket);
        console.log(`Client removed from ${channelId}, remaining: ${channelClients.get(channelId)?.size}`);
      }
      if (subscribedUserKey) {
        userClients.get(subscribedUserKey)?.delete(socket);
      }
    });
  });
}