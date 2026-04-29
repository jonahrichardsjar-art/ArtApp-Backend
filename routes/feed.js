// backend/routes/feed.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import { sendPush } from './notifications.js';

const router = express.Router();


/**
 * GET /feed
 * Returns paginated feed posts.
 * Phase 1: posts from fandom (evenly distributed, newest first per profile)
 * Phase 2: popular posts not already shown
 *
 * Query params:
 *   - page  (default 1)
 *   - limit (default 10)
 *   - seen  (comma-separated post ids already seen, to exclude from popular)
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.max(1, parseInt(req.query.limit) || 10);
        const seenIds = req.query.seen
            ? String(req.query.seen).split(',').filter(Boolean)
            : [];

        // 1. Get the logged-in user's profile + fandom list
        const meResult = await pool.query(
            `SELECT id, list_of_fandoms
             FROM profiles
             WHERE user_id = $1
               AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const myProfileId = meResult.rows[0].id;
        const fandomIds   = meResult.rows[0].list_of_fandoms ?? [];

        // 2. Build fandom feed — one newest post per fandom profile, then paginate
        let fandomPosts = [];

        if (fandomIds.length > 0) {
            const fandomResult = await pool.query(
                `SELECT DISTINCT ON (p.author_profile_id)
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
                    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                    (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                       AND c.is_archived = FALSE)::int                                         AS comments_count,
                    (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                       AND pl.profile_id = $2)::int > 0                                       AS liked_by_me
                 FROM posts p
                 JOIN profiles pr ON pr.id = p.author_profile_id
                 WHERE p.author_profile_id = ANY($1::uuid[])
                   AND p.is_archived = FALSE
                   AND p.is_public   = TRUE
                   AND pr.is_archived = FALSE
                 ORDER BY p.author_profile_id, p.created_at DESC`,
                [fandomIds, myProfileId]
            );
            fandomPosts = fandomResult.rows;
        }

        // Paginate fandom posts
        const fandomOffset = (page - 1) * limit;
        const fandomPage   = fandomPosts.slice(fandomOffset, fandomOffset + limit);
        const fandomCount  = fandomPage.length;

        // 3. If we need more posts, fill remainder with popular posts
        let popularPosts = [];
        const needed = limit - fandomCount;

        if (needed > 0) {
            const excludeIds = [
                ...fandomPosts.map(p => p.id),
                ...seenIds,
            ];

            let popularQuery;
            let popularParams;

            if (excludeIds.length > 0) {
                popularQuery = `
                    SELECT
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
                        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                        (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                           AND c.is_archived = FALSE)::int                                         AS comments_count,
                        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                           AND pl.profile_id = $3)::int > 0                                       AS liked_by_me
                     FROM posts p
                     JOIN profiles pr ON pr.id = p.author_profile_id
                     WHERE p.is_archived = FALSE
                       AND p.is_public   = TRUE
                       AND pr.is_archived = FALSE
                       AND p.author_profile_id != $3
                       AND p.id != ALL($4::uuid[])
                     ORDER BY (
                         SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                     ) + (
                         SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.is_archived = FALSE
                     ) DESC, p.created_at DESC
                     LIMIT $1 OFFSET $2`;
                popularParams = [needed, 0, myProfileId, excludeIds];
            } else {
                popularQuery = `
                    SELECT
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
                        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                        (SELECT COUNT(*) FROM comments  c  WHERE c.post_id  = p.id
                           AND c.is_archived = FALSE)::int                                         AS comments_count,
                        (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                           AND pl.profile_id = $3)::int > 0                                       AS liked_by_me
                     FROM posts p
                     JOIN profiles pr ON pr.id = p.author_profile_id
                     WHERE p.is_archived = FALSE
                       AND p.is_public   = TRUE
                       AND pr.is_archived = FALSE
                       AND p.author_profile_id != $3
                     ORDER BY (
                         SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id
                     ) + (
                         SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.is_archived = FALSE
                     ) DESC, p.created_at DESC
                     LIMIT $1 OFFSET $2`;
                popularParams = [needed, 0, myProfileId];
            }

            const popularResult = await pool.query(popularQuery, popularParams);
            popularPosts = popularResult.rows;
        }

        const posts   = [...fandomPage, ...popularPosts];
        const hasMore = fandomCount === limit || popularPosts.length === needed;

        res.json({ posts, hasMore });
    } catch (err) {
        console.error('FEED ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /feed/like/:postId
 * Toggles like on a post. Returns { liked, likes_count }.
 */
