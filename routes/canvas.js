// backend/routes/canvas.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import { getIO } from '../socket.js';
import { recalcStatus, cascadeGreen } from '../canvasUtils.js';

const router = express.Router();
const VALID_STATUSES = ['red', 'purple', 'blue', 'green'];

// ─── Broadcast helper ─────────────────────────────────────────────────────────
function broadcast(projectId, event, data) {
    getIO().to(`project:${projectId}`).emit(event, data);
}

// ─── Check project membership ─────────────────────────────────────────────────
async function getProfileAndMembership(userId, projectId) {
    const profileResult = await pool.query(
        `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
        [userId]
    );
    if (profileResult.rows.length === 0) return { error: 'Profile not found', status: 404 };
    const profileId = profileResult.rows[0].id;

    const memberResult = await pool.query(
        `SELECT role FROM project_members WHERE project_id = $1 AND profile_id = $2`,
        [projectId, profileId]
    );
    if (memberResult.rows.length === 0) return { error: 'Not a project member', status: 403 };

    const projectResult = await pool.query(
        `SELECT owner_profile_id FROM projects WHERE id = $1 AND is_archived = FALSE`,
        [projectId]
    );
    if (projectResult.rows.length === 0) return { error: 'Project not found', status: 404 };
    const isOwner = projectResult.rows[0].owner_profile_id === profileId;

    return { profileId, isOwner };
}

/**
 * GET /canvas/:projectId
 */
router.get('/:projectId', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    try {
        const { profileId, isOwner, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const projectResult = await pool.query(
            `SELECT id, title, description, is_private, owner_profile_id
             FROM projects WHERE id = $1 AND is_archived = FALSE`,
            [projectId]
        );
        if (projectResult.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

        const postsResult = await pool.query(
            `SELECT
                p.id,
                p.caption,
                p.media_url,
                p.thumbnail_photo,
                p.video_url,
                p.media_type,
                p.status,
                p.created_at,
                p.author_profile_id,
                pr.username            AS author_username,
                pr.display_name        AS author_display_name,
                pr.profile_picture_url AS author_avatar,
                COALESCE(cp.canvas_x, 0) AS canvas_x,
                COALESCE(cp.canvas_y, 0) AS canvas_y,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id)::int         AS likes_count,
                (SELECT COUNT(*) FROM comments c  WHERE c.post_id  = p.id
                   AND c.is_archived = FALSE)::int                                          AS comments_count,
                (SELECT json_agg(json_build_object(
                    'profile_id',   pa.profile_id,
                    'username',     apr.username,
                    'display_name', apr.display_name,
                    'avatar',       apr.profile_picture_url
                ))
                 FROM post_assignments pa
                 JOIN profiles apr ON apr.id = pa.profile_id
                 WHERE pa.post_id = p.id)                                                   AS assignments
             FROM posts p
             JOIN profiles pr ON pr.id = p.author_profile_id
             LEFT JOIN post_canvas_positions cp ON cp.post_id = p.id
             WHERE p.project_id   = $1
               AND p.is_archived  = FALSE
               AND pr.is_archived = FALSE
             ORDER BY p.created_at ASC`,
            [projectId]
        );

        const linksResult = await pool.query(
            `SELECT pl.from_post_id, pl.to_post_id, pl.relationship_type
             FROM post_links pl
             JOIN posts p1 ON p1.id = pl.from_post_id
             JOIN posts p2 ON p2.id = pl.to_post_id
             WHERE p1.project_id  = $1
               AND p2.project_id  = $1
               AND p1.is_archived = FALSE
               AND p2.is_archived = FALSE`,
            [projectId]
        );

        res.json({
            project:        projectResult.rows[0],
            isOwner,
            viewerProfileId: profileId,
            nodes:           postsResult.rows,
            links:           linksResult.rows,
        });
    } catch (err) {
        console.error('CANVAS GET ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /canvas/:projectId/nodes
 * Broadcasts: canvas:node_added
 */
router.post('/:projectId/nodes', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { caption, canvas_x = 0, canvas_y = 0, media_url, thumbnail_photo, tags = [] } = req.body;
    if (!caption?.trim() && !media_url && !thumbnail_photo) {
        return res.status(400).json({ error: 'Caption or media is required' });
    }

    try {
        const { profileId, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const postResult = await client.query(
                `INSERT INTO posts (project_id, author_profile_id, caption, status, media_url, thumbnail_photo, tags)
                 VALUES ($1, $2, $3, 'red', $4, $5, $6)
                 RETURNING id, caption, status, media_url, thumbnail_photo, tags, created_at`,
                [projectId, profileId, caption?.trim() || null, media_url || null, thumbnail_photo || null, tags]
            );
            const post = postResult.rows[0];
            await client.query(
                `INSERT INTO post_canvas_positions (post_id, project_id, canvas_x, canvas_y)
                 VALUES ($1, $2, $3, $4)`,
                [post.id, projectId, canvas_x, canvas_y]
            );
            await client.query('COMMIT');

            // Fetch author info for broadcast
            const authorResult = await pool.query(
                `SELECT username, display_name, profile_picture_url AS author_avatar
                 FROM profiles WHERE id = $1`,
                [profileId]
            );
            const author = authorResult.rows[0];

            const node = {
                ...post,
                canvas_x,
                canvas_y,
                assignments:         [],
                likes_count:         0,
                comments_count:      0,
                author_profile_id:   profileId,
                author_username:     author.username,
                author_display_name: author.display_name,
                author_avatar:       author.author_avatar,
            };

            res.status(201).json({ node });
            broadcast(projectId, 'canvas:node_added', { projectId, node });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('CREATE NODE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /canvas/:projectId/nodes/:postId/position
 * Broadcasts: canvas:node_moved
 */
router.patch('/:projectId/nodes/:postId/position', requireAuth, async (req, res) => {
    const { projectId, postId } = req.params;
    const { canvas_x, canvas_y } = req.body;
    if (canvas_x === undefined || canvas_y === undefined) {
        return res.status(400).json({ error: 'canvas_x and canvas_y are required' });
    }
    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        await pool.query(
            `INSERT INTO post_canvas_positions (post_id, project_id, canvas_x, canvas_y, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (post_id)
             DO UPDATE SET canvas_x = $3, canvas_y = $4, updated_at = now()`,
            [postId, projectId, canvas_x, canvas_y]
        );

        res.json({ success: true });
        broadcast(projectId, 'canvas:node_moved', { projectId, postId, canvas_x, canvas_y });
    } catch (err) {
        console.error('POSITION UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
/**
 * PATCH /canvas/:projectId/nodes/:postId/status
 * Broadcasts: canvas:node_status
 * Only assigned members can change status manually (blue only — green is auto via file upload).
 */
router.patch('/:projectId/nodes/:postId/status', requireAuth, async (req, res) => {
    const { projectId, postId } = req.params;
    const { status } = req.body;

    // Orange removed — only blue is manually settable now
    // Red and purple are set automatically by assign/unassign
    // Green is set automatically by file upload
    const MANUAL_STATUSES = ['blue'];
    if (!MANUAL_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Only blue (Unfinished Parts) can be set manually.' });
    }

    try {
        const { profileId, error, status: statusCode } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(statusCode).json({ error });

        // Only assigned members can change status
        const assignedResult = await pool.query(
            `SELECT 1 FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
            [postId, profileId]
        );
        if (assignedResult.rows.length === 0) {
            return res.status(403).json({ error: 'Only assigned members can change the status' });
        }

        await pool.query(
            `UPDATE posts SET status = $1 WHERE id = $2 AND is_archived = FALSE`,
            [status, postId]
        );

        res.json({ status });
        broadcast(projectId, 'canvas:node_status', { projectId, postId, status });
    } catch (err) {
        console.error('STATUS UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /canvas/:projectId/nodes/:postId/media
 * Broadcasts: canvas:node_media
 */
router.patch('/:projectId/nodes/:postId/media', requireAuth, async (req, res) => {
    const { projectId, postId } = req.params;
    const { media_url } = req.body;
    if (!media_url?.trim()) return res.status(400).json({ error: 'media_url is required' });

    try {
        const { profileId, isOwner, error, statusCode } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(statusCode).json({ error });

        if (!isOwner) {
            const assignedResult = await pool.query(
                `SELECT 1 FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
                [postId, profileId]
            );
            if (assignedResult.rows.length === 0) {
                return res.status(403).json({ error: 'Only assigned members can add media' });
            }
        }

        await pool.query(
            `UPDATE posts SET media_url = $1 WHERE id = $2 AND is_archived = FALSE`,
            [media_url.trim(), postId]
        );

        res.json({ success: true });
        broadcast(projectId, 'canvas:node_media', { projectId, postId, media_url: media_url.trim() });
    } catch (err) {
        console.error('MEDIA UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /canvas/:projectId/nodes/:postId/assign
 * Toggles assignment for the current user.
 * Broadcasts: canvas:node_assigned
 */
router.post('/:projectId/nodes/:postId/assign', requireAuth, async (req, res) => {
    const { projectId, postId } = req.params;
    try {
        const { profileId, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const existing = await pool.query(
            `SELECT 1 FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
            [postId, profileId]
        );

        let assigned;
        if (existing.rows.length > 0) {
            // Unassign self
            await pool.query(
                `DELETE FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
                [postId, profileId]
            );
            assigned = false;
        } else {
            // Assign self
            await pool.query(
                `INSERT INTO post_assignments (post_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [postId, profileId]
            );
            assigned = true;
        }

        const newStatus = await recalcStatus(postId);

        const assignmentsResult = await pool.query(
            `SELECT pa.profile_id, pr.username, pr.display_name, pr.profile_picture_url AS avatar
             FROM post_assignments pa
             JOIN profiles pr ON pr.id = pa.profile_id
             WHERE pa.post_id = $1`,
            [postId]
        );

        const payload = { assigned, assignments: assignmentsResult.rows, status: newStatus };
        res.json(payload);
        broadcast(projectId, 'canvas:node_assigned', { projectId, postId, ...payload });
    } catch (err) {
        console.error('ASSIGN ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /canvas/:projectId/nodes/:postId/assign/:profileId
 * Owner-only: unassigns a specific member from a node.
 * Broadcasts: canvas:node_assigned
 */
router.delete('/:projectId/nodes/:postId/assign/:targetProfileId', requireAuth, async (req, res) => {
    const { projectId, postId, targetProfileId } = req.params;
    try {
        const { isOwner, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });
        if (!isOwner) return res.status(403).json({ error: 'Only the project owner can unassign others' });

        await pool.query(
            `DELETE FROM post_assignments WHERE post_id = $1 AND profile_id = $2`,
            [postId, targetProfileId]
        );

        const newStatus = await recalcStatus(postId);

        const assignmentsResult = await pool.query(
            `SELECT pa.profile_id, pr.username, pr.display_name, pr.profile_picture_url AS avatar
             FROM post_assignments pa
             JOIN profiles pr ON pr.id = pa.profile_id
             WHERE pa.post_id = $1`,
            [postId]
        );

        const payload = { assigned: false, assignments: assignmentsResult.rows, status: newStatus };
        res.json(payload);
        broadcast(projectId, 'canvas:node_assigned', { projectId, postId, ...payload });
    } catch (err) {
        console.error('OWNER UNASSIGN ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /canvas/:projectId/links
 * Broadcasts: canvas:link_added
 */
router.post('/:projectId/links', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { from_post_id, to_post_id } = req.body;
    if (!from_post_id || !to_post_id)    return res.status(400).json({ error: 'from_post_id and to_post_id are required' });
    if (from_post_id === to_post_id)     return res.status(400).json({ error: 'A post cannot link to itself' });

    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const verifyResult = await pool.query(
            `SELECT id FROM posts WHERE id = ANY($1::uuid[]) AND project_id = $2 AND is_archived = FALSE`,
            [[from_post_id, to_post_id], projectId]
        );
        if (verifyResult.rows.length !== 2) {
            return res.status(400).json({ error: 'Both posts must belong to this project' });
        }

        await pool.query(
            `INSERT INTO post_links (from_post_id, to_post_id, relationship_type)
             VALUES ($1, $2, 'requires') ON CONFLICT DO NOTHING`,
            [from_post_id, to_post_id]
        );

        res.status(201).json({ success: true });
        broadcast(projectId, 'canvas:link_added', { projectId, from_post_id, to_post_id });
    } catch (err) {
        console.error('CREATE LINK ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /canvas/:projectId/links
 * Broadcasts: canvas:link_removed
 */
router.delete('/:projectId/links', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { from_post_id, to_post_id } = req.body;

    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        await pool.query(
            `DELETE FROM post_links WHERE from_post_id = $1 AND to_post_id = $2`,
            [from_post_id, to_post_id]
        );

        res.json({ success: true });
        broadcast(projectId, 'canvas:link_removed', { projectId, from_post_id, to_post_id });
    } catch (err) {
        console.error('DELETE LINK ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /canvas/:projectId/nodes/:postId
 * Cleans up all related data in a transaction and archives the post.
 * Owner only. Broadcasts to all project members via WebSocket.
 */
router.delete('/:projectId/nodes/:postId', requireAuth, async (req, res) => {
    const { projectId, postId } = req.params;
    const client = await pool.connect();
    try {
        const { isOwner, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });
        if (!isOwner) return res.status(403).json({ error: 'Only the project owner can delete nodes' });

        // Verify post belongs to this project
        const postCheck = await pool.query(
            `SELECT id FROM posts WHERE id = $1 AND project_id = $2`,
            [postId, projectId]
        );
        if (postCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Node not found in this project' });
        }

        await client.query('BEGIN');

        // 1. Hard delete all arrows connected to this post
        await client.query(
            `DELETE FROM post_links WHERE from_post_id = $1 OR to_post_id = $1`,
            [postId]
        );

        // 2. Hard delete all assignments
        await client.query(
            `DELETE FROM post_assignments WHERE post_id = $1`,
            [postId]
        );

        // 3. Hard delete canvas position
        await client.query(
            `DELETE FROM post_canvas_positions WHERE post_id = $1`,
            [postId]
        );

        // 4. Hard delete likes on comments, then comments, then post likes
        await client.query(
            `DELETE FROM comment_likes
             WHERE comment_id IN (SELECT id FROM comments WHERE post_id = $1)`,
            [postId]
        );
        await client.query(
            `DELETE FROM comments WHERE post_id = $1`,
            [postId]
        );
        await client.query(
            `DELETE FROM post_likes WHERE post_id = $1`,
            [postId]
        );

        // 5. Archive the post so it disappears from profile and everywhere else
        await client.query(
            `UPDATE posts SET is_archived = TRUE WHERE id = $1`,
            [postId]
        );

        await client.query('COMMIT');

        res.json({ success: true });
        broadcast(projectId, 'canvas:node_deleted', { projectId, postId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE NODE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

// ─── Drawing: Strokes ─────────────────────────────────────────────────────────

/**
 * GET /canvas/:projectId/drawing
 * Returns all strokes and media items for the canvas.
 */
router.get('/:projectId/drawing', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const [strokesResult, mediaResult] = await Promise.all([
            pool.query(
                `SELECT id, points, color, stroke_width, created_at
                 FROM canvas_strokes
                 WHERE project_id = $1
                 ORDER BY created_at ASC`,
                [projectId]
            ),
            pool.query(
                `SELECT id, image_url, canvas_x, canvas_y, width, height, aspect_ratio, created_at
                 FROM canvas_media_items
                 WHERE project_id = $1
                 ORDER BY created_at ASC`,
                [projectId]
            ),
        ]);

        res.json({ strokes: strokesResult.rows, mediaItems: mediaResult.rows });
    } catch (err) {
        console.error('DRAWING LOAD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /canvas/:projectId/strokes
 * Saves a completed stroke.
 * Body: { points, color, stroke_width }
 */

const MAX_STROKE_POINTS  = 2000; // ~20 seconds of drawing at 100 points/sec
const MAX_STROKE_WIDTH   = 100;
const CANVAS_COORD_LIMIT = 100000; // sanity bound on canvas coordinates
const HEX_COLOR_RE       = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

router.post('/:projectId/strokes', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { points, color, stroke_width } = req.body;

    if (!Array.isArray(points) || points.length < 2) {
        return res.status(400).json({ error: 'At least 2 points required' });
    }
    if (points.length > MAX_STROKE_POINTS) {
        return res.status(400).json({ error: `Too many points (max ${MAX_STROKE_POINTS})` });
    }
    // Validate every point is a finite number within canvas bounds
    for (const pt of points) {
        if (
            typeof pt !== 'object' || pt === null ||
            typeof pt.x !== 'number' || !isFinite(pt.x) ||
            typeof pt.y !== 'number' || !isFinite(pt.y) ||
            Math.abs(pt.x) > CANVAS_COORD_LIMIT ||
            Math.abs(pt.y) > CANVAS_COORD_LIMIT
        ) {
            return res.status(400).json({ error: 'Invalid point data' });
        }
    }
    // Validate color is a hex string
    const safeColor = (typeof color === 'string' && HEX_COLOR_RE.test(color))
        ? color : '#000000';
    // Validate stroke width
    const safeWidth = Math.min(
        MAX_STROKE_WIDTH,
        Math.max(1, typeof stroke_width === 'number' && isFinite(stroke_width) ? stroke_width : 4)
    );

    try {
        const { profileId, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const result = await pool.query(
            `INSERT INTO canvas_strokes (project_id, drawer_profile_id, points, color, stroke_width)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, points, color, stroke_width, created_at`,
            [projectId, profileId, JSON.stringify(points), safeColor, safeWidth]
        );

        const stroke = result.rows[0];
        res.status(201).json({ stroke });
        broadcast(projectId, 'canvas:stroke_added', { projectId, stroke });
    } catch (err) {
        console.error('STROKE ADD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /canvas/:projectId/strokes
 * Deletes multiple strokes (eraser).
 * Body: { strokeIds: string[] }
 */
router.delete('/:projectId/strokes', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { strokeIds } = req.body;

    if (!Array.isArray(strokeIds) || strokeIds.length === 0) {
        return res.status(400).json({ error: 'strokeIds array required' });
    }

    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        await pool.query(
            `DELETE FROM canvas_strokes WHERE id = ANY($1::uuid[]) AND project_id = $2`,
            [strokeIds, projectId]
        );

        res.json({ success: true });
        broadcast(projectId, 'canvas:strokes_erased', { projectId, strokeIds });
    } catch (err) {
        console.error('STROKE DELETE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Drawing: Media Items ─────────────────────────────────────────────────────

/**
 * POST /canvas/:projectId/media-items
 * Adds an image/GIF to the canvas.
 * Body: { image_url, canvas_x, canvas_y, width, height, aspect_ratio }
 */
router.post('/:projectId/media-items', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { image_url, canvas_x = 0, canvas_y = 0, width = 200, height = 200, aspect_ratio = 1 } = req.body;

    if (!image_url) return res.status(400).json({ error: 'image_url required' });

    try {
        const { profileId, error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const result = await pool.query(
            `INSERT INTO canvas_media_items
                (project_id, uploader_profile_id, image_url, canvas_x, canvas_y, width, height, aspect_ratio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, image_url, canvas_x, canvas_y, width, height, aspect_ratio, created_at`,
            [projectId, profileId, image_url, canvas_x, canvas_y, width, height, aspect_ratio]
        );

        const item = result.rows[0];
        res.status(201).json({ item });
        broadcast(projectId, 'canvas:media_item_added', { projectId, item });
    } catch (err) {
        console.error('MEDIA ITEM ADD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /canvas/:projectId/media-items/:itemId
 * Updates position and size of a canvas media item.
 * Body: { canvas_x, canvas_y, width, height }
 */
router.patch('/:projectId/media-items/:itemId', requireAuth, async (req, res) => {
    const { projectId, itemId } = req.params;
    const { canvas_x, canvas_y, width, height } = req.body;

    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        const result = await pool.query(
            `UPDATE canvas_media_items
             SET canvas_x = $1, canvas_y = $2, width = $3, height = $4
             WHERE id = $5 AND project_id = $6
             RETURNING id, canvas_x, canvas_y, width, height`,
            [canvas_x, canvas_y, width, height, itemId, projectId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Media item not found' });

        const item = result.rows[0];
        res.json({ item });
        broadcast(projectId, 'canvas:media_item_updated', { projectId, itemId, ...item });
    } catch (err) {
        console.error('MEDIA ITEM UPDATE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /canvas/:projectId/media-items/:itemId
 * Removes a media item from the canvas.
 */
router.delete('/:projectId/media-items/:itemId', requireAuth, async (req, res) => {
    const { projectId, itemId } = req.params;

    try {
        const { error, status } = await getProfileAndMembership(req.userId, projectId);
        if (error) return res.status(status).json({ error });

        await pool.query(
            `DELETE FROM canvas_media_items WHERE id = $1 AND project_id = $2`,
            [itemId, projectId]
        );

        res.json({ success: true });
        broadcast(projectId, 'canvas:media_item_deleted', { projectId, itemId });
    } catch (err) {
        console.error('MEDIA ITEM DELETE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
