// server.js - COMPLETELY FIXED - No more duplicates
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "https://www.ochat.fun",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Enhanced storage with timestamps for auto-deletion
const storage = {
  links: new Map(),
  conversations: new Map(),
};

// Auto-delete messages after 24 hours
const AUTO_DELETE_TIME = 24 * 60 * 60 * 1000;

// Cleanup function to delete old messages and empty conversations
function cleanupOldMessages() {
  const now = Date.now();
  let deletedMessagesCount = 0;
  let deletedConversationsCount = 0;
  
  storage.conversations.forEach((conversation, convId) => {
    const oldLength = conversation.messages.length;
    conversation.messages = conversation.messages.filter(msg => {
      const isOld = (now - msg.timestamp) > AUTO_DELETE_TIME;
      if (isOld) deletedMessagesCount++;
      return !isOld;
    });
    
    if (conversation.messages.length > 0) {
      conversation.lastMessage = conversation.messages[conversation.messages.length - 1].timestamp;
    }
    
    if (conversation.messages.length === 0 && 
        (now - conversation.createdAt) > 3600000) {
      const linkId = conversation.linkId;
      const link = storage.links.get(linkId);
      if (link) {
        link.conversations = link.conversations.filter(id => id !== convId);
      }
      storage.conversations.delete(convId);
      deletedConversationsCount++;
    }
  });
  
  if (deletedMessagesCount > 0 || deletedConversationsCount > 0) {
    console.log(`🗑️  Cleanup: Deleted ${deletedMessagesCount} messages and ${deletedConversationsCount} empty conversations`);
  }
}

setInterval(cleanupOldMessages, 60 * 60 * 1000);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Anonymous Chat Server Running' });
});

app.post('/api/links/create', (req, res) => {
  const linkId = `link_${Math.random().toString(36).substr(2, 9)}`;
  const creatorId = `creator_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  storage.links.set(linkId, {
    id: linkId,
    creatorId,
    createdAt: Date.now(),
    conversations: []
  });
  
  console.log(`✅ New link created: ${linkId}`);
  res.json({ linkId, creatorId });
});

app.get('/api/links/:linkId', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }
  
  res.json({ link });
});

app.get('/api/links/:linkId/verify', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found', exists: false });
  }
  
  res.json({ exists: true, link });
});

app.get('/api/links/:linkId/conversations', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }
  
  const conversations = link.conversations
    .map(convId => storage.conversations.get(convId))
    .filter(conv => conv && conv.messages && conv.messages.length > 0);
  
  res.json({ conversations });
});

app.post('/api/conversations/create', (req, res) => {
  const { linkId } = req.body;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }
  
  const convId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const anonymousUserId = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const conversation = {
    id: convId,
    linkId,
    anonymousUserId,
    messages: [],
    createdAt: Date.now(),
    lastMessage: Date.now(),
    hasMessages: false
  };
  
  storage.conversations.set(convId, conversation);
  
  console.log(`💬 New conversation created: ${convId} for link: ${linkId}`);
  res.json({ conversation });
});

app.get('/api/conversations/:convId', (req, res) => {
  const { convId } = req.params;
  const conversation = storage.conversations.get(convId);
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  const now = Date.now();
  conversation.messages = conversation.messages.filter(msg => 
    (now - msg.timestamp) <= AUTO_DELETE_TIME
  );
  
  res.json({ conversation });
});

// Socket.io real-time messaging
io.on('connection', (socket) => {
  
  socket.on('join-conversation', ({ convId, isCreator }) => {
    socket.join(convId);
    socket.convId = convId;
    socket.isCreator = isCreator;
    
    const conversation = storage.conversations.get(convId);
    if (conversation) {
      const now = Date.now();
      const recentMessages = conversation.messages.filter(msg => 
        (now - msg.timestamp) <= AUTO_DELETE_TIME
      );
      conversation.messages = recentMessages;
      
      socket.emit('load-messages', { messages: recentMessages });
    }
  });
  
  socket.on('join-link', ({ linkId, creatorId }) => {
    socket.join(`link_${linkId}`);
    socket.linkId = linkId;
    socket.creatorId = creatorId;
    
    const link = storage.links.get(linkId);
    if (link) {
      const now = Date.now();
      const conversations = link.conversations
        .map(convId => {
          const conv = storage.conversations.get(convId);
          if (conv && conv.messages && conv.messages.length > 0) {
            conv.messages = conv.messages.filter(msg => 
              (now - msg.timestamp) <= AUTO_DELETE_TIME
            );
            return conv;
          }
          return null;
        })
        .filter(Boolean);
      
      socket.emit('load-conversations', { conversations });
    }
  });
  
  // ✅ CRITICAL FIX: Use socket.broadcast.to() instead of io.to()
  socket.on('send-message', ({ convId, message, isCreator }) => {
    const conversation = storage.conversations.get(convId);
    
    if (!conversation) {
      socket.emit('error', { message: 'Conversation not found' });
      return;
    }
    
    const newMessage = {
      id: Date.now() + Math.random(),
      text: message,
      isCreator,
      timestamp: Date.now()
    };
    
    conversation.messages.push(newMessage);
    conversation.lastMessage = Date.now();
    
    if (!conversation.hasMessages) {
      conversation.hasMessages = true;
      const link = storage.links.get(conversation.linkId);
      if (link && !link.conversations.includes(convId)) {
        link.conversations.push(convId);
        io.to(`link_${conversation.linkId}`).emit('new-conversation', { conversation });
      }
    }
    
    // ✅ FIXED: Broadcast to OTHER users only (exclude sender)
    socket.broadcast.to(convId).emit('new-message', { 
      convId, 
      message: newMessage 
    });
    
    // Notify creator about conversation update
    io.to(`link_${conversation.linkId}`).emit('conversation-updated', {
      conversation: {
        id: conversation.id,
        linkId: conversation.linkId,
        lastMessage: conversation.lastMessage,
        messages: conversation.messages,
        createdAt: conversation.createdAt,
        hasMessages: conversation.hasMessages
      }
    });
  });
  
  socket.on('typing', ({ convId, isCreator }) => {
    socket.to(convId).emit('user-typing', { isCreator });
  });
  
  socket.on('stop-typing', ({ convId }) => {
    socket.to(convId).emit('user-stop-typing');
  });
  
  socket.on('disconnect', () => {
    // console.log('👋 User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   Anonymous Chat Server Running        ║
  ║   Port: ${PORT}                           ║
  ║   Status: ✓ Ready                      ║
  ║   Auto-delete: 24 hours                ║
  ╚════════════════════════════════════════╝
  `);
  
  cleanupOldMessages();
});