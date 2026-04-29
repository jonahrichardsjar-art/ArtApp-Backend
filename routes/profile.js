// backend/routes/profile.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { audit } from '../audit.js';

const router = express.Router();

/**
 * GET /profile/me
 * Returns the logged-in user's profile data + their posts.
 * Excludes archived users, profiles, and posts.
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        const profileResult = await pool.query(
            `SELECT
                u.email,
                u.created_at         AS member_since,
                p.id                 AS profile_id,
                p.username,
                p.display_name,
                p.bio,
                p.profile_picture_url,
                p.list_of_fans,
                p.list_of_fandoms
             FROM users u
             JOIN profiles p ON p.user_id = u.id
             WHERE u.id = $1
               AND u.is_archived = FALSE
               AND p.is_archived = FALSE`,
            [req.userId]
        );

        if (profileResult.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const profile = profileResult.rows[0];

        // Count non-archived projects this profile is a member of
        const projectsResult = await pool.query(
            `SELECT COUNT(*) AS count
             FROM project_members pm
             JOIN projects pr ON pr.id = pm.project_id
             WHERE pm.profile_id = $1
               AND pr.is_archived = FALSE`,
            [profile.profile_id]
        );

        // Fetch all non-archived posts by this profile (author sees all including private)
        const postsResult = await pool.query(
            `SELECT
                id,
                caption,
                media_url,
                thumbnail_photo,
                video_url,
                media_type,
                is_public,
                created_at,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int        AS likes_count,
                (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                   AND c.is_archived = FALSE)::int                                        AS comments_count
             FROM posts p
             WHERE author_profile_id = $1
               AND is_archived = FALSE
             ORDER BY created_at DESC`,
            [profile.profile_id]
        );

        res.json({
            profile_id:          profile.profile_id,
            username:            profile.username,
            display_name:        profile.display_name,
            bio:                 profile.bio,
            profile_picture_url: profile.profile_picture_url,
            email:               profile.email,
            member_since:        profile.member_since,
            fans_count:          (profile.list_of_fans    ?? []).length,
            fandom_count:        (profile.list_of_fandoms ?? []).length,
            projects_count:      parseInt(projectsResult.rows[0].count, 10),
            posts:               postsResult.rows,
        });
    } catch (err) {
        console.error('PROFILE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /profile/me
 * Updates display_name, bio, and/or profile_picture_url.
 */
