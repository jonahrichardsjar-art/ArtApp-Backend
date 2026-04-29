// backend/canvasUtils.js
// Shared helpers for canvas status calculation and cascade.
// Kept separate to avoid circular imports between canvas.js and files.js.

import pool from './db.js';
import { getIO } from './socket.js';

/**
 * Recalculates and saves the status of a single node based on
 * its assignments and uploaded files.
 */
export async function recalcStatus(postId) {
    const assignCount = await pool.query(
        `SELECT COUNT(*) AS count FROM post_assignments WHERE post_id = $1`,
        [postId]
    );
    const fileCount = await pool.query(
        `SELECT COUNT(*) AS count FROM post_files WHERE post_id = $1`,
        [postId]
    );
    const hasAssignments = parseInt(assignCount.rows[0].count) > 0;
    const hasFile        = parseInt(fileCount.rows[0].count)  > 0;

    let newStatus;
    if (!hasAssignments && !hasFile) {
        newStatus = 'red';
    } else if (hasAssignments && !hasFile) {
        newStatus = 'purple';
    } else if (hasFile) {
        const deps = await pool.query(
            `SELECT p.status FROM post_links pl
             JOIN posts p ON p.id = pl.from_post_id
             WHERE pl.to_post_id = $1 AND p.is_archived = FALSE`,
            [postId]
        );
        const allDepsGreen = deps.rows.length === 0 || deps.rows.every(r => r.status === 'green');
        newStatus = allDepsGreen ? 'green' : 'blue';
    }

    await pool.query(
        `UPDATE posts SET status = $1 WHERE id = $2`,
        [newStatus, postId]
    );
    return newStatus;
}

/**
 * Recursively cascades green status to downstream nodes.
 * When a node becomes green, all nodes it points to are re-evaluated.
 * If they have files and all their dependencies are now green,
 * they become green too and the cascade continues.
 * Broadcasts each change via WebSocket.
 */
export async function cascadeGreen(postId, projectId, visited = new Set()) {
    if (visited.has(postId)) return;
    visited.add(postId);

    // Find all nodes this node points TO
    const downstream = await pool.query(
        `SELECT pl.to_post_id
         FROM post_links pl
         JOIN posts p ON p.id = pl.to_post_id
         WHERE pl.from_post_id = $1
           AND p.is_archived = FALSE
           AND p.project_id  = $2`,
        [postId, projectId]
    );

    for (const row of downstream.rows) {
        const downId = row.to_post_id;

        // Only re-evaluate blue nodes (have file but blocked by deps)
        const fileCount = await pool.query(
            `SELECT COUNT(*) AS count FROM post_files WHERE post_id = $1`,
            [downId]
        );
        if (parseInt(fileCount.rows[0].count) === 0) continue;

        // Check if ALL dependencies of this downstream node are green
        const deps = await pool.query(
            `SELECT p.status FROM post_links pl
             JOIN posts p ON p.id = pl.from_post_id
             WHERE pl.to_post_id = $1 AND p.is_archived = FALSE`,
            [downId]
        );
        const allGreen = deps.rows.every(r => r.status === 'green');
        if (!allGreen) continue;

        // Update to green
        await pool.query(
            `UPDATE posts SET status = 'green' WHERE id = $1`,
            [downId]
        );

        // Broadcast immediately
        try {
            getIO().to(`project:${projectId}`).emit('canvas:node_status', {
                projectId,
                postId: downId,
                status: 'green',
            });
        } catch {}

        // Recurse
        await cascadeGreen(downId, projectId, visited);
    }
}
