const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();
const Message = require('./models/Message');

// Ensure critical env vars exist
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Please define it in backend/.env and restart.');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('FATAL: MONGODB_URI is not set. Please define it in backend/.env and restart.');
  process.exit(1);
}

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const friendRoutes = require('./routes/friends');
const messageRoutes = require('./routes/messages');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? [process.env.FRONTEND_URL || "https://talkuu.vercel.app"] 
      : "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.FRONTEND_URL || "https://talkuu.vercel.app"]
    : ["http://localhost:3000"],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Connect to MongoDB with better configuration
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000, // Increase timeout to 30 seconds
  socketTimeoutMS: 45000,
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: 5, // Maintain minimum 5 socket connections
  maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
})
.then(() => console.log('MongoDB connected successfully'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  console.error('Please check:');
  console.error('1. Your internet connection');
  console.error('2. MongoDB Atlas IP whitelist settings');
  console.error('3. MongoDB URI in .env file');
});

// Socket.io for real-time messaging
const activeUsers = new Map(); // userId -> socketId
const socketToUser = new Map(); // socketId -> userId

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (userId) => {
    activeUsers.set(userId, socket.id);
    socketToUser.set(socket.id, userId);
    socket.join(userId);
  });

  socket.on('sendMessage', async (data, ack) => {
    try {
      const senderId = socketToUser.get(socket.id);
      if (!senderId) {
        if (ack) ack({ success: false, message: 'Not joined' });
        return;
      }

      const { receiverId, content, messageType = 'text', fileUrl = '' } = data || {};
      if (!receiverId || !content || typeof content !== 'string' || !content.trim()) {
        if (ack) ack({ success: false, message: 'receiverId and non-empty content are required' });
        return;
      }

      // Persist message
      let message = new Message({
        sender: senderId,
        receiver: receiverId,
        content: content.trim(),
        messageType,
        fileUrl
      });
      await message.save();
      message = await message
        .populate('sender', 'firstName lastName profilePicture')
        .populate('receiver', 'firstName lastName profilePicture');

      // Emit to receiver (if online) and sender
      const receiverSocketId = activeUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('receiveMessage', message);
      }
      io.to(socket.id).emit('messageSent', message);

      if (ack) ack({ success: true, message });
    } catch (err) {
      console.error('Socket sendMessage error:', err);
      if (ack) ack({ success: false, message: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      activeUsers.delete(userId);
      socketToUser.delete(socket.id);
    }
    console.log('User disconnected:', socket.id);
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/messages', messageRoutes);

// Health check route
app.get('/', (req, res) => {
  res.json({ message: 'Talkuu API is running!' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
