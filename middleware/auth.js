// backend/middleware/auth.js
// Shared requireAuth middleware used across all routes.
// Verifies JWT signature AND checks token_version against DB to ensure
// the token hasn't been invalidated by a password/email change.
import jwt from 'jsonwebtoken';
import pool from '../db.js';

export async function requireAuth(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Token version check — if user changed password/email, old tokens are rejected
    // tv field was added when token versioning was introduced; treat missing tv as 0
    try {
        const result = await pool.query(
            `SELECT token_version, is_archived FROM users WHERE id = $1`,
            [decoded.id]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Account not found' });
        }
        const user = result.rows[0];
        if (user.is_archived) {
            return res.status(403).json({ error: 'Account deactivated' });
        }
        const tokenVersion = decoded.tv ?? 0;
        if (tokenVersion < (user.token_version ?? 0)) {
            return res.status(401).json({ error: 'Session expired. Please log in again.' });
        }
    } catch (err) {
        console.error('AUTH MIDDLEWARE ERROR:', err);
        return res.status(500).json({ error: 'Server error' });
    }

    req.userId = decoded.id;
    next();
}
