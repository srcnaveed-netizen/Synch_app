require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { initDB, User, VerificationCode, Chat, Message } = require('./database');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// JWT Auth Middleware
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// ─── Auth Routes ────────────────────────────────────────────────────────────

app.post('/api/auth/phone/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const code = await VerificationCode.create(phone);

    // In production, send SMS here (Twilio, etc.)
    console.log(`OTP for ${phone}: ${code}`);

    res.json({
      message: 'OTP sent successfully',
      phone,
      devCode: process.env.NODE_ENV !== 'production' ? code : undefined
    });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/phone/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

    const verified = await VerificationCode.verify(phone, code);
    if (!verified) return res.status(400).json({ error: 'Invalid or expired code' });

    const existingUser = await User.findByPhone(phone);

    if (existingUser) {
      const token = generateToken(existingUser.id);
      await User.updateStatus(existingUser.id, 'online');
      return res.json({
        message: 'Login successful',
        verified: true,
        isNewUser: false,
        token,
        user: User.toPublic(existingUser)
      });
    }

    res.json({
      message: 'Phone verified',
      verified: true,
      isNewUser: true,
      phone
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/phone/complete-signup', async (req, res) => {
  try {
    const { phone, username, statusText } = req.body;
    if (!phone || !username) {
      return res.status(400).json({ error: 'Phone and username required' });
    }

    const existing = await User.findByPhone(phone);
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const user = await User.create(username, phone, statusText);
    const token = generateToken(user.id);
    await User.updateStatus(user.id, 'online');

    res.json({
      message: 'Account created',
      token,
      user: User.toPublic(user)
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/phone/resend-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const code = await VerificationCode.create(phone);
    console.log(`OTP for ${phone}: ${code}`);

    res.json({
      message: 'OTP resent',
      phone,
      devCode: process.env.NODE_ENV !== 'production' ? code : undefined
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: User.toPublic(req.user) });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await User.updateStatus(req.user.id, 'offline');
  res.json({ message: 'Logged out' });
});

// ─── User Routes ────────────────────────────────────────────────────────────

app.get('/api/users/synch/:synchId', auth, async (req, res) => {
  try {
    const user = await User.findBySynchId(req.params.synchId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: User.toPublic(user) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to find user' });
  }
});

app.get('/api/users/phone/:phone', auth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[^0-9+]/g, '');
    const user = await User.findByPhone(phone);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
    res.json({ user: User.toPublic(user) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to find user' });
  }
});

app.put('/api/users/profile', auth, async (req, res) => {
  try {
    const updated = await User.updateProfile(req.user.id, req.body);
    res.json({ user: User.toPublic(updated) });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Chat Routes ────────────────────────────────────────────────────────────

app.get('/api/chats', auth, async (req, res) => {
  try {
    const chats = await Chat.getUserChats(req.user.id);
    const chatsWithDetails = await Promise.all(chats.map(async (chat) => {
      const participants = await Chat.getParticipants(chat.id);
      const messages = await Message.getChatMessages(chat.id, 1);
      const lastMessage = messages.length ? await Message.toPublic(messages[0]) : null;

      return {
        _id: chat.id,
        type: chat.type,
        name: chat.name,
        participants: participants.map(p => ({
          _id: p.id,
          username: p.username,
          avatar: p.avatar,
          status: p.status,
          lastSeen: p.last_seen
        })),
        lastMessage,
        unreadCount: parseInt(chat.unread_count) || 0,
        updated_at: chat.updated_at
      };
    }));

    res.json({ chats: chatsWithDetails });
  } catch (err) {
    console.error('Get chats error:', err);
    res.status(500).json({ error: 'Failed to get chats' });
  }
});

app.post('/api/chats', auth, async (req, res) => {
  try {
    const { participantId } = req.body;
    if (!participantId) return res.status(400).json({ error: 'Participant ID required' });

    const participant = await User.findById(participantId);
    if (!participant) return res.status(404).json({ error: 'User not found' });

    // Check for existing chat
    let chat = await Chat.findPrivateChat(req.user.id, participantId);

    if (!chat) {
      chat = await Chat.create('private');
      await Chat.addParticipant(chat.id, req.user.id);
      await Chat.addParticipant(chat.id, participantId);
    }

    const participants = await Chat.getParticipants(chat.id);

    res.json({
      chat: {
        _id: chat.id,
        type: chat.type,
        participants: participants.map(p => ({
          _id: p.id,
          username: p.username,
          avatar: p.avatar,
          status: p.status
        }))
      }
    });
  } catch (err) {
    console.error('Create chat error:', err);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

app.get('/api/chats/:chatId/messages', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { before } = req.query;

    const messages = await Message.getChatMessages(chatId, 50, before);
    const publicMessages = await Promise.all(messages.map(m => Message.toPublic(m)));

    res.json({ messages: publicMessages });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// ─── Message Routes ─────────────────────────────────────────────────────────

app.post('/api/messages', auth, async (req, res) => {
  try {
    const { chatId, content, type = 'text', replyTo } = req.body;
    if (!chatId || !content) {
      return res.status(400).json({ error: 'Chat ID and content required' });
    }

    const message = await Message.create(chatId, req.user.id, content, type, replyTo);
    const publicMessage = await Message.toPublic(message);

    // Emit to socket
    io.to(`chat:${chatId}`).emit('new_message', publicMessage);

    res.json({ message: publicMessage });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.put('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const { content } = req.body;
    const message = await Message.findById(req.params.messageId);

    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your message' });
    }

    const updated = await Message.edit(message.id, content);
    const publicMessage = await Message.toPublic(updated);

    io.to(`chat:${message.chat_id}`).emit('message_edited', publicMessage);

    res.json({ message: publicMessage });
  } catch (err) {
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

app.delete('/api/messages/:messageId', auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);

    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your message' });
    }

    await Message.delete(message.id);

    io.to(`chat:${message.chat_id}`).emit('message_deleted', {
      messageId: message.id,
      chatId: message.chat_id
    });

    res.json({ message: 'Message deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

app.post('/api/messages/:messageId/reaction', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    const message = await Message.findById(req.params.messageId);

    if (!message) return res.status(404).json({ error: 'Message not found' });

    if (emoji) {
      await Message.addReaction(message.id, req.user.id, emoji);
    } else {
      await Message.removeReaction(message.id, req.user.id);
    }

    const reactions = await Message.getReactions(message.id);

    io.to(`chat:${message.chat_id}`).emit('message_reaction', {
      messageId: message.id,
      reactions: reactions.map(r => ({
        user: { _id: r.user_id, username: r.username },
        emoji: r.emoji
      }))
    });

    res.json({ reactions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

app.post('/api/messages/read', auth, async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!messageIds?.length) return res.json({ success: true });

    await Message.markRead(messageIds, req.user.id);

    // Get chat ID from first message
    const msg = await Message.findById(messageIds[0]);
    if (msg) {
      io.to(`chat:${msg.chat_id}`).emit('messages_read', {
        chatId: msg.chat_id,
        messageIds,
        userId: req.user.id
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ─── Socket.io ──────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Auth failed'));
  }
});

io.on('connection', async (socket) => {
  console.log(`User connected: ${socket.user.username}`);
  await User.updateStatus(socket.user.id, 'online');

  socket.broadcast.emit('user_online', { userId: socket.user.id });

  socket.on('join_chat', ({ chatId }) => {
    socket.join(`chat:${chatId}`);
  });

  socket.on('leave_chat', ({ chatId }) => {
    socket.leave(`chat:${chatId}`);
  });

  socket.on('typing', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('user_typing', {
      chatId,
      userId: socket.user.id,
      username: socket.user.username
    });
  });

  socket.on('stop_typing', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('user_stop_typing', {
      chatId,
      userId: socket.user.id
    });
  });

  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.user.username}`);
    await User.updateStatus(socket.user.id, 'offline');
    socket.broadcast.emit('user_offline', {
      userId: socket.user.id,
      lastSeen: new Date().toISOString()
    });
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
