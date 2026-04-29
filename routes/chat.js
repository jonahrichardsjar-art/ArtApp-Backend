// backend/routes/chat.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import { getIO } from '../socket.js';
import { sendPush } from './notifications.js';

const router = express.Router();

// Helper: get profile_id from user_id
async function getProfileId(userId) {
    const r = await pool.query(
        `SELECT id FROM profiles WHERE user_id = $1 AND is_archived = FALSE`,
        [userId]
    );
    return r.rows[0]?.id ?? null;
}

// Helper: check if profile is a member of a chat
async function isChatMember(chatId, profileId) {
    const r = await pool.query(
        `SELECT 1 FROM chat_members WHERE chat_id = $1 AND profile_id = $2 AND left_at IS NULL`,
        [chatId, profileId]
    );
    return r.rows.length > 0;
}

/**
 * GET /chat
 * List all chats for the logged-in user, sorted by most recent message.
 * Returns chat info, members, last message, and unread count.
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        // Get all chats the user is a member of (including left ones for history)
        const chatsResult = await pool.query(
            `SELECT
                c.id,
                c.type,
                c.name,
                c.created_at,
                cm.left_at,
                (
                    SELECT json_agg(json_build_object(
                        'profile_id', p.id,
                        'username',   p.username,
                        'display_name', p.display_name,
                        'avatar',     p.profile_picture_url
                    ))
                    FROM chat_members cm2
                    JOIN profiles p ON p.id = cm2.profile_id
                    WHERE cm2.chat_id = c.id AND cm2.left_at IS NULL
                ) AS members,
                (
                    SELECT json_build_object(
                        'id',         m.id,
                        'content',    CASE WHEN m.is_deleted THEN NULL ELSE m.content END,
                        'media_url',  CASE WHEN m.is_deleted THEN NULL ELSE m.media_url END,
                        'media_type', CASE WHEN m.is_deleted THEN NULL ELSE m.media_type END,
                        'is_deleted', m.is_deleted,
                        'sender_profile_id', m.sender_profile_id,
                        'created_at', m.created_at
                    )
                    FROM messages m
                    WHERE m.chat_id = c.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message,
                (
                    SELECT COUNT(*)::int
                    FROM messages m
                    WHERE m.chat_id = c.id
                      AND m.is_deleted = FALSE
                      AND m.sender_profile_id != $1
                      AND m.created_at > COALESCE(
                          (SELECT crr.last_read_at FROM chat_read_receipts crr
                           WHERE crr.chat_id = c.id AND crr.profile_id = $1),
                          cm.joined_at
                      )
                ) AS unread_count
             FROM chats c
             JOIN chat_members cm ON cm.chat_id = c.id AND cm.profile_id = $1
             ORDER BY (
                 SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.chat_id = c.id
             ) DESC NULLS LAST, c.created_at DESC`,
            [profileId]
        );

        // Check blocked status for direct chats
        const blockResult = await pool.query(
            `SELECT blocked_profiles FROM profiles WHERE id = $1`,
            [profileId]
        );
        const blockedIds = new Set(blockResult.rows[0]?.blocked_profiles ?? []);

        const chats = chatsResult.rows.map(chat => {
            let isBlocked = false;
            if (chat.type === 'direct' && chat.members) {
                const other = chat.members.find(m => m.profile_id !== profileId);
                if (other && blockedIds.has(other.profile_id)) {
                    isBlocked = true;
                }
            }
            return {
                ...chat,
                is_blocked: isBlocked,
                is_left:    chat.left_at !== null,
            };
        });

        res.json({ chats });
    } catch (err) {
        console.error('LIST CHATS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /chat/unread-count
 * Returns total unread message count across all chats.
 */
