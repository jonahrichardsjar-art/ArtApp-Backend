// backend/index.js
import pool from './db.js';
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { initIO } from './socket.js';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import authRoutes          from './routes/auth.js';
import profileRouter       from './routes/profile.js';
import uploadRouter        from './routes/upload.js';
import feedRouter          from './routes/feed.js';
import discoverRouter      from './routes/discover.js';
import usersRouter         from './routes/users.js';
import projectsRouter      from './routes/projects.js';
import canvasRouter        from './routes/canvas.js';
import postsRouter         from './routes/posts.js';
import filesRouter         from './routes/files.js';
import notificationsRouter from './routes/notifications.js';
import suggestionsRouter   from './routes/suggestions.js';
import reportsRouter       from './routes/reports.js';
import chatRouter          from './routes/chat.js';

// ─── Env var validation ───────────────────────────────────────────────────────
const REQUIRED_ENV = [
    'JWT_SECRET', 'DATABASE_URL', 'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET_NAME',
    'GMAIL_USER', 'GMAIL_PASS', 'ADMIN_SECRET',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
    console.warn('WARNING: Missing environment variables:', missing.join(', '));
    console.warn('Some features may not work correctly.');
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    console.warn('WARNING: JWT_SECRET is too short. Generate a stronger one.');
}

const app    = express();
const server = createServer(app);

// ─── Security headers (helmet) ────────────────────────────────────────────────
// Hides X-Powered-By, sets strict transport security, prevents clickjacking etc.
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow S3 images to load
}));

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = initIO(server);

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.id;
        next();
    } catch {
        next(new Error('Invalid token'));
    }
});

