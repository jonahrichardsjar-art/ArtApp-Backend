// backend/routes/files.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { getIO } from '../socket.js';
import { recalcStatus, cascadeGreen } from '../canvasUtils.js';

const router = express.Router();

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const FILES_BUCKET = 'artcellium-post-files';


// ─── Get profile ID helper ────────────────────────────────────────────────────
async function getProfileId(userId) {
    const result = await pool.query(
        `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
        [userId]
    );
    return result.rows[0]?.id ?? null;
}

// ─── Check assignment ─────────────────────────────────────────────────────────
async function isAssigned(postId, profileId) {
    const result = await pool.query(
        `SELECT 1 FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
        [postId, profileId]
    );
    return result.rows.length > 0;
}

// ─── Check project membership ─────────────────────────────────────────────────
async function isProjectMember(postId, profileId) {
    // Posts with no project_id are standalone — anyone can download
    const postResult = await pool.query(
        `SELECT project_id FROM posts WHERE id = $1 AND is_archived = FALSE`,
        [postId]
    );
    if (postResult.rows.length === 0) return false;
    const projectId = postResult.rows[0].project_id;
    if (!projectId) return true; // standalone post — open to all

    const memberResult = await pool.query(
        `SELECT 1 FROM project_members WHERE project_id = $1 AND profile_id = $2`,
        [projectId, profileId]
    );
    return memberResult.rows.length > 0;
}

/**
 * POST /files/:postId/presign
 * Returns a presigned S3 PUT URL so the client can upload directly.
 * Only assigned members can upload.
 * Body: { fileName, fileSize, mimeType }
 */
