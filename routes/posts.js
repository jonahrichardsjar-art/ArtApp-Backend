// backend/routes/posts.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();


/**
 * POST /posts
 * Creates a new post. Optionally attached to a project.
 * Body: { caption?, media_url?, thumbnail_photo?, video_url?, media_type?, tags?, project_id?, is_public? }
 */
router.post('/', requireAuth, async (req, res) => {
    const {
        caption, media_url, thumbnail_photo, video_url,
        media_type = 'image', tags = [], project_id, is_public = true,
    } = req.body;

    if (!caption?.trim() && !media_url && !thumbnail_photo && !video_url) {
        return res.status(400).json({ error: 'A caption or media is required' });
    }
    if (caption    && (typeof caption !== 'string' || caption.length > 2000))     return res.status(400).json({ error: 'Caption too long (max 2000 characters)' });
    if (!Array.isArray(tags) || tags.length > 20)                                  return res.status(400).json({ error: 'Too many tags (max 20)' });
    if (tags.some(t => typeof t !== 'string' || t.length > 50))                   return res.status(400).json({ error: 'Tag too long (max 50 characters each)' });
    if (media_type && !['image', 'video'].includes(media_type))                   return res.status(400).json({ error: 'media_type must be "image" or "video"' });

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // If project_id provided, verify membership
        if (project_id) {
            const memberCheck = await pool.query(
                `SELECT 1 FROM project_members WHERE project_id = $1 AND profile_id = $2`,
                [project_id, profileId]
            );
            if (memberCheck.rows.length === 0) {
                return res.status(403).json({ error: 'You are not a member of that project' });
            }
        }

        const result = await pool.query(
            `INSERT INTO posts
                (project_id, author_profile_id, caption, media_url, thumbnail_photo, video_url, media_type, tags, status, is_public)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, caption, media_url, thumbnail_photo, video_url, media_type, tags, is_public, created_at`,
            [
                project_id      || null,
                profileId,
                caption?.trim() || null,
                media_url       || null,
                thumbnail_photo || null,
                video_url       || null,
                media_type,
                tags,
                project_id ? 'red' : null,
                is_public,
            ]
        );

        const post = result.rows[0];

        // If attached to a project, create a canvas position entry
        if (project_id) {
            await pool.query(
                `INSERT INTO post_canvas_positions (post_id, project_id, canvas_x, canvas_y)
                 VALUES ($1, $2, 100, 100)
                 ON CONFLICT DO NOTHING`,
                [post.id, project_id]
            );
        }

        res.status(201).json({ post });
    } catch (err) {
        console.error('CREATE POST ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /posts/:postId
 * Returns a single post with full details and like status for the viewer.
 */
router.get('/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT
                p.id,
                p.caption,
                p.media_url,
                p.thumbnail_photo,
                p.video_url,
                p.media_type,
                p.tags,
                p.is_public,
                p.created_at,
                p.author_profile_id,
                pr.username            AS author_username,
                pr.display_name        AS author_display_name,
                pr.profile_picture_url AS author_avatar,
                pj.id                  AS project_id,
                pj.title               AS project_title,
                pj.thumbnail_url       AS project_thumbnail,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                   AND c.is_archived = FALSE)::int                                          AS comments_count,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                   AND pl.profile_id = $2)::int > 0                                        AS liked_by_me
             FROM posts p
             JOIN profiles pr ON pr.id = p.author_profile_id
             LEFT JOIN projects pj ON pj.id = p.project_id AND pj.is_archived = FALSE
             WHERE p.id           = $1
               AND p.is_archived  = FALSE
               AND pr.is_archived = FALSE`,
            [postId, profileId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error('GET POST ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /posts/:postId
 * Archives a post and hard-deletes all related data.
 * Only the post author can delete their own post.
 */
router.delete('/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const client = await pool.connect();
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Verify the post exists and belongs to this user
        const postCheck = await pool.query(
            `SELECT id FROM posts WHERE id = $1 AND author_profile_id = $2 AND is_archived = FALSE`,
            [postId, profileId]
        );
        if (postCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Post not found or not yours to delete' });
        }

        await client.query('BEGIN');

        // Hard delete links, assignments, canvas position
        await client.query(
            `DELETE FROM post_links WHERE from_post_id = $1 OR to_post_id = $1`,
            [postId]
        );
        await client.query(
            `DELETE FROM post_assignments WHERE post_id = $1`,
            [postId]
        );
        await client.query(
            `DELETE FROM post_canvas_positions WHERE post_id = $1`,
            [postId]
        );

        // Hard delete comment likes, then comments, then post likes
        await client.query(
            `DELETE FROM comment_likes
             WHERE comment_id IN (SELECT id FROM comments WHERE post_id = $1)`,
            [postId]
        );
        await client.query(`DELETE FROM comments  WHERE post_id = $1`, [postId]);
        await client.query(`DELETE FROM post_likes WHERE post_id = $1`, [postId]);

        // Archive the post
        await client.query(
            `UPDATE posts SET is_archived = TRUE WHERE id = $1`,
            [postId]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE POST ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

/**
 * PATCH /posts/:postId
 * Edits a post's caption, tags, media, video, and/or visibility.
 * Author only.
 * Body: { caption?, tags?, media_url?, thumbnail_photo?, video_url?, media_type?, is_public? }
 */
router.patch('/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const { caption, tags, media_url, thumbnail_photo, video_url, media_type, is_public } = req.body;

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Verify author
        const postCheck = await pool.query(
            `SELECT id FROM posts WHERE id = $1 AND author_profile_id = $2 AND is_archived = FALSE`,
            [postId, profileId]
        );
        if (postCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Post not found or not yours to edit' });
        }

        // Build update dynamically — only update fields that were provided
        const updates = [];
        const values  = [];
        let   idx     = 1;

        if (caption !== undefined) {
            updates.push(`caption = $${idx++}`);
            values.push(caption?.trim() || null);
        }
        if (tags !== undefined) {
            updates.push(`tags = $${idx++}`);
            values.push(tags);
        }
        if (media_url !== undefined) {
            updates.push(`media_url = $${idx++}`);
            values.push(media_url || null);
        }
        if (thumbnail_photo !== undefined) {
            updates.push(`thumbnail_photo = $${idx++}`);
            values.push(thumbnail_photo || null);
        }
        if (video_url !== undefined) {
            updates.push(`video_url = $${idx++}`);
            values.push(video_url || null);
        }
        if (media_type !== undefined) {
            if (!['image', 'video'].includes(media_type)) {
                return res.status(400).json({ error: 'media_type must be "image" or "video"' });
            }
            updates.push(`media_type = $${idx++}`);
            values.push(media_type);
        }
        if (is_public !== undefined) {
            updates.push(`is_public = $${idx++}`);
            values.push(is_public);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(postId);
        const result = await pool.query(
            `UPDATE posts SET ${updates.join(', ')} WHERE id = $${idx}
             RETURNING id, caption, tags, media_url, thumbnail_photo, video_url, media_type, is_public`,
            values
        );

        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error('EDIT POST ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
