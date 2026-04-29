// backend/routes/suggestions.js
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import pool from '../db.js';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

const router = express.Router();


// Escape user-supplied text before embedding in HTML email
function escapeHtml(str) {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;')
        .replace(/\n/g, '<br/>');
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

/**
 * POST /suggestions
 * Sends a suggestion email to the dev.
 * Body: { category, text }
 */
router.post('/', requireAuth, async (req, res) => {
    const { category, text } = req.body;
    if (!text?.trim())     return res.status(400).json({ error: 'Suggestion text is required' });
    if (!category?.trim()) return res.status(400).json({ error: 'Category is required' });

    try {
        // Get user identity
        const result = await pool.query(
            `SELECT u.email, pr.username, pr.display_name
             FROM users u
             JOIN profiles pr ON pr.user_id = u.id
             WHERE u.id = $1 AND pr.is_archived = FALSE`,
            [req.userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const { email, username, display_name } = result.rows[0];
        const name = display_name ?? username;

        await transporter.sendMail({
            from:    `"Artcellium Suggestions" <${process.env.GMAIL_USER}>`,
            to:      process.env.GMAIL_USER,
            subject: `[${escapeHtml(category)}] New suggestion from ${escapeHtml(name)}`,
            html: `
                <h2 style="color:#333">New Suggestion — ${escapeHtml(category)}</h2>
                <hr/>
                <p><strong>From:</strong> ${escapeHtml(name)} (@${escapeHtml(username)})</p>
                <p><strong>Email:</strong> ${escapeHtml(email)}</p>
                <p><strong>Category:</strong> ${escapeHtml(category)}</p>
                <hr/>
                <p style="font-size:16px;line-height:1.6">${escapeHtml(text.trim())}</p>
                <hr/>
                <p style="color:#999;font-size:12px">Sent via Artcellium in-app suggestion form</p>
            `,
        });

        res.json({ success: true });
    } catch (err) {
        console.error('SUGGESTION EMAIL ERROR:', err);
        res.status(500).json({ error: 'Failed to send suggestion' });
    }
});

export default router;
