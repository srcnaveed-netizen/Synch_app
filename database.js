const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        synch_id VARCHAR(20) UNIQUE NOT NULL,
        username VARCHAR(50) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        avatar TEXT,
        status VARCHAR(20) DEFAULT 'offline',
        status_text VARCHAR(200) DEFAULT 'Hey there! I am using Synch.',
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        phone VARCHAR(20),
        code VARCHAR(10) NOT NULL,
        type VARCHAR(20) DEFAULT 'phone_login',
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) DEFAULT 'private',
        name VARCHAR(100),
        avatar TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_participants (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        type VARCHAR(20) DEFAULT 'text',
        content TEXT,
        media_url TEXT,
        reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        edited BOOLEAN DEFAULT FALSE,
        edited_at TIMESTAMP,
        deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS message_reads (
        id SERIAL PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        read_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        emoji VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(user_id);
      CREATE INDEX IF NOT EXISTS idx_verification_phone ON verification_codes(phone);
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
};

const generateSynchId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'SY';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
};

const User = {
  create: async (username, phone, statusText = 'Hey there! I am using Synch.') => {
    const synchId = generateSynchId();
    const result = await pool.query(
      `INSERT INTO users (synch_id, username, phone, status_text)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [synchId, username, phone, statusText]
    );
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0];
  },

  findByPhone: async (phone) => {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    return result.rows[0];
  },

  findBySynchId: async (synchId) => {
    const result = await pool.query('SELECT * FROM users WHERE synch_id = $1', [synchId]);
    return result.rows[0];
  },

  updateStatus: async (id, status) => {
    await pool.query(
      'UPDATE users SET status = $1, last_seen = NOW() WHERE id = $2',
      [status, id]
    );
  },

  updateProfile: async (id, updates) => {
    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.username) { fields.push(`username = $${idx++}`); values.push(updates.username); }
    if (updates.statusText) { fields.push(`status_text = $${idx++}`); values.push(updates.statusText); }
    if (updates.avatar) { fields.push(`avatar = $${idx++}`); values.push(updates.avatar); }

    if (fields.length === 0) return null;

    values.push(id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0];
  },

  toPublic: (user) => ({
    _id: user.id,
    synchId: user.synch_id,
    username: user.username,
    phone: user.phone,
    avatar: user.avatar,
    status: user.status,
    statusText: user.status_text,
    lastSeen: user.last_seen
  })
};

const VerificationCode = {
  create: async (phone, userId = null) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query(
      'DELETE FROM verification_codes WHERE phone = $1 AND used = FALSE',
      [phone]
    );

    await pool.query(
      `INSERT INTO verification_codes (user_id, phone, code, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, phone, code, expiresAt]
    );

    return code;
  },

  verify: async (phone, code) => {
    const result = await pool.query(
      `SELECT * FROM verification_codes
       WHERE phone = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [phone, code]
    );

    if (result.rows.length === 0) return null;

    await pool.query(
      'UPDATE verification_codes SET used = TRUE WHERE id = $1',
      [result.rows[0].id]
    );

    return result.rows[0];
  }
};

const Chat = {
  create: async (type = 'private', name = null) => {
    const result = await pool.query(
      'INSERT INTO chats (type, name) VALUES ($1, $2) RETURNING *',
      [type, name]
    );
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await pool.query('SELECT * FROM chats WHERE id = $1', [id]);
    return result.rows[0];
  },

  findPrivateChat: async (user1Id, user2Id) => {
    const result = await pool.query(`
      SELECT c.* FROM chats c
      JOIN chat_participants cp1 ON c.id = cp1.chat_id AND cp1.user_id = $1
      JOIN chat_participants cp2 ON c.id = cp2.chat_id AND cp2.user_id = $2
      WHERE c.type = 'private'
    `, [user1Id, user2Id]);
    return result.rows[0];
  },

  addParticipant: async (chatId, userId) => {
    await pool.query(
      'INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [chatId, userId]
    );
  },

  getParticipants: async (chatId) => {
    const result = await pool.query(`
      SELECT u.* FROM users u
      JOIN chat_participants cp ON u.id = cp.user_id
      WHERE cp.chat_id = $1
    `, [chatId]);
    return result.rows;
  },

  getUserChats: async (userId) => {
    const result = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM messages m
         LEFT JOIN message_reads mr ON m.id = mr.message_id AND mr.user_id = $1
         WHERE m.chat_id = c.id AND m.sender_id != $1 AND mr.id IS NULL AND m.deleted = FALSE
        ) as unread_count
      FROM chats c
      JOIN chat_participants cp ON c.id = cp.chat_id
      WHERE cp.user_id = $1
      ORDER BY c.updated_at DESC
    `, [userId]);
    return result.rows;
  },

  touch: async (chatId) => {
    await pool.query('UPDATE chats SET updated_at = NOW() WHERE id = $1', [chatId]);
  }
};