router.get('/unread-count', requireAuth, async (req, res) => {
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        const result = await pool.query(
            `SELECT COALESCE(SUM(unread), 0)::int AS total_unread
             FROM (
                 SELECT COUNT(*)::int AS unread
                 FROM messages m
                 JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.profile_id = $1 AND cm.left_at IS NULL
                 WHERE m.is_deleted = FALSE
                   AND m.sender_profile_id != $1
                   AND m.created_at > COALESCE(
                       (SELECT crr.last_read_at FROM chat_read_receipts crr
                        WHERE crr.chat_id = m.chat_id AND crr.profile_id = $1),
                       cm.joined_at
                   )
                 GROUP BY m.chat_id
             ) sub`,
            [profileId]
        );

        res.json({ unread_count: result.rows[0]?.total_unread ?? 0 });
    } catch (err) {
        console.error('UNREAD COUNT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /chat/mutual-followers
 * Returns users where both follow each other (mutual fans).
 * Used for creating new chats and group chats.
 */
router.get('/mutual-followers', requireAuth, async (req, res) => {
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        const result = await pool.query(
            `SELECT
                p.id,
                p.username,
                p.display_name,
                p.profile_picture_url
             FROM profiles p
             WHERE p.is_archived = FALSE
               AND p.id != $1
               AND $1 = ANY(p.list_of_fans)
               AND p.id = ANY(
                   (SELECT list_of_fandoms FROM profiles WHERE id = $1)
               )
             ORDER BY p.display_name ASC, p.username ASC`,
            [profileId]
        );

        res.json({ users: result.rows });
    } catch (err) {
        console.error('MUTUAL FOLLOWERS ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /chat/direct/:profileId
 * Creates a direct chat with another user, or returns existing one.
 */
router.post('/direct/:profileId', requireAuth, async (req, res) => {
    const { profileId: otherProfileId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });
        if (profileId === otherProfileId) return res.status(400).json({ error: 'Cannot chat with yourself' });

        // Check the other user exists
        const otherCheck = await pool.query(
            `SELECT id FROM profiles WHERE id = $1 AND is_archived = FALSE`,
            [otherProfileId]
        );
        if (otherCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        // Check if a direct chat already exists between these two
        const existingChat = await pool.query(
            `SELECT c.id
             FROM chats c
             WHERE c.type = 'direct'
               AND EXISTS (
                   SELECT 1 FROM chat_members cm1
                   WHERE cm1.chat_id = c.id AND cm1.profile_id = $1
               )
               AND EXISTS (
                   SELECT 1 FROM chat_members cm2
                   WHERE cm2.chat_id = c.id AND cm2.profile_id = $2
               )
             LIMIT 1`,
            [profileId, otherProfileId]
        );

        if (existingChat.rows.length > 0) {
            return res.json({ chat_id: existingChat.rows[0].id, existing: true });
        }

        // Create new direct chat
        const chatResult = await pool.query(
            `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING id`,
            [profileId]
        );
        const chatId = chatResult.rows[0].id;

        // Add both members
        await pool.query(
            `INSERT INTO chat_members (chat_id, profile_id) VALUES ($1, $2), ($1, $3)`,
            [chatId, profileId, otherProfileId]
        );

        res.status(201).json({ chat_id: chatId, existing: false });
    } catch (err) {
        console.error('CREATE DIRECT CHAT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /chat/group
 * Creates a group chat.
 * Body: { name?, member_ids: string[] }
 */
router.post('/group', requireAuth, async (req, res) => {
    const { name, member_ids } = req.body;
    if (!Array.isArray(member_ids) || member_ids.length < 1) {
        return res.status(400).json({ error: 'At least one other member is required' });
    }

    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        // Create the chat
        const chatResult = await pool.query(
            `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
            [name?.trim() || null, profileId]
        );
        const chatId = chatResult.rows[0].id;

        // Add creator + all members
        const allMembers = [profileId, ...member_ids.filter(id => id !== profileId)];
        const memberValues = allMembers.map((id, i) => `($1, $${i + 2})`).join(', ');
        await pool.query(
            `INSERT INTO chat_members (chat_id, profile_id) VALUES ${memberValues}
             ON CONFLICT DO NOTHING`,
            [chatId, ...allMembers]
        );

        // Notify members via socket
        const io = getIO();
        allMembers.forEach(memberId => {
            io.to(`user:${memberId}`).emit('chat:created', { chat_id: chatId });
        });

        res.status(201).json({ chat_id: chatId });
    } catch (err) {
        console.error('CREATE GROUP CHAT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /chat/:chatId
 * Returns paginated messages for a chat.
 * Query: ?limit=30&before=<message_id>
 */
router.get('/:chatId', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const limit  = Math.min(50, parseInt(req.query.limit) || 30);
    const before = req.query.before || null;

    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        if (!(await isChatMember(chatId, profileId))) {
            return res.status(403).json({ error: 'Not a member of this chat' });
        }

        let query;
        let params;

        if (before) {
            query = `
                SELECT
                    m.id,
                    m.content,
                    m.media_url,
                    m.media_type,
                    m.is_deleted,
                    m.created_at,
                    m.sender_profile_id,
                    p.username       AS sender_username,
                    p.display_name   AS sender_display_name,
                    p.profile_picture_url AS sender_avatar
                FROM messages m
                JOIN profiles p ON p.id = m.sender_profile_id
                WHERE m.chat_id = $1
                  AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
                ORDER BY m.created_at DESC
                LIMIT $3`;
            params = [chatId, before, limit];
        } else {
            query = `
                SELECT
                    m.id,
                    m.content,
                    m.media_url,
                    m.media_type,
                    m.is_deleted,
                    m.created_at,
                    m.sender_profile_id,
                    p.username       AS sender_username,
                    p.display_name   AS sender_display_name,
                    p.profile_picture_url AS sender_avatar
                FROM messages m
                JOIN profiles p ON p.id = m.sender_profile_id
                WHERE m.chat_id = $1
                ORDER BY m.created_at DESC
                LIMIT $2`;
            params = [chatId, limit];
        }

        const result = await pool.query(query, params);

        // Also get chat info
        const chatInfo = await pool.query(
            `SELECT c.id, c.type, c.name, c.created_at,
                    (SELECT json_agg(json_build_object(
                        'profile_id', p.id,
                        'username',   p.username,
                        'display_name', p.display_name,
                        'avatar',     p.profile_picture_url
                    ))
                    FROM chat_members cm
                    JOIN profiles p ON p.id = cm.profile_id
                    WHERE cm.chat_id = c.id AND cm.left_at IS NULL
                    ) AS members
             FROM chats c WHERE c.id = $1`,
            [chatId]
        );

        // Get read receipts for this chat
        const receipts = await pool.query(
            `SELECT profile_id, last_read_at
             FROM chat_read_receipts
             WHERE chat_id = $1`,
            [chatId]
        );

        res.json({
            chat:     chatInfo.rows[0] || null,
            messages: result.rows.reverse(), // oldest first for display
            hasMore:  result.rows.length === limit,
            receipts: receipts.rows,
        });
    } catch (err) {
        console.error('GET MESSAGES ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /chat/:chatId/message
 * Sends a message.
 * Body: { content?, media_url?, media_type? }
 */
router.post('/:chatId/message', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    const { content, media_url, media_type } = req.body;

    if (!content?.trim() && !media_url) {
        return res.status(400).json({ error: 'Message cannot be empty' });
    }

    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        if (!(await isChatMember(chatId, profileId))) {
            return res.status(403).json({ error: 'Not a member of this chat' });
        }

        // Check if chat is blocked (direct chats only)
        const chatCheck = await pool.query(`SELECT type FROM chats WHERE id = $1`, [chatId]);
        if (chatCheck.rows[0]?.type === 'direct') {
            const otherMember = await pool.query(
                `SELECT profile_id FROM chat_members WHERE chat_id = $1 AND profile_id != $2 AND left_at IS NULL`,
                [chatId, profileId]
            );
            if (otherMember.rows.length > 0) {
                const otherId = otherMember.rows[0].profile_id;
                const blockCheck = await pool.query(
                    `SELECT blocked_profiles FROM profiles WHERE id = $1`,
                    [profileId]
                );
                const blocked = blockCheck.rows[0]?.blocked_profiles ?? [];
                if (blocked.includes(otherId)) {
                    return res.status(403).json({ error: 'You have blocked this user' });
                }
                // Check if they blocked us
                const reverseBlock = await pool.query(
                    `SELECT blocked_profiles FROM profiles WHERE id = $1`,
                    [otherId]
                );
                const reverseBlocked = reverseBlock.rows[0]?.blocked_profiles ?? [];
                if (reverseBlocked.includes(profileId)) {
                    return res.status(403).json({ error: 'This user has blocked you' });
                }
            }
        }

        const result = await pool.query(
            `INSERT INTO messages (chat_id, sender_profile_id, content, media_url, media_type)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, content, media_url, media_type, is_deleted, created_at, sender_profile_id`,
            [chatId, profileId, content?.trim() || null, media_url || null, media_type || null]
        );

        const message = result.rows[0];

        // Get sender info
        const senderResult = await pool.query(
            `SELECT username, display_name, profile_picture_url FROM profiles WHERE id = $1`,
            [profileId]
        );
        const sender = senderResult.rows[0];

        const fullMessage = {
            ...message,
            sender_username:     sender.username,
            sender_display_name: sender.display_name,
            sender_avatar:       sender.profile_picture_url,
        };

        // Broadcast via socket to all chat members
        const io = getIO();
        const members = await pool.query(
            `SELECT profile_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
            [chatId]
        );
        members.rows.forEach(m => {
            io.to(`user:${m.profile_id}`).emit('chat:message', {
                chat_id: chatId,
                message: fullMessage,
            });
        });

        // Send push notifications to other members
        const senderName = sender.display_name ?? sender.username ?? 'Someone';
        const preview    = content?.trim().slice(0, 50) || (media_url ? '📎 Media' : '');
        members.rows.forEach(m => {
            if (m.profile_id !== profileId) {
                sendPush(m.profile_id, senderName, preview, 'chat');
            }
        });

        res.status(201).json({ message: fullMessage });
    } catch (err) {
        console.error('SEND MESSAGE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /chat/:chatId/read
 * Marks all messages in a chat as read.
 */
router.post('/:chatId/read', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        await pool.query(
            `INSERT INTO chat_read_receipts (chat_id, profile_id, last_read_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (chat_id, profile_id) DO UPDATE SET last_read_at = NOW()`,
            [chatId, profileId]
        );

        // Broadcast read receipt to other members
        const io = getIO();
        const members = await pool.query(
            `SELECT profile_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL AND profile_id != $2`,
            [chatId, profileId]
        );
        members.rows.forEach(m => {
            io.to(`user:${m.profile_id}`).emit('chat:read', {
                chat_id:    chatId,
                profile_id: profileId,
                read_at:    new Date().toISOString(),
            });
        });

        res.json({ success: true });
    } catch (err) {
        console.error('MARK READ ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /chat/message/:messageId
 * Soft-deletes the sender's own message.
 */
router.delete('/message/:messageId', requireAuth, async (req, res) => {
    const { messageId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        const result = await pool.query(
            `UPDATE messages SET is_deleted = TRUE
             WHERE id = $1 AND sender_profile_id = $2 AND is_deleted = FALSE
             RETURNING id, chat_id`,
            [messageId, profileId]
        );
        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Message not found or not yours' });
        }

        const chatId = result.rows[0].chat_id;

        // Broadcast deletion
        const io = getIO();
        const members = await pool.query(
            `SELECT profile_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
            [chatId]
        );
        members.rows.forEach(m => {
            io.to(`user:${m.profile_id}`).emit('chat:message_deleted', {
                chat_id:    chatId,
                message_id: messageId,
            });
        });

        res.json({ success: true });
    } catch (err) {
        console.error('DELETE MESSAGE ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /chat/:chatId/leave
 * Leave a group chat. Only works for group chats.
 */
router.post('/:chatId/leave', requireAuth, async (req, res) => {
    const { chatId } = req.params;
    try {
        const profileId = await getProfileId(req.userId);
        if (!profileId) return res.status(404).json({ error: 'Profile not found' });

        // Verify it's a group chat
        const chatCheck = await pool.query(`SELECT type FROM chats WHERE id = $1`, [chatId]);
        if (chatCheck.rows[0]?.type !== 'group') {
            return res.status(400).json({ error: 'Cannot leave a direct chat' });
        }

        await pool.query(
            `UPDATE chat_members SET left_at = NOW()
             WHERE chat_id = $1 AND profile_id = $2 AND left_at IS NULL`,
            [chatId, profileId]
        );

        // Get sender info for system message
        const senderResult = await pool.query(
            `SELECT username, display_name FROM profiles WHERE id = $1`,
            [profileId]
        );
        const name = senderResult.rows[0]?.display_name ?? senderResult.rows[0]?.username ?? 'Someone';

        // Add a system-style message
        await pool.query(
            `INSERT INTO messages (chat_id, sender_profile_id, content)
             VALUES ($1, $2, $3)`,
            [chatId, profileId, `${name} left the group`]
        );

        // Broadcast
        const io = getIO();
        const members = await pool.query(
            `SELECT profile_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
            [chatId]
        );
        members.rows.forEach(m => {
            io.to(`user:${m.profile_id}`).emit('chat:member_left', {
                chat_id:    chatId,
                profile_id: profileId,
            });
        });

        res.json({ success: true });
    } catch (err) {
        console.error('LEAVE CHAT ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
