const dns = require('dns');
// Force Node.js to use Google DNS for SRV lookups (fixes MongoDB Atlas connectivity)
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { StudentUploadRouter } = require('./routes/StudentuploadPyq.routes');
const { AdminUploadRouter } = require('./routes/AdminUpload.routes');
const { SearchRouter } = require('./routes/searchRouter.route');
const { AdminSearchRouter } = require('./routes/AdminDownload.routes');
const { userRouter } = require('./routes/User.routes');
const { superadminRouter } = require('./routes/SuperAdmin.routes');
const { AdminVerifyRouter } = require('./routes/AdminVerifyRouter.routes');
require('dotenv').config();
const app = express();
const cors = require('cors');
const { appendCaption } = require('./services/meetNotesStore');

// Database connection helper
const connectToDatabase = require('./config/bdUser');
const { toolsRouter } = require('./routes/Tools.route');
const { meetRouter } = require('./routes/Meet.routes');
const { classroomRouter } = require('./routes/Classroom.routes');
const { assignmentRouter } = require('./routes/Assignment.routes');
const { submissionRouter } = require('./routes/Submission.routes');
const { adminRouter } = require('./routes/Admin.routes');
connectToDatabase();
const port = process.env.PORT || 4000;


// CORS configuration - allow specific origins in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(url => url.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'https://virtual-classroom-gray.vercel.app/', 'https://virtual-classroom-gray.vercel.app'];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Note: File uploads are stored on ImageKit only - no local file serving

app.get('/', (req, res) => {
    res.send({ message: "✅ Server is working!" });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()) + 's',
        gemini: !!process.env.GEMINI_API_KEY,
    });
});

app.use('/student', StudentUploadRouter);

app.use('/adminupload', AdminUploadRouter);
app.use('/admindownload', AdminSearchRouter);
app.use('/adminverifydownload', AdminVerifyRouter);
app.use('/search', SearchRouter);

app.use('/user', userRouter);
app.use('/superadmin', superadminRouter);
app.use('/tools', toolsRouter)
app.use('/meet', meetRouter)
app.use('/classroom', classroomRouter)
app.use('/assignment', assignmentRouter)
app.use('/submission', submissionRouter)
app.use('/admin', adminRouter)


// ---- HTTP + Socket.io ----
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

app.set('io', io);

io.on('connection', (socket) => {
    socket.on('join:classroom', ({ classroomId }) => {
        if (!classroomId) return;
        socket.join(`classroom:${classroomId}`);
    });

    socket.on('leave:classroom', ({ classroomId }) => {
        if (!classroomId) return;
        socket.leave(`classroom:${classroomId}`);
    });

    // Live captions: client pushes text; server broadcasts + stores for summarization
    socket.on('meet:caption', ({ classroomId, text, from }) => {
        if (!classroomId || !text) return;
        appendCaption(classroomId, text);
        io.to(`classroom:${classroomId}`).emit('meet:caption', {
            classroomId,
            text,
            from: from || 'participant',
            at: new Date().toISOString(),
        });
    });
});

server.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});
