// backend/audit.js
// Lightweight fire-and-forget audit logger.
// Never throws — audit failures must not break the main request.
import pool from './db.js';

/**
 * Log an action to the audit_logs table.
 *
 * @param {object} opts
 * @param {string}  opts.userId       - UUID of the acting user (can be null for failed logins)
 * @param {string}  opts.action       - e.g. 'login', 'password_change', 'post_delete'
 * @param {string}  [opts.resourceType] - e.g. 'post', 'profile', 'project'
 * @param {string}  [opts.resourceId]   - UUID of the affected resource
 * @param {string}  [opts.ip]           - Client IP address
 * @param {object}  [opts.metadata]     - Any extra context (never include passwords)
 */
export function auditLog({ userId, action, resourceType, resourceId, ip, metadata } = {}) {
    pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            userId       ?? null,
            action,
            resourceType ?? null,
            resourceId   ?? null,
            ip           ?? null,
            metadata     ? JSON.stringify(metadata) : null,
        ]
    ).catch(err => {
        // Never let audit failures crash the app — just log to console
        console.error('AUDIT LOG ERROR:', err.message);
    });
}

// Convenience wrappers for common actions
export const audit = {
    login:          (userId, ip)                   => auditLog({ userId, action: 'login',           ip }),
    loginFailed:    (ip, metadata)                 => auditLog({ action: 'login_failed',             ip, metadata }),
    loginLocked:    (ip, metadata)                 => auditLog({ action: 'login_locked',             ip, metadata }),
    logout:         (userId, ip)                   => auditLog({ userId, action: 'logout',           ip }),
    signup:         (userId, ip)                   => auditLog({ userId, action: 'signup',           ip }),
    passwordChange: (userId, ip)                   => auditLog({ userId, action: 'password_change',  ip }),
    emailChange:    (userId, ip)                   => auditLog({ userId, action: 'email_change',     ip }),
    usernameChange: (userId, ip)                   => auditLog({ userId, action: 'username_change',  ip }),
    postCreate:     (userId, postId, ip)           => auditLog({ userId, action: 'post_create',      resourceType: 'post',    resourceId: postId,    ip }),
    postDelete:     (userId, postId, ip)           => auditLog({ userId, action: 'post_delete',      resourceType: 'post',    resourceId: postId,    ip }),
    reportSubmit:   (userId, resourceType, id, ip) => auditLog({ userId, action: 'report_submit',    resourceType,            resourceId: id,        ip }),
    accountDelete:  (userId, ip)                   => auditLog({ userId, action: 'account_delete',   ip }),
    tokenRevoked:   (userId, ip)                   => auditLog({ userId, action: 'token_revoked',    ip }),
};
