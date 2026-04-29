// backend/routes/reports.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();


const VALID_REASONS = [
    'Spam',
    'Harassment or bullying',
    'Hate speech',
    'Nudity or sexual content',
    'Violence or dangerous content',
    'Copyright infringement (DMCA)',
    'Misinformation',
    'Other',
];

/**
 * POST /reports/post/:postId
 * Report a post.
 * Body: { reason, details? }
 */
router.post('/post/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const { reason, details } = req.body;

    if (!reason || !VALID_REASONS.includes(reason)) {
        return res.status(400).json({ error: 'Invalid reason' });
    }

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Check post exists
        const postCheck = await pool.query(
            `SELECT id FROM posts WHERE id = $1 AND is_archived = FALSE`,
            [postId]
        );
        if (postCheck.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

        // Prevent duplicate reports from same user
        const dupCheck = await pool.query(
            `SELECT id FROM reports
             WHERE reporter_profile_id = $1 AND reported_post_id = $2`,
            [profileId, postId]
        );
        if (dupCheck.rows.length > 0) {
            return res.status(400).json({ error: 'You have already reported this post' });
        }

        await pool.query(
            `INSERT INTO reports (reporter_profile_id, reported_post_id, reason, details)
             VALUES ($1, $2, $3, $4)`,
            [profileId, postId, reason, details?.trim() || null]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('REPORT POST ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /reports/profile/:profileId
 * Report a user profile.
 * Body: { reason, details? }
 */
router.post('/profile/:reportedProfileId', requireAuth, async (req, res) => {
    const { reportedProfileId } = req.params;
    const { reason, details }   = req.body;

    if (!reason || !VALID_REASONS.includes(reason)) {
        return res.status(400).json({ error: 'Invalid reason' });
    }

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        if (profileId === reportedProfileId) {
            return res.status(400).json({ error: 'You cannot report yourself' });
        }

        // Prevent duplicate reports
        const dupCheck = await pool.query(
            `SELECT id FROM reports
             WHERE reporter_profile_id = $1 AND reported_profile_id = $2`,
            [profileId, reportedProfileId]
        );
        if (dupCheck.rows.length > 0) {
            return res.status(400).json({ error: 'You have already reported this profile' });
        }

        await pool.query(
            `INSERT INTO reports (reporter_profile_id, reported_profile_id, reason, details)
             VALUES ($1, $2, $3, $4)`,
            [profileId, reportedProfileId, reason, details?.trim() || null]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('REPORT PROFILE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /reports
 * Admin only — lists all pending reports.
 * Protected by ADMIN_SECRET header.
 */
router.get('/', async (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        const result = await pool.query(
            `SELECT
                r.id,
                r.reason,
                r.details,
                r.status,
                r.created_at,
                rpr.username  AS reporter_username,
                pp.username   AS reported_post_author,
                p.caption     AS reported_post_caption,
                rpp.username  AS reported_profile_username
             FROM reports r
             LEFT JOIN profiles rpr ON rpr.id = r.reporter_profile_id
             LEFT JOIN posts    p   ON p.id   = r.reported_post_id
             LEFT JOIN profiles pp  ON pp.id  = p.author_profile_id
             LEFT JOIN profiles rpp ON rpp.id = r.reported_profile_id
             ORDER BY r.created_at DESC
             LIMIT 200`
        );
        res.json({ reports: result.rows });
    } catch (err) {
        console.error('GET REPORTS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /reports/:reportId
 * Admin only — update report status.
 * Body: { status }
 */
router.patch('/:reportId', async (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { reportId } = req.params;
    const { status }   = req.body;
    const valid        = ['pending', 'reviewed', 'actioned', 'dismissed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    try {
        await pool.query(
            `UPDATE reports SET status = $1, reviewed_at = NOW() WHERE id = $2`,
            [status, reportId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('PATCH REPORT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
export { VALID_REASONS };