router.post('/:postId/presign', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const { fileName, fileSize, mimeType = 'application/octet-stream' } = req.body;
    if (!fileName) return res.status(400).json({ error: 'fileName is required' });

    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        // Check post exists
        const postCheck = await pool.query(
            `SELECT id, project_id FROM posts WHERE id = $1 AND is_archived = FALSE`,
            [postId]
        );
        if (postCheck.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

        const { project_id } = postCheck.rows[0];

        // If post belongs to a project, must be assigned
        if (project_id) {
            const assigned = await isAssigned(postId, profileId);
            if (!assigned) return res.status(403).json({ error: 'Only assigned members can upload files' });
        } else {
            // Standalone post — must be the author
            const authorCheck = await pool.query(
                `SELECT 1 FROM posts WHERE id = $1 AND author_profile_id = $2`,
                [postId, profileId]
            );
            if (authorCheck.rows.length === 0) return res.status(403).json({ error: 'Only the post author can upload files' });
        }

        // Generate unique S3 key
        const ext    = fileName.includes('.') ? fileName.split('.').pop() : '';
        const s3Key  = `post-files/${postId}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;

        const command = new PutObjectCommand({
            Bucket:      FILES_BUCKET,
            Key:         s3Key,
            ContentType: mimeType,
            ContentLength: fileSize,
        });

        // Presigned URL valid for 1 hour — enough for large file uploads
        const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

        res.json({ presignedUrl, s3Key, fileName });
    } catch (err) {
        console.error('PRESIGN ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /files/:postId/confirm
 * Called after the client successfully uploads to S3.
 * Saves the file record and sets node status to green (Complete) if it's a project post.
 * Body: { s3Key, fileName, fileSize }
 */
router.post('/:postId/confirm', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const { s3Key, fileName, fileSize = 0 } = req.body;
    if (!s3Key || !fileName) return res.status(400).json({ error: 's3Key and fileName are required' });

    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        const result = await pool.query(
            `INSERT INTO post_files (post_id, uploader_profile_id, file_name, file_size, s3_key)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, file_name, file_size, created_at`,
            [postId, profileId, fileName, fileSize, s3Key]
        );

        // Auto-recalc status when file is uploaded to a project post
        const postResult = await pool.query(
            `SELECT project_id FROM posts WHERE id = $1 AND is_archived = FALSE`,
            [postId]
        );
        let newStatus = null;
        if (postResult.rows[0]?.project_id) {
            const projectId = postResult.rows[0].project_id;
            // Check dependencies
            const deps = await pool.query(
                `SELECT p.status FROM post_links pl
                 JOIN posts p ON p.id = pl.from_post_id
                 WHERE pl.to_post_id = $1 AND p.is_archived = FALSE`,
                [postId]
            );
            const allDepsGreen = deps.rows.length === 0 || deps.rows.every(r => r.status === 'green');
            newStatus = allDepsGreen ? 'green' : 'blue';
            await pool.query(
                `UPDATE posts SET status = $1 WHERE id = $2`,
                [newStatus, postId]
            );
            // Broadcast this node's status change
            try {
                getIO().to(`project:${projectId}`).emit('canvas:node_status', {
                    projectId,
                    postId,
                    status: newStatus,
                });
            } catch {}

            // If this node became green, cascade to downstream nodes
            if (newStatus === 'green') {
                try {
                    await cascadeGreen(postId, projectId);
                } catch (err) {
                    console.error('CASCADE ERROR:', err);
                }
            }

        }

        res.status(201).json({ file: result.rows[0], status: newStatus });
    } catch (err) {
        console.error('CONFIRM UPLOAD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /files/:postId
 * Lists all files on a post with presigned download URLs.
 * Project posts: only project members can download.
 * Standalone posts: anyone authenticated can download.
 */
router.get('/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        const canAccess = await isProjectMember(postId, profileId);
        if (!canAccess) return res.status(403).json({ error: 'You must be a project member to download files' });

        const filesResult = await pool.query(
            `SELECT pf.id, pf.file_name, pf.file_size, pf.s3_key, pf.created_at,
                    pr.username AS uploader_username, pr.display_name AS uploader_display_name
             FROM post_files pf
             JOIN profiles pr ON pr.id = pf.uploader_profile_id
             WHERE pf.post_id = $1
             ORDER BY pf.created_at DESC`,
            [postId]
        );

        // Generate presigned GET URLs for each file (1 hour expiry)
        const files = await Promise.all(filesResult.rows.map(async (file) => {
            const command = new GetObjectCommand({
                Bucket:                     FILES_BUCKET,
                Key:                        file.s3_key,
                ResponseContentDisposition: `attachment; filename="${file.file_name}"`,
            });
            const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
            return {
                id:                    file.id,
                file_name:             file.file_name,
                file_size:             file.file_size,
                created_at:            file.created_at,
                uploader_username:     file.uploader_username,
                uploader_display_name: file.uploader_display_name,
                download_url:          downloadUrl,
            };
        }));

        res.json({ files });
    } catch (err) {
        console.error('LIST FILES ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /files/file/:fileId
 * Deletes a file from S3 and the database.
 * Only assigned members can delete.
 */
router.delete('/file/:fileId', requireAuth, async (req, res) => {
    const { fileId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        // Get the file
        const fileResult = await pool.query(
            `SELECT pf.id, pf.s3_key, pf.post_id, p.project_id
             FROM post_files pf
             JOIN posts p ON p.id = pf.post_id
             WHERE pf.id = $1`,
            [fileId]
        );
        if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });

        const { s3_key, post_id, project_id } = fileResult.rows[0];

        // Must be assigned (for project posts) or author (for standalone)
        if (project_id) {
            const assigned = await isAssigned(post_id, profileId);
            if (!assigned) return res.status(403).json({ error: 'Only assigned members can delete files' });
        } else {
            const authorCheck = await pool.query(
                `SELECT 1 FROM posts WHERE id = $1 AND author_profile_id = $2`,
                [post_id, profileId]
            );
            if (authorCheck.rows.length === 0) return res.status(403).json({ error: 'Only the post author can delete files' });
        }

        // Delete from S3
        await s3.send(new DeleteObjectCommand({ Bucket: FILES_BUCKET, Key: s3_key }));

        // Delete from DB
        await pool.query(`DELETE FROM post_files WHERE id = $1`, [fileId]);

        // Recalc status and broadcast if this is a project post
        let newStatus = null;
        if (project_id) {
            newStatus = await recalcStatus(post_id);
            try {
                getIO().to(`project:${project_id}`).emit('canvas:node_status', {
                    projectId: project_id,
                    postId:    post_id,
                    status:    newStatus,
                });
            } catch {}
        }

        res.json({ success: true, status: newStatus });
    } catch (err) {
        console.error('DELETE FILE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
