// backend/routes/discover.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();


/**
 * GET /discover/trending
 * Returns popular posts (most likes + comments) for the empty search state.
 */
router.get('/trending', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const myProfileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT
                p.id,
                p.caption,
                p.media_url,
                p.thumbnail_photo,
                p.video_url,
                p.media_type,
                p.created_at,
                p.author_profile_id,
                pr.username,
                pr.display_name,
                pr.profile_picture_url,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int        AS likes_count,
                (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                   AND c.is_archived = FALSE)::int                                        AS comments_count
             FROM posts p
             JOIN profiles pr ON pr.id = p.author_profile_id
             WHERE p.is_archived       = FALSE
               AND p.is_public         = TRUE
               AND pr.is_archived      = FALSE
               AND p.author_profile_id != $1
             ORDER BY (
                 SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
             ) + (
                 SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.is_archived = FALSE
             ) DESC, p.created_at DESC
             LIMIT 40`,
            [myProfileId]
        );
        res.json({ posts: result.rows });
    } catch (err) {
        console.error('TRENDING ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /discover/suggested-users?limit=10
 * Returns users the viewer doesn't fan yet, ordered by fan count.
 */
router.get('/suggested-users', requireAuth, async (req, res) => {
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    try {
        const meResult = await pool.query(
            `SELECT id, list_of_fandoms FROM profiles
             WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const myProfileId = meResult.rows[0].id;
        const fandomIds   = meResult.rows[0].list_of_fandoms ?? [];

        // Exclude self and already-fanned profiles
        const excluded = [myProfileId, ...fandomIds];

        const result = await pool.query(
            `SELECT
                p.id,
                p.username,
                p.display_name,
                p.profile_picture_url,
                p.bio,
                array_length(p.list_of_fans, 1) AS fans_count
             FROM profiles p
             WHERE p.is_archived = FALSE
               AND p.id != ALL($1::uuid[])
             ORDER BY array_length(p.list_of_fans, 1) DESC NULLS LAST,
                      p.created_at DESC
             LIMIT $2`,
            [excluded, limit]
        );
        res.json({ users: result.rows });
    } catch (err) {
        console.error('SUGGESTED USERS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Searches profiles by display_name or username.
 */

// Escape %, _, and \ so user input can't cause catastrophically slow LIKE queries
function escapeLike(s) {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

router.get('/users', requireAuth, async (req, res) => {
    const q     = String(req.query.q ?? '').trim().slice(0, 50); // max 50 chars
    const limit = Math.min(50, parseInt(req.query.limit) || 5);
    if (!q) return res.json({ users: [] });

    const safe = escapeLike(q);
    try {
        const result = await pool.query(
            `SELECT id, username, display_name, profile_picture_url
             FROM profiles
             WHERE is_archived = FALSE
               AND (
                   display_name ILIKE $1 ESCAPE '\\'
                   OR username   ILIKE $1 ESCAPE '\\'
               )
             ORDER BY
                 CASE WHEN display_name ILIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END,
                 display_name ASC
             LIMIT $3`,
            [`%${safe}%`, `${safe}%`, limit]
        );
        res.json({ users: result.rows });
    } catch (err) {
        console.error('USER SEARCH ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /discover/posts?q=query&limit=20&offset=0
 * Searches posts by tags array OR caption text.
 */
router.get('/posts', requireAuth, async (req, res) => {
    const q      = String(req.query.q ?? '').trim().slice(0, 100); // max 100 chars
    const limit  = Math.min(50, parseInt(req.query.limit)  || 20);
    const offset = Math.max(0,  parseInt(req.query.offset) || 0);
    if (!q) return res.json({ posts: [] });

    const safe = escapeLike(q);
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        const myProfileId = meResult.rows[0]?.id ?? null;

        const result = await pool.query(
            `SELECT
                p.id,
                p.caption,
                p.media_url,
                p.thumbnail_photo,
                p.video_url,
                p.media_type,
                p.created_at,
                p.author_profile_id,
                pr.username,
                pr.display_name,
                pr.profile_picture_url,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int   AS likes_count,
                (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                   AND c.is_archived = FALSE)::int                                   AS comments_count
             FROM posts p
             JOIN profiles pr ON pr.id = p.author_profile_id
             WHERE p.is_archived       = FALSE
               AND p.is_public         = TRUE
               AND pr.is_archived      = FALSE
               AND p.author_profile_id != $3
               AND (
                   p.caption ILIKE $1 ESCAPE '\\'
                   OR EXISTS (
                       SELECT 1 FROM unnest(p.tags) AS tag
                       WHERE tag ILIKE $2 ESCAPE '\\'
                   )
               )
             ORDER BY (
                 SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
             ) + (
                 SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.is_archived = FALSE
             ) DESC, p.created_at DESC
             LIMIT $4 OFFSET $5`,
            [`%${safe}%`, `%${safe}%`, myProfileId, limit, offset]
        );
        res.json({ posts: result.rows });
    } catch (err) {
        console.error('POST SEARCH ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /discover/projects?q=query&limit=20&offset=0
 * Searches projects by title, description, or tags on their posts.
 */
router.get('/projects', requireAuth, async (req, res) => {
    const q      = String(req.query.q ?? '').trim();
    const limit  = Math.min(50, parseInt(req.query.limit)  || 20);
    const offset = Math.max(0,  parseInt(req.query.offset) || 0);
    if (!q) return res.json({ projects: [] });

    try {
        const result = await pool.query(
            `SELECT DISTINCT
                pr.id,
                pr.title,
                pr.description,
                pr.thumbnail_url,
                pr.created_at,
                pr.owner_profile_id,
                p2.username        AS owner_username,
                p2.display_name    AS owner_display_name,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = pr.id)::int AS member_count
             FROM projects pr
             JOIN profiles p2 ON p2.id = pr.owner_profile_id
             LEFT JOIN posts po ON po.project_id = pr.id AND po.is_archived = FALSE
             WHERE pr.is_archived  = FALSE
               AND p2.is_archived  = FALSE
               AND (
                   pr.title       ILIKE $1
                   OR pr.description ILIKE $1
                   OR po.caption  ILIKE $1
                   OR EXISTS (
                       SELECT 1 FROM unnest(po.tags) AS tag
                       WHERE tag ILIKE $2
                   )
               )
             ORDER BY pr.created_at DESC
             LIMIT $3 OFFSET $4`,
            [`%${q}%`, `%${q}%`, limit, offset]
        );
        res.json({ projects: result.rows });
    } catch (err) {
        console.error('PROJECT SEARCH ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
