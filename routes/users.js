// backend/routes/users.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import { sendPush } from './notifications.js';

const router = express.Router();

/**
 * GET /users/:profileId
 * Returns another user's public profile.
 * - If the viewer is blocked by the target, posts are hidden.
 * - Only posts from public (non-private) projects are shown.
 */
router.get('/:profileId', requireAuth, async (req, res) => {
    const { profileId } = req.params;
    try {
        // 1. Get the viewer's profile id
        const viewerResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (viewerResult.rows.length === 0) {
            return res.status(404).json({ error: 'Your profile not found' });
        }
        const viewerProfileId = viewerResult.rows[0].id;

        // 2. Get the target profile
        const profileResult = await pool.query(
            `SELECT
                p.id,
                p.username,
                p.display_name,
                p.bio,
                p.profile_picture_url,
                p.list_of_fans,
                p.list_of_fandoms,
                p.created_at
             FROM profiles p
             WHERE p.id = $1
               AND p.is_archived = FALSE`,
            [profileId]
        );
        if (profileResult.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        const profile = profileResult.rows[0];

        // 3. Check if the viewer is blocked by the target
        const blockedResult = await pool.query(
            `SELECT blocked_users FROM profile_settings WHERE profile_id = $1`,
            [profileId]
        );
        const blockedUsers  = blockedResult.rows[0]?.blocked_users ?? [];
        const viewerBlocked = blockedUsers.includes(viewerProfileId);

        // 4. Count projects the target is a member of (non-archived, public)
        const projectsResult = await pool.query(
            `SELECT COUNT(*) AS count
             FROM project_members pm
             JOIN projects pr ON pr.id = pm.project_id
             WHERE pm.profile_id = $1
               AND pr.is_archived = FALSE
               AND pr.is_private  = FALSE`,
            [profileId]
        );

        // 5. Fetch posts — standalone posts always visible, project posts only
        //    if the project is public and not archived.
        //    Hidden entirely if the viewer is blocked.
        let posts = [];
        if (!viewerBlocked) {
            const postsResult = await pool.query(
                `SELECT
                    p.id,
                    p.caption,
                    p.media_url,
                    p.thumbnail_photo,
                    p.is_public,
                    p.created_at,
                    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                    (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                       AND c.is_archived = FALSE)::int                                          AS comments_count
                 FROM posts p
                 LEFT JOIN projects pr ON pr.id = p.project_id
                 WHERE p.author_profile_id = $1
                   AND p.is_archived = FALSE
                   AND p.is_public   = TRUE
                   AND (
                       p.project_id IS NULL
                       OR (pr.is_archived = FALSE AND pr.is_private = FALSE)
                   )
                 ORDER BY p.created_at DESC`,
                [profileId]
            );
            posts = postsResult.rows;
        }

        // 6. Check if the viewer is currently fanning the target
        const viewerProfileResult = await pool.query(
            `SELECT list_of_fandoms FROM profiles WHERE id = $1`,
            [viewerProfileId]
        );
        const viewerFandoms = viewerProfileResult.rows[0]?.list_of_fandoms ?? [];
        const isFanning     = viewerFandoms.includes(profileId);

        // 7. Check if the viewer has blocked the target
        const viewerSettingsResult = await pool.query(
            `SELECT blocked_users FROM profile_settings WHERE profile_id = $1`,
            [viewerProfileId]
        );
        const viewerBlocked2   = viewerSettingsResult.rows[0]?.blocked_users ?? [];
        const hasBlockedTarget = viewerBlocked2.includes(profileId);

        res.json({
            id:                  profile.id,
            username:            profile.username,
            display_name:        profile.display_name,
            bio:                 profile.bio,
            profile_picture_url: profile.profile_picture_url,
            fans_count:          (profile.list_of_fans    ?? []).length,
            fandom_count:        (profile.list_of_fandoms ?? []).length,
            projects_count:      parseInt(projectsResult.rows[0].count, 10),
            is_fanning:          isFanning,
            has_blocked:         hasBlockedTarget,
            viewer_is_blocked:   viewerBlocked,
            posts,
        });
    } catch (err) {
        console.error('USER PROFILE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /users/:profileId/fan
 * Toggles fanning a user. Adds/removes profileId from viewer's list_of_fandoms
 * and adds/removes viewerProfileId from target's list_of_fans.
 */
router.post('/:profileId/fan', requireAuth, async (req, res) => {
    const { profileId } = req.params;
    try {
        const viewerResult = await pool.query(
            `SELECT id, list_of_fandoms FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (viewerResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

        const viewerProfileId = viewerResult.rows[0].id;
        const fandoms         = viewerResult.rows[0].list_of_fandoms ?? [];
        const isFanning       = fandoms.includes(profileId);

        if (isFanning) {
            // Stop fanning — remove target from viewer's fandoms
            await pool.query(
                `UPDATE profiles
                 SET list_of_fandoms = array_remove(list_of_fandoms, $1::uuid)
                 WHERE id = $2`,
                [profileId, viewerProfileId]
            );
            // Remove viewer from target's fans
            await pool.query(
                `UPDATE profiles
                 SET list_of_fans = array_remove(list_of_fans, $1::uuid)
                 WHERE id = $2`,
                [viewerProfileId, profileId]
            );
            res.json({ is_fanning: false });
        } else {
            // Fan — add target to viewer's fandoms
            await pool.query(
                `UPDATE profiles
                 SET list_of_fandoms = array_append(list_of_fandoms, $1::uuid)
                 WHERE id = $2`,
                [profileId, viewerProfileId]
            );
            // Add viewer to target's fans
            await pool.query(
                `UPDATE profiles
                 SET list_of_fans = array_append(list_of_fans, $1::uuid)
                 WHERE id = $2`,
                [viewerProfileId, profileId]
            );
            // Fire follow notification
            await pool.query(
                `INSERT INTO notifications
                    (recipient_profile_id, type, post_id, actor_profile_id)
                 VALUES ($1, 'follow', NULL, $2)
                 ON CONFLICT (recipient_profile_id, type, actor_profile_id)
                 WHERE type = 'follow'
                 DO NOTHING`,
                [profileId, viewerProfileId]
            );
            // Push notification
            const actor = await pool.query(
                `SELECT username, display_name FROM profiles WHERE id = $1`,
                [viewerProfileId]
            );
            const name = actor.rows[0]?.display_name ?? actor.rows[0]?.username ?? 'Someone';
            sendPush(profileId, 'New Fan', `${name} started fanning you`, 'follow');
            res.json({ is_fanning: true });
        }
    } catch (err) {
        console.error('FAN TOGGLE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /users/:profileId/block
 * Toggles blocking a user. Adds/removes profileId from viewer's blocked_users
 * in profile_settings.
 */
router.post('/:profileId/block', requireAuth, async (req, res) => {
    const { profileId } = req.params;
    try {
        const viewerResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (viewerResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const viewerProfileId = viewerResult.rows[0].id;

        // Get current blocked list
        const settingsResult = await pool.query(
            `SELECT blocked_users FROM profile_settings WHERE profile_id = $1`,
            [viewerProfileId]
        );
        const blockedUsers  = settingsResult.rows[0]?.blocked_users ?? [];
        const hasBlocked    = blockedUsers.includes(profileId);

        if (hasBlocked) {
            // Unblock
            await pool.query(
                `UPDATE profile_settings
                 SET blocked_users = array_remove(blocked_users, $1::uuid)
                 WHERE profile_id = $2`,
                [profileId, viewerProfileId]
            );
            res.json({ has_blocked: false });
        } else {
            // Block
            await pool.query(
                `UPDATE profile_settings
                 SET blocked_users = array_append(blocked_users, $1::uuid)
                 WHERE profile_id = $2`,
                [profileId, viewerProfileId]
            );
            res.json({ has_blocked: true });
        }
    } catch (err) {
        console.error('BLOCK TOGGLE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
