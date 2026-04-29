// backend/routes/projects.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();


/**
 * GET /projects/mine
 * Returns projects owned by the logged-in user,
 * ordered by most recent post activity.
 */
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT
                pr.id,
                pr.title,
                pr.description,
                pr.thumbnail_url,
                pr.created_at,
                pr.is_private,
                (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = pr.id)::int     AS member_count,
                (SELECT COUNT(*) FROM posts p WHERE p.project_id = pr.id
                   AND p.is_archived = FALSE)::int                                              AS post_count,
                (SELECT MAX(p.created_at) FROM posts p WHERE p.project_id = pr.id
                   AND p.is_archived = FALSE)                                                   AS last_post_at
             FROM projects pr
             WHERE pr.owner_profile_id = $1
               AND pr.is_archived = FALSE
             ORDER BY last_post_at DESC NULLS LAST, pr.created_at DESC`,
            [profileId]
        );
        res.json({ projects: result.rows });
    } catch (err) {
        console.error('MY PROJECTS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /projects/shared
 * Returns projects the logged-in user is a member of but does NOT own,
 * ordered by most recent post activity.
 */
router.get('/shared', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT
                pr.id,
                pr.title,
                pr.description,
                pr.thumbnail_url,
                pr.created_at,
                pr.is_private,
                p2.username         AS owner_username,
                p2.display_name     AS owner_display_name,
                p2.profile_picture_url AS owner_avatar,
                (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = pr.id)::int   AS member_count,
                (SELECT COUNT(*) FROM posts p WHERE p.project_id = pr.id
                   AND p.is_archived = FALSE)::int                                              AS post_count,
                (SELECT MAX(p.created_at) FROM posts p WHERE p.project_id = pr.id
                   AND p.is_archived = FALSE)                                                   AS last_post_at
             FROM project_members pm
             JOIN projects  pr ON pr.id  = pm.project_id
             JOIN profiles  p2 ON p2.id  = pr.owner_profile_id
             WHERE pm.profile_id        = $1
               AND pr.owner_profile_id != $1
               AND pr.is_archived       = FALSE
               AND p2.is_archived       = FALSE
             ORDER BY last_post_at DESC NULLS LAST, pr.created_at DESC`,
            [profileId]
        );
        res.json({ projects: result.rows });
    } catch (err) {
        console.error('SHARED PROJECTS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /projects
 * Creates a new project. Owner is automatically added as a member.
 * Body: { title, description?, is_private?, thumbnail_url?, member_profile_ids? }
 */
router.post('/', requireAuth, async (req, res) => {
    const { title, description, is_private = false, thumbnail_url, member_profile_ids = [] } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Create the project
            const projectResult = await client.query(
                `INSERT INTO projects (title, description, is_private, thumbnail_url, owner_profile_id)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, title, description, is_private, thumbnail_url, created_at`,
                [title.trim(), description?.trim() || null, is_private, thumbnail_url || null, profileId]
            );
            const project = projectResult.rows[0];

            // Add owner as member with role 'owner'
            await client.query(
                `INSERT INTO project_members (project_id, profile_id, role)
                 VALUES ($1, $2, 'owner')`,
                [project.id, profileId]
            );

            // Add any additional members with role 'editor'
            for (const memberId of member_profile_ids) {
                if (memberId !== profileId) {
                    await client.query(
                        `INSERT INTO project_members (project_id, profile_id, role)
                         VALUES ($1, $2, 'editor')
                         ON CONFLICT DO NOTHING`,
                        [project.id, memberId]
                    );
                }
            }

            await client.query('COMMIT');
            res.status(201).json({ project });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('CREATE PROJECT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /projects/:projectId/members
 * Returns all members of a project.
 */
router.get('/:projectId/members', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Verify membership
        const memberCheck = await pool.query(
            `SELECT 1 FROM project_members WHERE project_id = $1 AND profile_id = $2`,
            [projectId, profileId]
        );
        if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

        const result = await pool.query(
            `SELECT
                pm.profile_id,
                pm.role,
                pm.joined_at,
                pr.username,
                pr.display_name,
                pr.profile_picture_url
             FROM project_members pm
             JOIN profiles pr ON pr.id = pm.profile_id
             WHERE pm.project_id   = $1
               AND pr.is_archived  = FALSE
             ORDER BY pm.joined_at ASC`,
            [projectId]
        );
        res.json({ members: result.rows });
    } catch (err) {
        console.error('GET MEMBERS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /projects/:projectId/members
 * Adds a member to a project. Owner only.
 * Body: { profile_id }
 */
router.post('/:projectId/members', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const { profile_id } = req.body;
    if (!profile_id) return res.status(400).json({ error: 'profile_id is required' });

    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Only owner can add members
        const ownerCheck = await pool.query(
            `SELECT 1 FROM projects WHERE id = $1 AND owner_profile_id = $2 AND is_archived = FALSE`,
            [projectId, profileId]
        );
        if (ownerCheck.rows.length === 0) return res.status(403).json({ error: 'Only the owner can add members' });

        await pool.query(
            `INSERT INTO project_members (project_id, profile_id, role)
             VALUES ($1, $2, 'editor')
             ON CONFLICT DO NOTHING`,
            [projectId, profile_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('ADD MEMBER ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /projects/:projectId/members/:memberId
 * Removes a member from a project. Owner only.
 */
router.delete('/:projectId/members/:memberId', requireAuth, async (req, res) => {
    const { projectId, memberId } = req.params;
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const ownerCheck = await pool.query(
            `SELECT 1 FROM projects WHERE id = $1 AND owner_profile_id = $2 AND is_archived = FALSE`,
            [projectId, profileId]
        );
        if (ownerCheck.rows.length === 0) return res.status(403).json({ error: 'Only the owner can remove members' });

        // Cannot remove the owner themselves
        if (memberId === profileId) return res.status(400).json({ error: 'Cannot remove the project owner' });

        await pool.query(
            `DELETE FROM project_members WHERE project_id = $1 AND profile_id = $2`,
            [projectId, memberId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('REMOVE MEMBER ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /projects/membership
 * Returns all projects the user is a member of (for post creation project picker).
 */
router.get('/membership', requireAuth, async (req, res) => {
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        const result = await pool.query(
            `SELECT pr.id, pr.title, pr.thumbnail_url, pr.is_private
             FROM project_members pm
             JOIN projects pr ON pr.id = pm.project_id
             WHERE pm.profile_id  = $1
               AND pr.is_archived = FALSE
             ORDER BY pr.title ASC`,
            [profileId]
        );
        res.json({ projects: result.rows });
    } catch (err) {
        console.error('MEMBERSHIP ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /projects/:projectId
 * Deletes a project. Owner only.
 * Posts are kept as standalone profile posts (project_id set to NULL).
 * Hard deletes: links, assignments, canvas positions, members.
 * Archives the project itself.
 */
router.delete('/:projectId', requireAuth, async (req, res) => {
    const { projectId } = req.params;
    const client = await pool.connect();
    try {
        const meResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
            [req.userId]
        );
        if (meResult.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
        const profileId = meResult.rows[0].id;

        // Only owner can delete
        const ownerCheck = await pool.query(
            `SELECT id FROM projects WHERE id = $1 AND owner_profile_id = $2 AND is_archived = FALSE`,
            [projectId, profileId]
        );
        if (ownerCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Only the project owner can delete this project' });
        }

        await client.query('BEGIN');

        // 1. Hard delete all post_links between posts in this project
        await client.query(
            `DELETE FROM post_links
             WHERE from_post_id IN (SELECT id FROM posts WHERE project_id = $1)
                OR to_post_id   IN (SELECT id FROM posts WHERE project_id = $1)`,
            [projectId]
        );

        // 2. Hard delete all post_assignments for posts in this project
        await client.query(
            `DELETE FROM post_assignments
             WHERE post_id IN (SELECT id FROM posts WHERE project_id = $1)`,
            [projectId]
        );

        // 3. Hard delete all canvas positions for this project
        await client.query(
            `DELETE FROM post_canvas_positions WHERE project_id = $1`,
            [projectId]
        );

        // 4. Detach posts — set project_id and status to NULL so they
        //    become standalone profile posts
        await client.query(
            `UPDATE posts
             SET project_id = NULL, status = NULL
             WHERE project_id = $1`,
            [projectId]
        );

        // 5. Hard delete all project members
        await client.query(
            `DELETE FROM project_members WHERE project_id = $1`,
            [projectId]
        );

        // 6. Archive the project
        await client.query(
            `UPDATE projects SET is_archived = TRUE WHERE id = $1`,
            [projectId]
        );

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('DELETE PROJECT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

export default router;
