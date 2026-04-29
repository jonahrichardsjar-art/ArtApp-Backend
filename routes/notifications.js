// backend/routes/notifications.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();


/**
 * Sends push notifications to all tokens for a given profile.
 * Checks per-type notification preferences before sending.
 * type: 'like' | 'comment' | 'follow'
 */
export async function sendPush(recipientProfileId, title, body, type = null) {
    try {
        // Check notification preferences
        if (type) {
            const colMap = { like: 'notify_likes', comment: 'notify_comments', follow: 'notify_follows' };
            const col = colMap[type];
            if (col) {
                const prefResult = await pool.query(
                    `SELECT us.${col} FROM user_settings us
                     JOIN profiles pr ON pr.user_id = us.user_id
                     WHERE pr.id = $1`,
                    [recipientProfileId]
                );
                if (prefResult.rows.length > 0 && prefResult.rows[0][col] === false) return;
            }
        }

        const result = await pool.query(
            `SELECT token FROM push_tokens WHERE profile_id = $1`,
            [recipientProfileId]
        );
        if (result.rows.length === 0) return;

        const messages = result.rows.map(row => ({
            to:    row.token,
            sound: 'default',
            title,
            body,
        }));

        await fetch('https://exp.host/--/api/v2/push/send', {
            method:  'POST',
            headers: {
                'Content-Type':    'application/json',
                'Accept':          'application/json',
                'Accept-Encoding': 'gzip, deflate',
            },
            body: JSON.stringify(messages),
        });
    } catch (err) {
        console.error('PUSH NOTIFICATION ERROR:', err);
    }
}

/**
 * POST /notifications/push-token
 * Saves or updates the device's push token for the current user.
 * Body: { token, platform }
 */
router.post('/push-token', requireAuth, async (req, res) => {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        await pool.query(
            `INSERT INTO push_tokens (profile_id, token, platform)
             VALUES ($1, $2, $3)
             ON CONFLICT (profile_id, token) DO UPDATE SET platform = $3`,
            [profileId, token, platform ?? null]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('PUSH TOKEN ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /notifications/unread
 * Returns count of unread notifications for the badge.
 */
router.get('/unread', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM notifications
             WHERE recipient_profile_id = $1
               AND is_read = FALSE
               AND created_at > now() - INTERVAL '7 days'`,
            [profileId]
        );
        res.json({ count: result.rows[0].count });
    } catch (err) {
        console.error('UNREAD NOTIFICATIONS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /notifications
 * Returns last 7 days of notifications grouped by post+type.
 * Marks all as read.
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Fetch all notifications in last 7 days with actor and post info
        const result = await pool.query(
            `SELECT
                n.id,
                n.type,
                n.post_id,
                n.actor_profile_id,
                n.is_read,
                n.created_at,
                -- Actor info
                actor.username            AS actor_username,
                actor.display_name        AS actor_display_name,
                actor.profile_picture_url AS actor_avatar,
                -- Post info (NULL for follow notifications)
                p.caption                 AS post_caption,
                p.thumbnail_photo         AS post_thumbnail,
                p.media_url               AS post_media_url
             FROM notifications n
             JOIN profiles actor ON actor.id = n.actor_profile_id
             LEFT JOIN posts p   ON p.id = n.post_id
             WHERE n.recipient_profile_id = $1
               AND n.created_at > now() - INTERVAL '7 days'
               AND (p.is_archived = FALSE OR n.post_id IS NULL)
               AND actor.is_archived = FALSE
             ORDER BY n.created_at DESC`,
            [profileId]
        );

        // Mark all as read
        await pool.query(
            `UPDATE notifications
             SET is_read = TRUE
             WHERE recipient_profile_id = $1
               AND is_read = FALSE`,
            [profileId]
        );

        // Group by post_id + type on the server
        // Follow notifications group by type only (no post_id)
        const groupMap = new Map();
        for (const row of result.rows) {
            const key = row.type === 'follow'
                ? 'follow'
                : `${row.post_id}__${row.type}`;

            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    post_id:        row.post_id,
                    type:           row.type,
                    post_caption:   row.post_caption,
                    post_thumbnail: row.post_thumbnail ?? row.post_media_url,
                    actors:         [],
                    latest_at:      row.created_at,
                    has_unread:     false,
                });
            }
            const group = groupMap.get(key);
            group.actors.push({
                profile_id:   row.actor_profile_id,
                username:     row.actor_username,
                display_name: row.actor_display_name,
                avatar:       row.actor_avatar,
                created_at:   row.created_at,
            });
            if (!row.is_read) group.has_unread = true;
            if (row.created_at > group.latest_at) group.latest_at = row.created_at;
        }

        const groups = Array.from(groupMap.values())
            .sort((a, b) => new Date(b.latest_at) - new Date(a.latest_at));

        res.json({ groups });
    } catch (err) {
        console.error('NOTIFICATIONS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
