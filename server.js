// server.js - MongoDB Integrated with 6-hour link expiry
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

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

// Connect to MongoDB - FIXED: Removed deprecated options
mongoose.connect("mongodb+srv://officialpinny_db_user:bNLCeFnKTwEYYy6G@ochat.dhm58w6.mongodb.net/?appName=Ochat")
  .then(() => {
    console.log('✅ Connected to MongoDB');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Link Schema - Auto-delete after 6 hours
const LinkSchema = new mongoose.Schema({
  linkId: { type: String, unique: true, required: true, index: true },
  creatorId: { type: String, required: true },
  createdAt: { 
    type: Date, 
    default: Date.now,
    expires: 21600 // 6 hours in seconds (6 * 60 * 60)
  }
});

// Conversation Schema - Auto-delete 24 hours after last message
const ConversationSchema = new mongoose.Schema({
  convId: { type: String, unique: true, required: true, index: true },
  linkId: { type: String, required: true, index: true },
  anonymousUserId: { type: String },
  messages: [{
    id: { type: Number },
    text: { type: String, required: true },
    isCreator: { type: Boolean, required: true },
    timestamp: { type: Number, required: true }
  }],
  createdAt: { type: Date, default: Date.now },
  lastMessage: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  hasMessages: { type: Boolean, default: false }
});

// TTL index - delete conversations 24 hours after last message
ConversationSchema.index({ lastMessage: 1 }, { expireAfterSeconds: 86400 });

const Link = mongoose.model('Link', LinkSchema);
const Conversation = mongoose.model('Conversation', ConversationSchema);

// Cleanup function - delete conversations whose links have expired
async function cleanupOrphanedConversations() {
  try {
    const allConversations = await Conversation.find({}, 'convId linkId').lean();
    let deletedCount = 0;
    
    for (const conv of allConversations) {
      const link = await Link.findOne({ linkId: conv.linkId });
      if (!link) {
        await Conversation.deleteOne({ convId: conv.convId });
        deletedCount++;
      }
    }
    
    // Delete empty conversations older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const emptyDeleted = await Conversation.deleteMany({
      hasMessages: false,
      createdAt: { $lt: oneHourAgo }
    });
    
    if (deletedCount > 0 || emptyDeleted.deletedCount > 0) {
      console.log(`🗑️ Cleanup: Deleted ${deletedCount} orphaned conversations, ${emptyDeleted.deletedCount} empty conversations`);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run cleanup every hour
setInterval(cleanupOrphanedConversations, 60 * 60 * 1000);

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Ochat Server Running',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Create a new chat link (expires in 6 hours)
app.post('/api/links/create', async (req, res) => {
  try {
    const linkId = `link_${Math.random().toString(36).substr(2, 9)}`;
    const creatorId = `creator_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const link = new Link({
      linkId,
      creatorId
    });
    
    await link.save();
    
    console.log(`✅ New link created: ${linkId} (expires in 6 hours)`);
    res.json({ linkId, creatorId });
  } catch (error) {
    console.error('Error creating link:', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// Get link info
app.get('/api/links/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await Link.findOne({ linkId }).lean();
    
    if (!link) {
      return res.status(404).json({ error: 'Link not found or expired' });
    }
    
    res.json({ 
      link: {
        id: link.linkId,
        linkId: link.linkId,
        creatorId: link.creatorId,
        createdAt: link.createdAt.getTime()
      }
    });
  } catch (error) {
    console.error('Error fetching link:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify link exists
app.get('/api/links/:linkId/verify', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await Link.findOne({ linkId }).lean();
    
    if (!link) {
      return res.status(404).json({ error: 'Link not found or expired', exists: false });
    }
    
    res.json({ 
      exists: true, 
      link: {
        id: link.linkId,
        linkId: link.linkId,
        creatorId: link.creatorId,
        createdAt: link.createdAt.getTime()
      }
    });
  } catch (error) {
    console.error('Error verifying link:', error);
    res.status(500).json({ error: 'Server error', exists: false });
  }
});

// Get conversations for a link
app.get('/api/links/:linkId/conversations', async (req, res) => {
  try {
    const { linkId } = req.params;
    
    // Verify link exists
    const link = await Link.findOne({ linkId });
    if (!link) {
      return res.status(404).json({ error: 'Link not found or expired' });
    }
    
    // Get conversations with messages only
    const conversations = await Conversation.find({ 
      linkId,
      hasMessages: true 
    })
    .sort({ lastMessage: -1 })
    .lean();
    
    // Format for frontend
    const formattedConversations = conversations.map(conv => ({
      id: conv.convId,
      linkId: conv.linkId,
      anonymousUserId: conv.anonymousUserId,
      messages: conv.messages,
      createdAt: conv.createdAt.getTime(),
      lastMessage: conv.lastMessage.getTime(),
      hasMessages: conv.hasMessages
    }));
    
    res.json({ conversations: formattedConversations });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a new conversation
app.post('/api/conversations/create', async (req, res) => {
  try {
    const { linkId } = req.body;
    
    // Verify link exists and hasn't expired
    const link = await Link.findOne({ linkId });
    if (!link) {
      return res.status(404).json({ error: 'Link not found or expired' });
    }
    
    const convId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const anonymousUserId = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const conversation = new Conversation({
      convId,
      linkId,
      anonymousUserId,
      messages: [],
      hasMessages: false
    });
    
    await conversation.save();
    
    console.log(`💬 New conversation created: ${convId} for link: ${linkId}`);
    
    // Format for frontend
    res.json({ 
      conversation: {
        id: convId,
        linkId,
        anonymousUserId,
        messages: [],
        createdAt: conversation.createdAt.getTime(),
        lastMessage: conversation.lastMessage.getTime(),
        hasMessages: false
      }
    });
  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get conversation by ID
app.get('/api/conversations/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const conversation = await Conversation.findOne({ convId }).lean();
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    // Verify the link still exists
    const link = await Link.findOne({ linkId: conversation.linkId });
    if (!link) {
      // Link expired, delete conversation
      await Conversation.deleteOne({ convId });
      return res.status(404).json({ error: 'Chat link has expired' });
    }
    
    // Format for frontend
    res.json({ 
      conversation: {
        id: conversation.convId,
        linkId: conversation.linkId,
        anonymousUserId: conversation.anonymousUserId,
        messages: conversation.messages,
        createdAt: conversation.createdAt.getTime(),
        lastMessage: conversation.lastMessage.getTime(),
        hasMessages: conversation.hasMessages
      }
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.io real-time messaging
io.on('connection', (socket) => {
  
  // Join a conversation room
  socket.on('join-conversation', async ({ convId, isCreator }) => {
    try {
      socket.join(convId);
      socket.convId = convId;
      socket.isCreator = isCreator;
      
      // Load and send existing messages
      const conversation = await Conversation.findOne({ convId }).lean();
      if (conversation) {
        // Verify link still exists
        const link = await Link.findOne({ linkId: conversation.linkId });
        if (!link) {
          socket.emit('error', { message: 'Chat link has expired' });
          await Conversation.deleteOne({ convId });
          return;
        }
        
        socket.emit('load-messages', { messages: conversation.messages });
      }
    } catch (error) {
      console.error('Error joining conversation:', error);
      socket.emit('error', { message: 'Failed to join conversation' });
    }
  });
  
  // Join link room (for creator)
  socket.on('join-link', async ({ linkId, creatorId }) => {
    try {
      socket.join(`link_${linkId}`);
      socket.linkId = linkId;
      socket.creatorId = creatorId;
      
      // Verify link exists
      const link = await Link.findOne({ linkId });
      if (!link) {
        socket.emit('error', { message: 'Link not found or expired' });
        return;
      }
      
      // Send existing conversations
      const conversations = await Conversation.find({ 
        linkId,
        hasMessages: true 
      })
      .sort({ lastMessage: -1 })
      .lean();
      
      // Format for frontend
      const formattedConversations = conversations.map(conv => ({
        id: conv.convId,
        linkId: conv.linkId,
        anonymousUserId: conv.anonymousUserId,
        messages: conv.messages,
        createdAt: conv.createdAt.getTime(),
        lastMessage: conv.lastMessage.getTime(),
        hasMessages: conv.hasMessages
      }));
      
      socket.emit('load-conversations', { conversations: formattedConversations });
    } catch (error) {
      console.error('Error joining link:', error);
      socket.emit('error', { message: 'Failed to join link' });
    }
  });
  
  // Send message
  socket.on('send-message', async ({ convId, message, isCreator }) => {
    try {
      const conversation = await Conversation.findOne({ convId });
      
      if (!conversation) {
        socket.emit('error', { message: 'Conversation not found' });
        return;
      }
      
      // Verify link still exists
      const link = await Link.findOne({ linkId: conversation.linkId });
      if (!link) {
        socket.emit('error', { message: 'Chat link has expired' });
        await Conversation.deleteOne({ convId });
        return;
      }
      
      const newMessage = {
        id: Date.now() + Math.random(),
        text: message,
        isCreator,
        timestamp: Date.now()
      };
      
      // Add message and update conversation
      conversation.messages.push(newMessage);
      conversation.lastMessage = new Date();
      conversation.hasMessages = true;
      
      await conversation.save();
      
      // Broadcast to OTHER users only (sender already has message from optimistic update)
      socket.broadcast.to(convId).emit('new-message', { 
        convId, 
        message: newMessage 
      });
      
      // Notify creator in link room about conversation update
      const formattedConversation = {
        id: conversation.convId,
        linkId: conversation.linkId,
        anonymousUserId: conversation.anonymousUserId,
        messages: conversation.messages,
        createdAt: conversation.createdAt.getTime(),
        lastMessage: conversation.lastMessage.getTime(),
        hasMessages: conversation.hasMessages
      };
      
      io.to(`link_${conversation.linkId}`).emit('conversation-updated', {
        conversation: formattedConversation
      });
      
      // If first message, notify about new conversation
      if (conversation.messages.length === 1) {
        io.to(`link_${conversation.linkId}`).emit('new-conversation', { 
          conversation: formattedConversation 
        });
      }
      
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Typing indicator
  socket.on('typing', ({ convId, isCreator }) => {
    socket.to(convId).emit('user-typing', { isCreator });
  });
  
  socket.on('stop-typing', ({ convId }) => {
    socket.to(convId).emit('user-stop-typing');
  });
  
  socket.on('disconnect', () => {
    // Cleanup handled by socket.io
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   Ochat Server Running                 ║
  ║   Port: ${PORT}                           ║
  ║   Status: ✓ Ready                      ║
  ║   Database: MongoDB                    ║
  ║   Link Expiry: 6 hours                 ║
  ║   Message Expiry: 24 hours             ║
  ╚════════════════════════════════════════╝
  `);
  
  // Run initial cleanup
  cleanupOrphanedConversations();
});