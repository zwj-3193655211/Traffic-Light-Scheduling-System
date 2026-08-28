/**
 * This is a user authentication API route demo.
 * Handle user registration, login, token management, etc.
 */
import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'

import { pool } from '../config/database.js'

const router = Router()

function pbkdf2Hash(password: string, salt: Buffer) {
  return crypto.pbkdf2Sync(password, salt, 120_000, 64, 'sha256')
}

function pickBearerToken(req: Request) {
  const h = req.headers?.authorization
  if (!h) return null
  const m = String(h).match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

/**
 * User Login
 * POST /api/auth/register
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = (req.body || {}) as { username?: string; password?: string }
    const u = (username || '').trim()
    const p = String(password || '')
    if (!u || u.length < 3 || u.length > 64 || !p || p.length < 6) {
      res.status(400).json({ success: false, message: '参数不合法' })
      return
    }
    const [exists]: any = await pool.execute(`SELECT id FROM users WHERE username = ? LIMIT 1`, [u])
    if (Array.isArray(exists) && exists.length > 0) {
      res.status(409).json({ success: false, message: '账号已存在' })
      return
    }
    const salt = crypto.randomBytes(16)
    const hash = pbkdf2Hash(p, salt)
    const [r]: any = await pool.execute(
      `INSERT INTO users (username, password_salt, password_hash) VALUES (?, ?, ?)`,
      [u, salt, hash]
    )
    res.json({ success: true, data: { id: r.insertId, username: u } })
  } catch (e: any) {
    res.status(500).json({ success: false, message: '注册失败', error: e?.message })
  }
})

/**
 * User Login
 * POST /api/auth/login
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = (req.body || {}) as { username?: string; password?: string }
    const u = (username || '').trim()
    const p = String(password || '')
    if (!u || !p) {
      res.status(400).json({ success: false, message: '参数不合法' })
      return
    }

    let [rows]: any = await pool.execute(
      `SELECT id, username, password_salt, password_hash FROM users WHERE username = ? LIMIT 1`,
      [u]
    )

    if ((!Array.isArray(rows) || rows.length === 0) && u === 'admin') {
      const [anyUser]: any = await pool.execute(`SELECT id FROM users LIMIT 1`)
      if (!Array.isArray(anyUser) || anyUser.length === 0) {
        const defaultPass = String(process.env.DEFAULT_ADMIN_PASSWORD || '123456')
        const salt = crypto.randomBytes(16)
        const hash = pbkdf2Hash(defaultPass, salt)
        await pool.execute(
          `INSERT INTO users (username, password_salt, password_hash) VALUES ('admin', ?, ?)`,
          [salt, hash]
        )
        ;[rows] = await pool.execute(
          `SELECT id, username, password_salt, password_hash FROM users WHERE username = 'admin' LIMIT 1`
        )
      }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(401).json({ success: false, message: '账号或密码错误' })
      return
    }
    const user = rows[0]
    const salt = Buffer.from(user.password_salt)
    const expected = Buffer.from(user.password_hash)
    const actual = pbkdf2Hash(p, salt)
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      res.status(401).json({ success: false, message: '账号或密码错误' })
      return
    }
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000)
    await pool.execute(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [token, user.id, expiresAt])
    res.json({ success: true, data: { token, expires_at: expiresAt.toISOString(), username: user.username } })
  } catch (e: any) {
    res.status(500).json({ success: false, message: '登录失败', error: e?.message })
  }
})

/**
 * User Logout
 * POST /api/auth/logout
 */
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = pickBearerToken(req) || String((req.body || {})?.token || '')
    if (!token) {
      res.status(400).json({ success: false, message: '缺少 token' })
      return
    }
    await pool.execute(`DELETE FROM sessions WHERE token = ?`, [token])
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ success: false, message: '退出失败', error: e?.message })
  }
})

export default router
