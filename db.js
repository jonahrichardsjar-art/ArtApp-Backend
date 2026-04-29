// backend/db.js
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required for remote Postgres (RDS/Neon/Supabase etc.)
    max:              20,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 5000,
});

// Kill any query running longer than 30 seconds at the session level
pool.on('connect', (client) => {
    client.query('SET statement_timeout = 30000').catch(() => {});
});

// Log connection errors — these usually mean the DB is unreachable
pool.on('error', (err) => {
    console.error('Unexpected Postgres pool error:', err.message);
});

export default pool;
