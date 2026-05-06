import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import dotenv from 'dotenv';
import { authRoutes } from './routes/auth.js';
import { wsRoutes } from './routes/ws.js';
import { channelRoutes } from './routes/channels.js';
import { serverRoutes } from './routes/servers.js';
import { friendRoutes } from './routes/friends.js';

dotenv.config();

const app = Fastify({ logger: true });

// Open CORS — C# desktop clients don't enforce browser CORS
app.register(fastifyCors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'fallback-secret-change-in-production',
});

app.register(fastifyWebsocket);

app.get('/health', async () => ({ status: 'ok' }));

app.register(authRoutes, { prefix: '/auth' });
app.register(wsRoutes);
app.register(channelRoutes);
app.register(serverRoutes);
app.register(friendRoutes);

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
