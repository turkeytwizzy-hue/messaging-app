import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  publicKey: text('public_key').notNull().unique(),
  username: text('username').unique(),
  avatar: text('avatar'),
  prekeyBundle: text('prekey_bundle'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').references(() => channels.id),
  senderKeyRef: text('sender_key_ref').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id'),
  name: text('name').notNull(),
  category: text('category').default('Text Channels'),
  memberKeyRefs: text('member_key_refs').array(),
  mlsGroupState: text('mls_group_state'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerKeyRef: text('owner_key_ref').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const friendships = pgTable('friendships', {
  id: uuid('id').primaryKey().defaultRandom(),
  requesterKey: text('requester_key').notNull(),
  addresseeKey: text('addressee_key').notNull(),
  status: text('status').notNull().default('pending'), // pending | accepted | declined
  createdAt: timestamp('created_at').defaultNow(),
});