io.on('connection', async (socket) => {
        // Join personal room for chat messages
        try {
            const profileResult = await pool.query(
                `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
                [socket.userId]
            );
            if (profileResult.rows.length > 0) {
                const profileId = profileResult.rows[0].id;
                socket.profileId = profileId;
                socket.join(`user:${profileId}`);
            }
        } catch (err) {
            console.error('SOCKET PROFILE LOOKUP ERROR:', err);
        };

        socket.on('join_project', (projectId) => {
            socket.join(`project:${projectId}`);
        });
        socket.on('leave_project', (projectId) => {
            socket.leave(`project:${projectId}`);
        });

        // Chat: typing indicator
        socket.on('chat:typing', ({ chatId }) => {
            if (!socket.profileId) return;
            socket.to(`chat:${chatId}`).emit('chat:typing', {
                chat_id:    chatId,
                profile_id: socket.profileId,
            });
        });

        // Join chat rooms for typing indicators
        socket.on('join_chat', (chatId) => {
            socket.join(`chat:${chatId}`);
        });
        socket.on('leave_chat', (chatId) => {
            socket.leave(`chat:${chatId}`);
        });
    });

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Only allow requests from artcellium.com and localhost (dev).
// Blocks any random website from calling your API with a user's credentials.
const ALLOWED_ORIGINS = [
    'https://artcellium.com',
    'https://www.artcellium.com',
    'http://localhost:8081',  // Expo web dev
    'http://localhost:19006', // Expo web alt port
    'exp://localhost:8081',   // Expo Go
];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (native mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods:              ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders:       ['Authorization', 'Content-Type', 'x-admin-secret'],
    preflightContinue:    false,
    optionsSuccessStatus: 204,
}));

// ─── Body parsing — strict size limits ───────────────────────────────────────
// 10mb for uploads (base64 images), 50kb for everything else.
// This prevents attackers sending huge JSON payloads to exhaust memory.
app.use((req, res, next) => {
    const isUpload = req.path.startsWith('/upload');
    express.json({ limit: isUpload ? '10mb' : '50kb' })(req, res, next);
});

// ─── Rate limiters ────────────────────────────────────────────────────────────

// Auth: 10 attempts per 15 minutes per IP — protects against brute force
const authLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              10,
    standardHeaders:  true,
    legacyHeaders:    false,
    message:          { error: 'Too many attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true,
});

// Suggestions: 5 per hour per IP — prevents spam
const suggestionsLimiter = rateLimit({
    windowMs:        60 * 60 * 1000,
    max:             5,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Too many suggestions. Please try again later.' },
});

// Uploads: 30 per hour per IP — large file uploads are expensive
const uploadLimiter = rateLimit({
    windowMs:        60 * 60 * 1000,
    max:             30,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Upload limit reached. Please try again later.' },
});

// General API: 200 requests per minute per IP — prevents scraping/flooding
const generalLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             200,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Too many requests. Please slow down.' },
});

// Forgot password: 3 per hour per IP — prevents email spam
const forgotPasswordLimiter = rateLimit({
    windowMs:        60 * 60 * 1000,
    max:             3,
    standardHeaders: true,
    legacyHeaders:   false,
    message:         { error: 'Too many reset attempts. Please try again in an hour.' },
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/reset', helmet.contentSecurityPolicy({
    directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],
        connectSrc:  ["'self'", 'https://artcellium.com'],
        styleSrc:    ["'self'", "'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:'],
        fontSrc:     ["'self'"],
        objectSrc:   ["'none'"],
    },
}), (req, res) => {
    req.url = '/reset-page';
    authRoutes(req, res, () => res.status(404).send('Not found'));
});

// ─── Universal link verification files ───────────────────────────────────────
// iOS checks /.well-known/apple-app-site-association to verify universal links
app.get('/.well-known/apple-app-site-association', (req, res) => {
    res.json({
        applinks: {
            apps: [],
            details: [{
                appID:  'TEAMID.com.jonahrichards.artcellium',
                paths:  ['/post/*', '/user/*', '/project/*'],
            }],
        },
    });
});

// Android checks /.well-known/assetlinks.json for app links
app.get('/.well-known/assetlinks.json', (req, res) => {
    res.json([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace:             'android_app',
            package_name:          'com.jonahrichards.artcellium',
            sha256_cert_fingerprints: [
                // Add your APK signing certificate SHA-256 fingerprint here
                // Get it with: keytool -list -v -keystore your.keystore
            ],
        },
    }]);
});

app.use('/auth/forgot-password', forgotPasswordLimiter);
app.use('/auth',          authLimiter,        authRoutes);
app.use('/suggestions',   suggestionsLimiter, suggestionsRouter);
app.use('/upload',        uploadLimiter,      uploadRouter);
app.use('/profile',       generalLimiter,     profileRouter);
app.use('/feed',          generalLimiter,     feedRouter);
app.use('/discover',      generalLimiter,     discoverRouter);
app.use('/users',         generalLimiter,     usersRouter);
app.use('/projects',      generalLimiter,     projectsRouter);
app.use('/canvas',        generalLimiter,     canvasRouter);
app.use('/posts',         generalLimiter,     postsRouter);
app.use('/files',         generalLimiter,     filesRouter);
app.use('/notifications', generalLimiter,     notificationsRouter);
app.use('/reports',       generalLimiter,     reportsRouter);
app.use('/chat',          generalLimiter,     chatRouter);

// ─── Deep link web fallback pages ────────────────────────────────────────────
// These pages try to open the app via universal links.
// If the app isn't installed, they show a simple web page instead.
function deepLinkPage(appPath, title, description) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>${title} — Artcellium</title>
    <meta property="og:title" content="${title}"/>
    <meta property="og:description" content="${description}"/>
    <meta property="og:site_name" content="Artcellium"/>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #000; color: #d0d0c0;
            min-height: 100vh; display: flex;
            align-items: center; justify-content: center;
            padding: 24px; text-align: center;
        }
        .card {
            background: #111; border: 1px solid #2a2a2a;
            border-radius: 16px; padding: 40px;
            width: 100%; max-width: 400px; gap: 20px;
            display: flex; flex-direction: column; align-items: center;
        }
        .logo { font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
        h1 { font-size: 20px; font-weight: 600; margin: 8px 0; }
        p  { color: #888; font-size: 14px; line-height: 1.6; }
        .btn {
            display: inline-block; background: #d0d0c0; color: #000;
            padding: 14px 28px; border-radius: 10px; font-weight: 700;
            font-size: 15px; text-decoration: none; margin-top: 8px;
            width: 100%;
        }
        .sub { color: #555; font-size: 13px; margin-top: 4px; }
    </style>
</head>
<body>
<div class="card">
    <div class="logo">Artcellium</div>
    <h1>${title}</h1>
    <p>${description}</p>
    <a class="btn" href="artcellium:/${appPath}">Open in App</a>
    <p class="sub">Don't have the app? <a href="https://apps.apple.com/app/artcellium/id6744824690" style="color:#888">Download it here</a></p>
</div>
<script>
    // Try to open the app immediately
    window.location = 'artcellium:/${appPath}';
    // If still here after 2s, app isn't installed — page stays visible
</script>
</body>
</html>`;
}

app.get('/post/:postId', (req, res) => {
    res.send(deepLinkPage(
        `post/${req.params.postId}`,
        'View Post',
        'View this post on Artcellium — the creative collaboration platform.'
    ));
});

app.get('/user/:profileId', (req, res) => {
    res.send(deepLinkPage(
        `user/${req.params.profileId}`,
        'View Profile',
        'View this creator\'s profile on Artcellium.'
    ));
});

app.get('/project/:projectId', (req, res) => {
    res.send(deepLinkPage(
        `project/${req.params.projectId}`,
        'View Project',
        'View this creative project on Artcellium.'
    ));
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Catches any unhandled errors and returns a safe message without leaking
// stack traces or internal details to the client.
app.use((err, req, res, next) => {
    // CORS errors
    if (err.message?.startsWith('CORS:')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    console.error('UNHANDLED ERROR:', err);
    res.status(500).json({ error: 'Something went wrong' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(3001, '0.0.0.0', () => {
    console.log('Backend running on port 3001');
});