const Message = {
  create: async (chatId, senderId, content, type = 'text', replyTo = null) => {
    const result = await pool.query(
      `INSERT INTO messages (chat_id, sender_id, content, type, reply_to)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [chatId, senderId, content, type, replyTo]
    );
    await Chat.touch(chatId);
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    return result.rows[0];
  },

  getChatMessages: async (chatId, limit = 50, before = null) => {
    let query = `
      SELECT m.*, u.username as sender_username, u.avatar as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = $1 AND m.deleted = FALSE
    `;
    const params = [chatId];

    if (before) {
      query += ' AND m.id < $2';
      params.push(before);
    }

    query += ' ORDER BY m.created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows.reverse();
  },

  edit: async (id, content) => {
    const result = await pool.query(
      `UPDATE messages SET content = $1, edited = TRUE, edited_at = NOW()
       WHERE id = $2 RETURNING *`,
      [content, id]
    );
    return result.rows[0];
  },

  delete: async (id) => {
    const result = await pool.query(
      `UPDATE messages SET deleted = TRUE, deleted_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0];
  },

  markRead: async (messageIds, userId) => {
    if (!messageIds.length) return;
    const values = messageIds.map((id, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',');
    const params = messageIds.flatMap(id => [id, userId]);
    await pool.query(
      `INSERT INTO message_reads (message_id, user_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      params
    );
  },

  getReactions: async (messageId) => {
    const result = await pool.query(`
      SELECT r.emoji, u.id as user_id, u.username
      FROM reactions r
      JOIN users u ON r.user_id = u.id
      WHERE r.message_id = $1
    `, [messageId]);
    return result.rows;
  },

  addReaction: async (messageId, userId, emoji) => {
    await pool.query(
      `INSERT INTO reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = $3`,
      [messageId, userId, emoji]
    );
  },

  removeReaction: async (messageId, userId) => {
    await pool.query(
      'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2',
      [messageId, userId]
    );
  },

  toPublic: async (message) => {
    const sender = await User.findById(message.sender_id);
    const reactions = await Message.getReactions(message.id);

    let replyTo = null;
    if (message.reply_to) {
      const reply = await Message.findById(message.reply_to);
      if (reply) {
        const replySender = await User.findById(reply.sender_id);
        replyTo = {
          _id: reply.id,
          content: reply.content,
          sender: { _id: replySender.id, username: replySender.username }
        };
      }
    }

    return {
      _id: message.id,
      chat: message.chat_id,
      sender: {
        _id: sender.id,
        username: sender.username,
        avatar: sender.avatar
      },
      type: message.type,
      content: message.content,
      mediaUrl: message.media_url,
      replyTo,
      reactions: reactions.map(r => ({
        user: { _id: r.user_id, username: r.username },
        emoji: r.emoji
      })),
      edited: message.edited,
      editedAt: message.edited_at,
      deleted: message.deleted,
      deletedAt: message.deleted_at,
      createdAt: message.created_at
    };
  }
};

module.exports = {
  pool,
  initDB,
  User,
  VerificationCode,
  Chat,
  Message
};
