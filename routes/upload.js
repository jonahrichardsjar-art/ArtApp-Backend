// backend/routes/upload.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import multer from 'multer';
import multerS3 from 'multer-s3';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const router = express.Router();

// ─── Strict MIME allowlist — declared first so multer fileFilter can use it ───
const ALLOWED_IMAGE_TYPES = new Set([
    'image/jpeg', 'image/jpg', 'image/png',
    'image/gif',  'image/webp', 'image/heic', 'image/heif',
]);

const ALLOWED_VIDEO_TYPES = new Set([
    'video/mp4', 'video/quicktime', 'video/mov',
]);

const ALLOWED_MEDIA_TYPES = new Set([
    ...ALLOWED_IMAGE_TYPES,
    ...ALLOWED_VIDEO_TYPES,
]);

const MIME_TO_EXT = {
    'image/jpeg':      'jpg',  'image/jpg':       'jpg',
    'image/png':       'png',  'image/gif':        'gif',
    'image/webp':      'webp', 'image/heic':       'heic', 'image/heif': 'heif',
    'video/mp4':       'mp4',  'video/quicktime':  'mov',  'video/mov':  'mov',
};

// ─── S3 client ────────────────────────────────────────────────────────────────
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// ─── Multer-S3 storage (images only — existing endpoint) ─────────────────────
const upload = multer({
    storage: multerS3({
        s3,
        bucket: (req, file, cb) => cb(null, process.env.S3_BUCKET_NAME),
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
            const ext    = MIME_TO_EXT[file.mimetype] ?? 'jpg';
            const unique = crypto.randomUUID();
            cb(null, `profile-pictures/${unique}.${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, GIF, WebP, and HEIC images are allowed'));
        }
    },
});

// ─── Multer-S3 storage (videos) ──────────────────────────────────────────────
const videoUpload = multer({
    storage: multerS3({
        s3,
        bucket: (req, file, cb) => cb(null, process.env.S3_BUCKET_NAME),
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
            const ext    = MIME_TO_EXT[file.mimetype] ?? 'mp4';
            const unique = crypto.randomUUID();
            cb(null, `videos/${unique}.${ext}`);
        },
    }),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB for videos
    fileFilter: (req, file, cb) => {
        if (ALLOWED_VIDEO_TYPES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only MP4 and MOV video files are allowed'));
        }
    },
});

/**
 * POST /upload/profile-picture
 * Multipart form-data with field name "image"
 * Returns { url } — a public S3 URL
 */
router.post('/profile-picture', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ url: req.file.location });
});

/**
 * POST /upload/video
 * Multipart form-data with field name "video"
 * Accepts MP4 and MOV files up to 50MB.
 * Returns { url } — a public S3 URL
 */
router.post('/video', requireAuth, (req, res) => {
    videoUpload.single('video')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Video too large. Maximum size is 50MB.' });
            }
            return res.status(400).json({ error: err.message || 'Video upload failed' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }
        res.json({ url: req.file.location });
    });
});

/**
 * POST /upload/base64
 * Accepts a base64-encoded image OR video as JSON and uploads it to S3.
 * Used by the web version where multipart/form-data causes CORS issues.
 * Body: { base64, mimeType }
 */
router.post('/base64', requireAuth, async (req, res) => {
    const { base64, mimeType = 'image/jpeg' } = req.body;
    if (!base64) return res.status(400).json({ error: 'No media data provided' });

    const isImage = ALLOWED_IMAGE_TYPES.has(mimeType);
    const isVideo = ALLOWED_VIDEO_TYPES.has(mimeType);

    if (!isImage && !isVideo) {
        return res.status(400).json({ error: 'Only JPEG, PNG, GIF, WebP, HEIC images and MP4/MOV videos are allowed' });
    }

    // Enforce size limits based on type
    const maxEncoded = isVideo
        ? 67 * 1024 * 1024  // ~50MB decoded
        : 7.5 * 1024 * 1024; // ~5MB decoded

    if (base64.length > maxEncoded) {
        const maxLabel = isVideo ? '50MB' : '5MB';
        return res.status(400).json({ error: `File too large. Maximum size is ${maxLabel}.` });
    }

    try {
        const buffer = Buffer.from(base64, 'base64');
        const ext    = MIME_TO_EXT[mimeType] ?? (isVideo ? 'mp4' : 'jpg');
        const folder = isVideo ? 'videos' : 'profile-pictures';
        const key    = `${folder}/${crypto.randomUUID()}.${ext}`;

        await s3.send(new PutObjectCommand({
            Bucket:      process.env.S3_BUCKET_NAME,
            Key:         key,
            Body:        buffer,
            ContentType: mimeType,
        }));

        const url = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
        res.json({ url });
    } catch (err) {
        console.error('BASE64 UPLOAD ERROR:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

export default router;
