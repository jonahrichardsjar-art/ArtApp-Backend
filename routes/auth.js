// backend/routes/auth.js
import express from 'express';
import pool from '../db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { audit } from '../audit.js';

const router = express.Router();

const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MINUTES    = 15;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

/**
 * POST /auth/login
 * Accepts either email or username (case insensitive) + password.
 * Enforces per-account lockout after 10 failed attempts.
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip;

    if (!email || !password) {
        return res.status(400).json({ error: 'Missing email/username or password' });
    }
    if (typeof email !== 'string' || email.length > 254) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    try {
        const isEmail = email.includes('@');
        let result;
        if (isEmail) {
            result = await pool.query(
                `SELECT u.id, u.email, u.password_hash, u.is_archived,
                        u.login_attempts, u.locked_until, u.token_version
                 FROM users u
                 WHERE LOWER(u.email) = LOWER($1)`,
                [email]
            );
        } else {
            result = await pool.query(
                `SELECT u.id, u.email, u.password_hash, u.is_archived,
                        u.login_attempts, u.locked_until, u.token_version
                 FROM users u
                 JOIN profiles p ON p.user_id = u.id
                 WHERE LOWER(p.username) = LOWER($1)
                   AND p.is_archived = FALSE`,
                [email]
            );
        }

        // Always run bcrypt even on miss to prevent timing attacks
        const dummyHash = '$2b$10$abcdefghijklmnopqrstuvuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';
        if (result.rows.length === 0) {
            await bcrypt.compare(password, dummyHash);
            audit.loginFailed(ip, { identifier: email.slice(0, 30) });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        if (user.is_archived) {
            return res.status(403).json({ error: 'This account has been deactivated' });
        }

        // Check lockout
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            audit.loginLocked(ip, { userId: user.id });
            return res.status(429).json({
                error: `Account locked due to too many failed attempts. Try again in ${remaining} minute${remaining !== 1 ? 's' : ''}.`,
            });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            const attempts = (user.login_attempts ?? 0) + 1;
            const lockUntil = attempts >= MAX_LOGIN_ATTEMPTS
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
                : null;
            await pool.query(
                `UPDATE users SET login_attempts = $1, locked_until = $2 WHERE id = $3`,
                [attempts, lockUntil, user.id]
            );
            audit.loginFailed(ip, { userId: user.id, attempts });
            if (lockUntil) {
                return res.status(429).json({
                    error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
                });
            }
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Success — reset lockout counters and update last_login
        await pool.query(
            `UPDATE users
             SET last_login = NOW(), login_attempts = 0, locked_until = NULL
             WHERE id = $1`,
            [user.id]
        );

        // Include token_version in JWT so we can invalidate old tokens on
        // password/email change without a DB lookup on every request
        const token = jwt.sign(
            { id: user.id, email: user.email, tv: user.token_version ?? 0 },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        audit.login(user.id, ip);
        res.json({ token });
    } catch (err) {
        console.error('LOGIN ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /auth/register
 * Admin / beta user creation — not exposed to frontend.
 */