router.patch('/me', requireAuth, async (req, res) => {
    const { display_name, bio, profile_picture_url } = req.body;

    // Length limits
    if (display_name     !== undefined && (typeof display_name !== 'string'     || display_name.length     > 50))   return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
    if (bio              !== undefined && (typeof bio          !== 'string'     || bio.length              > 300))  return res.status(400).json({ error: 'Bio too long (max 300 characters)' });
    if (profile_picture_url !== undefined && typeof profile_picture_url !== 'string') return res.status(400).json({ error: 'Invalid profile picture URL' });

    const fields = [];
    const values = [];
    let idx = 1;

    if (display_name !== undefined)        { fields.push(`display_name = $${idx++}`);        values.push(display_name); }
    if (bio !== undefined)                 { fields.push(`bio = $${idx++}`);                  values.push(bio); }
    if (profile_picture_url !== undefined) { fields.push(`profile_picture_url = $${idx++}`); values.push(profile_picture_url); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    try {
        await pool.query(
            `UPDATE profiles
             SET ${fields.join(', ')}
             WHERE user_id = $${idx}
               AND is_archived = FALSE`,
            [...values, req.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('PROFILE UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /profile/update
 * Same as PATCH /me but as a POST for compatibility.
 */
router.post('/update', async (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    let userId;
    try {
        userId = jwt.verify(token, process.env.JWT_SECRET).id;
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
    const { display_name, bio, profile_picture_url } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (display_name !== undefined)        { fields.push(`display_name = $${idx++}`);        values.push(display_name); }
    if (bio !== undefined)                 { fields.push(`bio = $${idx++}`);                  values.push(bio); }
    if (profile_picture_url !== undefined) { fields.push(`profile_picture_url = $${idx++}`); values.push(profile_picture_url); }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    try {
        await pool.query(
            `UPDATE profiles
             SET ${fields.join(', ')}
             WHERE user_id = $${idx}
               AND is_archived = FALSE`,
            [...values, userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /profile/fans
 * Returns non-archived profiles in the logged-in user's list_of_fans array.
 */
router.get('/fans', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id, list_of_fans
             FROM profiles
             WHERE user_id = $1
               AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

        const fanIds = meResult.rows[0].list_of_fans ?? [];
        if (fanIds.length === 0) return res.json({ users: [] });

        const fansResult = await pool.query(
            `SELECT id, username, display_name, profile_picture_url
             FROM profiles
             WHERE id = ANY($1::uuid[])
               AND is_archived = FALSE
             ORDER BY display_name ASC`,
            [fanIds]
        );
        res.json({ users: fansResult.rows });
    } catch (err) {
        console.error('FANS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /profile/fandoms
 * Returns non-archived profiles in the logged-in user's list_of_fandoms array.
 */
router.get('/fandoms', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id, list_of_fandoms
             FROM profiles
             WHERE user_id = $1
               AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

        const fandomIds = meResult.rows[0].list_of_fandoms ?? [];
        if (fandomIds.length === 0) return res.json({ users: [] });

        const fandomsResult = await pool.query(
            `SELECT id, username, display_name, profile_picture_url
             FROM profiles
             WHERE id = ANY($1::uuid[])
               AND is_archived = FALSE
             ORDER BY display_name ASC`,
            [fandomIds]
        );
        res.json({ users: fandomsResult.rows });
    } catch (err) {
        console.error('FANDOMS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /profile/blocked
 * Returns profiles in the logged-in user's blocked_users list.
 * Archived profiles are still shown here (you can still see who you blocked).
 */
router.get('/blocked', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles
             WHERE user_id = $1
               AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });

        const profileId = meResult.rows[0].id;

        const settingsResult = await pool.query(
            `SELECT blocked_users FROM profile_settings WHERE profile_id = $1`,
            [profileId]
        );

        const blockedIds = settingsResult.rows[0]?.blocked_users ?? [];
        if (blockedIds.length === 0) return res.json({ users: [] });

        // Show blocked users regardless of their archived status
        // so the user can still see and manage their block list
        const blockedResult = await pool.query(
            `SELECT id, username, display_name, profile_picture_url
             FROM profiles
             WHERE id = ANY($1::uuid[])
             ORDER BY display_name ASC`,
            [blockedIds]
        );
        res.json({ users: blockedResult.rows });
    } catch (err) {
        console.error('BLOCKED ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /profile/delete-account
 * Soft-deletes the logged-in user's account following these rules:
 * - Always archives: user, profile, comments, post/comment likes (hard delete)
 * - Archives posts only if they belong to a project where this user is the sole member
 * - Archives projects only if this user is the sole member
 * - Posts/projects with other members are left untouched
 */
router.post('/delete-account', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Get the profile id for this user
        const profileResult = await client.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (profileResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Profile not found' });
        }
        const profileId = profileResult.rows[0].id;

        // 2. Archive projects where this user is the SOLE member
        await client.query(
            `UPDATE projects
             SET is_archived = TRUE
             WHERE id IN (
                 SELECT project_id
                 FROM project_members
                 GROUP BY project_id
                 HAVING COUNT(*) = 1
                    AND MAX(profile_id::text) = $1::text
             )`,
            [profileId]
        );

        // 3. Archive posts that belong to projects where this user is the sole member
        //    (i.e. the project was just archived above, or was already a solo project)
        await client.query(
            `UPDATE posts
             SET is_archived = TRUE
             WHERE author_profile_id = $1
               AND project_id IN (
                   SELECT project_id
                   FROM project_members
                   GROUP BY project_id
                   HAVING COUNT(*) = 1
                      AND MAX(profile_id::text) = $1::text
               )`,
            [profileId]
        );

        // 4. Archive all comments by this profile
        await client.query(
            `UPDATE comments SET is_archived = TRUE WHERE author_profile_id = $1`,
            [profileId]
        );

        // 5. Hard delete post likes and comment likes by this profile
        //    (these tables have no is_archived column)
        await client.query(
            `DELETE FROM post_likes WHERE profile_id = $1`,
            [profileId]
        );
        await client.query(
            `DELETE FROM comment_likes WHERE profile_id = $1`,
            [profileId]
        );

        // 6. Archive the profile
        await client.query(
            `UPDATE profiles SET is_archived = TRUE WHERE id = $1`,
            [profileId]
        );

        // 7. Archive the user — must be last so auth still works during this request
        await client.query(
            `UPDATE users SET is_archived = TRUE WHERE id = $1`,
            [req.userId]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE ACCOUNT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

/**
 * GET /profile/settings
 * Returns user_settings + profile_settings for the logged-in user.
 */
router.get('/settings', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                us.theme,
                us.email_notifications,
                us.notify_likes,
                us.notify_comments,
                us.notify_follows,
                ps.show_email,
                ps.show_projects,
                ps.private_account,
                ps.who_can_comment
             FROM users u
             JOIN profiles pr ON pr.user_id = u.id
             JOIN user_settings    us ON us.user_id    = u.id
             JOIN profile_settings ps ON ps.profile_id = pr.id
             WHERE u.id = $1 AND u.is_archived = FALSE`,
            [req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Settings not found' });
        res.json({ settings: result.rows[0] });
    } catch (err) {
        console.error('GET SETTINGS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /profile/settings
 * Updates user_settings and/or profile_settings.
 * Body: any subset of { theme, notify_likes, notify_comments, notify_follows,
 *                       show_email, show_projects, private_account, who_can_comment }
 */
router.patch('/settings', requireAuth, async (req, res) => {
    const {
        theme, notify_likes, notify_comments, notify_follows,
        show_email, show_projects, private_account, who_can_comment,
    } = req.body;

    try {
        // Get profile id
        const meResult = await pool.query(
            `SELECT pr.id FROM profiles pr WHERE pr.user_id = $1 AND pr.is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Build user_settings update
        const userUpdates = [];
        const userValues  = [];
        let   ui = 1;
        if (theme             !== undefined) { userUpdates.push(`theme = $${ui++}`);              userValues.push(theme); }
        if (notify_likes      !== undefined) { userUpdates.push(`notify_likes = $${ui++}`);       userValues.push(notify_likes); }
        if (notify_comments   !== undefined) { userUpdates.push(`notify_comments = $${ui++}`);    userValues.push(notify_comments); }
        if (notify_follows    !== undefined) { userUpdates.push(`notify_follows = $${ui++}`);     userValues.push(notify_follows); }

        if (userUpdates.length > 0) {
            userValues.push(req.userId);
            await pool.query(
                `UPDATE user_settings SET ${userUpdates.join(', ')} WHERE user_id = $${ui}`,
                userValues
            );
        }

        // Build profile_settings update
        const profUpdates = [];
        const profValues  = [];
        let   pi = 1;
        if (show_email        !== undefined) { profUpdates.push(`show_email = $${pi++}`);         profValues.push(show_email); }
        if (show_projects     !== undefined) { profUpdates.push(`show_projects = $${pi++}`);      profValues.push(show_projects); }
        if (private_account   !== undefined) { profUpdates.push(`private_account = $${pi++}`);   profValues.push(private_account); }
        if (who_can_comment   !== undefined) { profUpdates.push(`who_can_comment = $${pi++}`);   profValues.push(who_can_comment); }

        if (profUpdates.length > 0) {
            profValues.push(profileId);
            await pool.query(
                `UPDATE profile_settings SET ${profUpdates.join(', ')} WHERE profile_id = $${pi}`,
                profValues
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('PATCH SETTINGS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /profile/username
 * Changes the logged-in user's username.
 * Body: { username }
 */
router.patch('/username', requireAuth, async (req, res) => {
    const { username } = req.body;
    if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username.trim())) {
        return res.status(400).json({ error: 'Username must be 3–30 characters and only contain letters, numbers, and underscores' });
    }
    try {
        await pool.query(
            `UPDATE profiles SET username = $1
             WHERE user_id = $2 AND is_archived = FALSE`,
            [username.trim().toLowerCase(), req.userId]
        );
        audit.usernameChange(req.userId, req.ip);
        res.json({ success: true, username: username.trim().toLowerCase() });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'That username is already taken' });
        console.error('CHANGE USERNAME ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /profile/email
 * Changes the logged-in user's email. Requires current password.
 * Body: { email, currentPassword }
 */
router.patch('/email', requireAuth, async (req, res) => {
    const { email, currentPassword } = req.body;
    if (!email?.trim())        return res.status(400).json({ error: 'Email is required' });
    if (!currentPassword)      return res.status(400).json({ error: 'Current password is required' });

    try {
        const userResult = await pool.query(
            `SELECT id, password_hash FROM users WHERE id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Incorrect password' });

        await pool.query(
            `UPDATE users
             SET email = $1,
                 token_version = token_version + 1
             WHERE id = $2`,
            [email.trim().toLowerCase(), req.userId]
        );
        audit.emailChange(req.userId, req.ip);
        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'That email is already in use' });
        console.error('CHANGE EMAIL ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /profile/password
 * Changes the logged-in user's password. Requires current password.
 * Body: { currentPassword, newPassword }
 */
router.patch('/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
    if (!newPassword)     return res.status(400).json({ error: 'New password is required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const userResult = await pool.query(
            `SELECT id, password_hash FROM users WHERE id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Incorrect current password' });

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            `UPDATE users
             SET password_hash = $1,
                 token_version = token_version + 1
             WHERE id = $2`,
            [hash, req.userId]
        );
        audit.passwordChange(req.userId, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('CHANGE PASSWORD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
