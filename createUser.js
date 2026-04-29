// backend/createUser.js
import bcrypt from 'bcrypt';
import pool from './db.js';

async function createUser() {
  const email = 'beta@artapp.com';
  const password = 'beta123';

  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
    [email, hash]
  );

  console.log('User created successfully');
  process.exit();
}

createUser();


