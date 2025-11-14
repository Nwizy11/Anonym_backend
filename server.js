// server.js - Enhanced Backend with Smart Conversation Management
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
// const io = socketIo(server, {
//   cors: {
//     origin: "http://localhost:3000",
//     methods: ["GET", "POST"]
//   }
// });
const io = socketIo(server, {
  cors: {
    origin:"https://anonym-fawn.vercel.app",
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin:"https://anonym-fawn.vercel.app"
}));
// app.use(cors());
app.use(express.json());

// Enhanced storage with timestamps for auto-deletion
const storage = {
  links: new Map(),
  conversations: new Map(),
};

// Auto-delete messages after 24 hours
const AUTO_DELETE_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Cleanup function to delete old messages and empty conversations
function cleanupOldMessages() {
  const now = Date.now();
  let deletedMessagesCount = 0;
  let deletedConversationsCount = 0;
  
  storage.conversations.forEach((conversation, convId) => {
    // Filter old messages
    const oldLength = conversation.messages.length;
    conversation.messages = conversation.messages.filter(msg => {
      const isOld = (now - msg.timestamp) > AUTO_DELETE_TIME;
      if (isOld) deletedMessagesCount++;
      return !isOld;
    });
    
    // Update last message time if messages exist
    if (conversation.messages.length > 0) {
      conversation.lastMessage = conversation.messages[conversation.messages.length - 1].timestamp;
    }
    
    // Delete empty conversations (no messages and older than 1 hour)
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

// Run cleanup every hour
setInterval(cleanupOldMessages, 60 * 60 * 1000);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Anonymous Chat Server Running' });
});

// Create a new chat link
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

// Get link info and restore creator session
app.get('/api/links/:linkId', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }
  
  res.json({ link });
});

// Verify link exists (for direct link access)
app.get('/api/links/:linkId/verify', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found', exists: false });
  }
  
  res.json({ exists: true, link });
});

// Get conversations for a link (only return conversations with messages)
app.get('/api/links/:linkId/conversations', (req, res) => {
  const { linkId } = req.params;
  const link = storage.links.get(linkId);
  
  if (!link) {
    return res.status(404).json({ error: 'Link not found' });
  }
  
  // Only return conversations that have at least one message
  const conversations = link.conversations
    .map(convId => storage.conversations.get(convId))
    .filter(conv => conv && conv.messages && conv.messages.length > 0);
  
  res.json({ conversations });
});

// Create a new conversation (but don't add to link until first message)
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
    hasMessages: false // Track if conversation has any messages
  };
  
  storage.conversations.set(convId, conversation);
  // DON'T add to link.conversations yet - wait for first message
  
  console.log(`💬 New conversation created: ${convId} for link: ${linkId} (waiting for first message)`);
  res.json({ conversation });
});

// Get conversation by ID with all messages
app.get('/api/conversations/:convId', (req, res) => {
  const { convId } = req.params;
  const conversation = storage.conversations.get(convId);
  
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  // Filter out messages older than 24 hours
  const now = Date.now();
  conversation.messages = conversation.messages.filter(msg => 
    (now - msg.timestamp) <= AUTO_DELETE_TIME
  );
  
  res.json({ conversation });
});

// Socket.io real-time messaging
io.on('connection', (socket) => {
  // console.log('👤 User connected:', socket.id);
  
  // Join a conversation room
  socket.on('join-conversation', ({ convId, isCreator }) => {
    socket.join(convId);
    socket.convId = convId;
    socket.isCreator = isCreator;
    
    // console.log(`✅ User ${socket.id} joined conversation ${convId} as ${isCreator ? 'creator' : 'anonymous'}`);
    
    // Send existing messages
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
  
  // Join link room (for creator to see new conversations)
  socket.on('join-link', ({ linkId, creatorId }) => {
    socket.join(`link_${linkId}`);
    socket.linkId = linkId;
    socket.creatorId = creatorId;
    
    // console.log(`✅ Creator ${socket.id} joined link ${linkId}`);
    
    // Send existing conversations (only those with messages)
    const link = storage.links.get(linkId);
    if (link) {
      const now = Date.now();
      const conversations = link.conversations
        .map(convId => {
          const conv = storage.conversations.get(convId);
          if (conv && conv.messages && conv.messages.length > 0) {
            // Filter messages within 24 hours
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
  
  // Send message with real-time broadcast
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
    
    // Add message to conversation
    conversation.messages.push(newMessage);
    conversation.lastMessage = Date.now();
    
    // If this is the first message, add conversation to link
    if (!conversation.hasMessages) {
      conversation.hasMessages = true;
      const link = storage.links.get(conversation.linkId);
      if (link && !link.conversations.includes(convId)) {
        link.conversations.push(convId);
        // console.log(`📌 Conversation ${convId} added to link conversations (first message received)`);
        
        // Notify creator about new conversation
        io.to(`link_${conversation.linkId}`).emit('new-conversation', { conversation });
      }
    }
    
    // console.log(`📨 Message sent in ${convId}: "${message.substring(0, 30)}..."`);
    
    // Broadcast to ALL users in the conversation
    io.to(convId).emit('new-message', { 
      convId, 
      message: newMessage 
    });
    
    // Notify creator in link room about updated conversation
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
  
  // Typing indicator
  socket.on('typing', ({ convId, isCreator }) => {
    socket.to(convId).emit('user-typing', { isCreator });
  });
  
  socket.on('stop-typing', ({ convId }) => {
    socket.to(convId).emit('user-stop-typing');
  });
  
  // Handle disconnection
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
  
  // Run initial cleanup
  cleanupOldMessages();
});