router.post('/like/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Check if already liked
        const existing = await pool.query(
            `SELECT 1 FROM post_likes WHERE post_id = $1 AND profile_id = $2`,
            [postId, profileId]
        );

        let liked;
        if (existing.rows.length > 0) {
            await pool.query(
                `DELETE FROM post_likes WHERE post_id = $1 AND profile_id = $2`,
                [postId, profileId]
            );
            liked = false;
        } else {
            await pool.query(
                `INSERT INTO post_likes (post_id, profile_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [postId, profileId]
            );
            liked = true;
        }

        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1`,
            [postId]
        );

        // Fire notification if liked (not unliked) and not liking own post
        if (liked) {
            const postAuthor = await pool.query(
                `SELECT author_profile_id FROM posts WHERE id = $1`,
                [postId]
            );
            const authorId = postAuthor.rows[0]?.author_profile_id;
            if (authorId && authorId !== profileId) {
                await pool.query(
                    `INSERT INTO notifications
                        (recipient_profile_id, type, post_id, actor_profile_id)
                     VALUES ($1, 'like', $2, $3)
                     ON CONFLICT (recipient_profile_id, type, post_id, actor_profile_id) DO NOTHING`,
                    [authorId, postId, profileId]
                );
                // Get actor username for push message
                const actor = await pool.query(
                    `SELECT username, display_name FROM profiles WHERE id = $1`,
                    [profileId]
                );
                const name = actor.rows[0]?.display_name ?? actor.rows[0]?.username ?? 'Someone';
                sendPush(authorId, 'New Like', `${name} liked your post`, 'like');
            }
        }

        res.json({ liked, likes_count: countResult.rows[0].count });
    } catch (err) {
        console.error('LIKE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /feed/comments/:postId
 * Returns comments for a post, ordered by most liked first.
 */
router.get('/comments/:postId', requireAuth, async (req, res) => {
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
                c.id,
                c.content,
                c.created_at,
                c.author_profile_id,
                pr.username,
                pr.display_name,
                pr.profile_picture_url,
                (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id)::int   AS likes_count,
                (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id
                   AND cl.profile_id = $2)::int > 0                                        AS liked_by_me,
                (c.author_profile_id = $2)                                                 AS is_mine
             FROM comments c
             JOIN profiles pr ON pr.id = c.author_profile_id
             WHERE c.post_id = $1
               AND c.is_archived = FALSE
               AND pr.is_archived = FALSE
             ORDER BY likes_count DESC, c.created_at ASC`,
            [postId, profileId]
        );
        res.json({ comments: result.rows });
    } catch (err) {
        console.error('COMMENTS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /feed/comments/:postId
 * Adds a comment to a post.
 */
router.post('/comments/:postId', requireAuth, async (req, res) => {
    const { postId } = req.params;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `INSERT INTO comments (post_id, author_profile_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, content, created_at`,
            [postId, profileId, content.trim()]
        );

        // Fire notification — don't notify yourself
        const postAuthor = await pool.query(
            `SELECT author_profile_id FROM posts WHERE id = $1`,
            [postId]
        );
        const authorId = postAuthor.rows[0]?.author_profile_id;
        if (authorId && authorId !== profileId) {
            await pool.query(
                `INSERT INTO notifications
                    (recipient_profile_id, type, post_id, actor_profile_id)
                 VALUES ($1, 'comment', $2, $3)
                 ON CONFLICT (recipient_profile_id, type, post_id, actor_profile_id) DO NOTHING`,
                [authorId, postId, profileId]
            );
            const actor = await pool.query(
                `SELECT username, display_name FROM profiles WHERE id = $1`,
                [profileId]
            );
            const name    = actor.rows[0]?.display_name ?? actor.rows[0]?.username ?? 'Someone';
            const preview = content.trim().slice(0, 50) + (content.trim().length > 50 ? '…' : '');
            sendPush(authorId, 'New Comment', `${name}: ${preview}`, 'comment');
        }

        res.status(201).json({ comment: result.rows[0] });
    } catch (err) {
        console.error('ADD COMMENT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /feed/comments/:commentId
 * Soft-deletes (archives) a comment. Only the author can delete.
 */
router.delete('/comments/:commentId', requireAuth, async (req, res) => {
    const { commentId } = req.params;
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `UPDATE comments
             SET is_archived = TRUE
             WHERE id = $1
               AND author_profile_id = $2
               AND is_archived = FALSE
             RETURNING id`,
            [commentId, profileId]
        );
        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Comment not found or not yours' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE COMMENT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