router.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Missing email or password' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash)
             VALUES ($1, $2)
             RETURNING id`,
            [email, hash]
        );
        res.json({ success: true, userId: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'User already exists' });
    }
});

/**
 * Minimum age requirements by country.
 * EU/EEA → 16, South Korea → 14, everywhere else → 13.
 */
const EU_EEA_COUNTRIES = new Set([
    'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR',
    'HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI',
    'SK','IS','LI','NO', // EEA non-EU
    'GB', // UK (retained GDPR post-Brexit)
]);

function getMinAge(countryCode) {
    if (!countryCode) return 13;
    const code = countryCode.toUpperCase();
    if (EU_EEA_COUNTRIES.has(code)) return 16;
    if (code === 'KR') return 14;
    return 13;
}

/**
 * POST /auth/signup
 * Public signup — creates a user and profile row, returns a JWT.
 * Body: { email, password, username, birth_date, country }
 */
router.post('/signup', async (req, res) => {
    const { email, password, username, birth_date, country } = req.body;

    if (!email || !password || !username || !birth_date || !country) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (typeof email    !== 'string' || email.length    > 254)  return res.status(400).json({ error: 'Invalid email' });
    if (typeof username !== 'string' || username.length > 30)   return res.status(400).json({ error: 'Username too long' });
    if (typeof password !== 'string' || password.length > 128)  return res.status(400).json({ error: 'Password too long' });
    if (typeof country  !== 'string' || country.length  > 2)    return res.status(400).json({ error: 'Invalid country code' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Age check — enforce minimum age by country
    const birthDate = new Date(birth_date);
    if (isNaN(birthDate.getTime())) {
        return res.status(400).json({ error: 'Invalid birth date' });
    }
    const today    = new Date();
    const minAge   = getMinAge(country);
    let   age      = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    if (age < minAge) {
        return res.status(400).json({
            error: `You must be at least ${minAge} years old to create an account in ${country}.`,
        });
    }

    try {
        const hash = await bcrypt.hash(password, 10);

        // Insert into users
        const userResult = await pool.query(
            `INSERT INTO users (email, password_hash, birth_date, country)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [email, hash, birth_date, country.toUpperCase()]
        );
        const userId = userResult.rows[0].id;

        // Insert matching profile
        await pool.query(
            `INSERT INTO profiles (user_id, username)
             VALUES ($1, $2)`,
            [userId, username]
        );

        // Get the new profile's id for profile_settings
        const profileResult = await pool.query(
            `SELECT id FROM profiles WHERE user_id = $1`,
            [userId]
        );
        const profileId = profileResult.rows[0].id;

        // Create default user_settings row
        await pool.query(
            `INSERT INTO user_settings (user_id) VALUES ($1)`,
            [userId]
        );

        // Create default profile_settings row
        await pool.query(
            `INSERT INTO profile_settings (profile_id) VALUES ($1)`,
            [profileId]
        );

        const token = jwt.sign(
            { id: userId, email, tv: 0 },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        audit.signup(userId, req.ip);
        res.status(201).json({ token });
    } catch (err) {
        console.error('SIGNUP ERROR:', err);
        if (err.code === '23505') {
            const detail = err.detail || '';
            if (detail.includes('email'))    return res.status(400).json({ error: 'An account with that email already exists' });
            if (detail.includes('username')) return res.status(400).json({ error: 'That username is already taken' });
            return res.status(400).json({ error: 'Email or username already exists' });
        }
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /auth/forgot-password
 * Generates a reset token and emails a link to the user.
 * Always returns 200 even if email not found (prevents user enumeration).
 * Body: { email }
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        const result = await pool.query(
            `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND is_archived = FALSE`,
            [email]
        );

        // Always return success to prevent email enumeration
        if (result.rows.length === 0) {
            return res.json({ success: true });
        }

        const userId = result.rows[0].id;

        // Invalidate any existing unused tokens for this user
        await pool.query(
            `DELETE FROM password_reset_tokens
             WHERE user_id = $1 AND used_at IS NULL`,
            [userId]
        );

        // Generate a secure random token
        const token     = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await pool.query(
            `INSERT INTO password_reset_tokens (user_id, token, expires_at)
             VALUES ($1, $2, $3)`,
            [userId, token, expiresAt]
        );

        const resetUrl = `https://artcellium.com/reset?token=${token}`;

        await transporter.sendMail({
            from:    `"Artcellium" <${process.env.GMAIL_USER}>`,
            to:      email,
            subject: 'Reset your Artcellium password',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
                    <h2 style="color:#242c40">Reset your password</h2>
                    <p style="color:#555;line-height:1.6">
                        We received a request to reset your Artcellium password.
                        Click the button below to choose a new one.
                        This link expires in <strong>1 hour</strong>.
                    </p>
                    <a href="${resetUrl}"
                       style="display:inline-block;margin:24px 0;padding:14px 28px;
                              background:#242c40;color:#d0d0c0;border-radius:8px;
                              text-decoration:none;font-weight:600;font-size:15px">
                        Reset Password
                    </a>
                    <p style="color:#999;font-size:12px">
                        If you didn't request this, you can safely ignore this email.
                        Your password won't change.
                    </p>
                    <p style="color:#999;font-size:12px">
                        Or copy this link: ${resetUrl}
                    </p>
                </div>
            `,
        });

        res.json({ success: true });
    } catch (err) {
        console.error('FORGOT PASSWORD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /reset
 * Serves the password reset HTML page.
 * The token is read from ?token= query param by the page's JS.
 */
router.get('/reset-page', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>Reset Password — Artcellium</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0a0a0a;
            color: #d0d0c0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .card {
            background: #111111;
            border: 1px solid #2a2a2a;
            border-radius: 16px;
            padding: 40px;
            width: 100%;
            max-width: 420px;
        }
        h1 { font-size: 24px; margin-bottom: 8px; }
        p  { color: #888880; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        label { display: block; font-size: 12px; font-weight: 700;
                letter-spacing: 0.8px; color: #888880; margin-bottom: 6px; }
        input {
            width: 100%; padding: 13px; border-radius: 8px;
            border: 1px solid #333; background: #1a1a1a;
            color: #d0d0c0; font-size: 15px; margin-bottom: 16px;
            outline: none;
        }
        input:focus { border-color: #d0d0c0; }
        button {
            width: 100%; padding: 14px; border-radius: 8px;
            background: #d0d0c0; color: #000; font-size: 15px;
            font-weight: 600; border: none; cursor: pointer;
        }
        button:disabled { background: #444; color: #888; cursor: not-allowed; }
        .error   { color: #ef4444; font-size: 13px; margin-bottom: 12px; }
        .success { text-align: center; }
        .success h2 { font-size: 22px; margin-bottom: 12px; }
        .success p  { color: #888880; margin-bottom: 0; }
        .logo { font-size: 20px; font-weight: 700; letter-spacing: 0.5px;
                margin-bottom: 32px; color: #d0d0c0; }
    </style>
</head>
<body>
<div class="card" id="card">
    <div class="logo">Artcellium</div>
    <h1>Reset Password</h1>
    <p>Enter your new password below.</p>
    <div id="error" class="error" style="display:none"></div>
    <label for="pw">NEW PASSWORD</label>
    <input type="password" id="pw" placeholder="At least 8 characters" autocomplete="new-password"/>
    <label for="pw2">CONFIRM PASSWORD</label>
    <input type="password" id="pw2" placeholder="Repeat your new password" autocomplete="new-password"/>
    <button id="btn">Reset Password</button>
</div>

<script>
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token');

    async function handleReset() {
        const pw   = document.getElementById('pw').value;
        const pw2  = document.getElementById('pw2').value;
        const err  = document.getElementById('error');
        const btn  = document.getElementById('btn');

        err.style.display = 'none';

        if (!pw || !pw2)          { showError('Please fill in both fields.'); return; }
        if (pw !== pw2)           { showError('Passwords do not match.'); return; }
        if (pw.length < 8)        { showError('Password must be at least 8 characters.'); return; }

        btn.disabled    = true;
        btn.textContent = 'Resetting…';

        try {
            const res  = await fetch('https://artcellium.com/auth/reset-password', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ token, password: pw }),
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); } catch { data = { error: text }; }
            if (!res.ok) { showError(data.error || 'Something went wrong.'); return; }

            document.getElementById('card').innerHTML =
                '<div class="logo">Artcellium</div>' +
                '<div class="success">' +
                '<h2>Password Reset!</h2>' +
                '<p>Your password has been updated. You can now log in to Artcellium with your new password.</p>' +
                '</div>';
        } catch(e) {
            showError('Cannot connect to the server. Please try again.');
        } finally {
            btn.disabled    = false;
            btn.textContent = 'Reset Password';
        }
    }

    function showError(msg) {
        const err       = document.getElementById('error');
        err.textContent = msg;
        err.style.display = 'block';
    }

    async function handleForgot() {
        const email = document.getElementById('email')?.value;
        const btn   = document.getElementById('btn');
        const err   = document.getElementById('error');
        if (err) err.style.display = 'none';
        if (!email) { showError('Please enter your email.'); return; }
        btn.disabled    = true;
        btn.textContent = 'Sending…';
        try {
            await fetch('https://artcellium.com/auth/forgot-password', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ email }),
            });
            document.getElementById('card').innerHTML =
                '<div class="logo">Artcellium</div>' +
                '<div class="success">' +
                '<h2>Check your email</h2>' +
                '<p>If an account with that email exists, we\\'ve sent a reset link. Check your inbox (and spam folder).</p>' +
                '</div>';
        } catch {
            showError('Cannot connect to the server. Please try again.');
            btn.disabled    = false;
            btn.textContent = 'Send Reset Link';
        }
    }

    // Wire up buttons after functions are defined
    if (!token) {
        document.getElementById('card').innerHTML =
            '<div class="logo">Artcellium</div>' +
            '<h1>Request Reset Link</h1>' +
            '<p>Enter your email address and we\\'ll send you a reset link.</p>' +
            '<div id="error" class="error" style="display:none"></div>' +
            '<label for="email">EMAIL</label>' +
            '<input type="email" id="email" placeholder="your@email.com" autocomplete="email"/>' +
            '<button id="btn">Send Reset Link</button>';
        document.getElementById('btn').addEventListener('click', handleForgot);
    } else {
        document.getElementById('btn').addEventListener('click', handleReset);
    }
</script>
</body>
</html>`);
});

/**
 * POST /auth/reset-password
 * Validates the token and updates the user's password.
 * Body: { token, password }
 */
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
        const result = await pool.query(
            `SELECT id, user_id, expires_at, used_at
             FROM password_reset_tokens
             WHERE token = $1`,
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        }

        const row = result.rows[0];

        if (row.used_at) {
            return res.status(400).json({ error: 'This reset link has already been used.' });
        }

        if (new Date() > new Date(row.expires_at)) {
            return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
        }

        // Hash the new password and update
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            `UPDATE users SET password_hash = $1 WHERE id = $2`,
            [hash, row.user_id]
        );

        // Mark token as used
        await pool.query(
            `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
            [row.id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('RESET PASSWORD ERROR:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
