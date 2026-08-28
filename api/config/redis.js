/**
 * Redis 客户端：缓存 + Pub/Sub
 *
 * 说明：Redis 不可用时不会阻塞服务启动，所有读写均降级为 no-op 并返回安全值，
 * 由调用方决定是否兜底（AI 开关缓存会失效，但配时逻辑不受影响）。
 */
import { createClient } from 'redis'
import 'dotenv/config'

const HOST = process.env.REDIS_HOST || 'localhost'
const PORT = Number(process.env.REDIS_PORT) || 6379
const PASSWORD = process.env.REDIS_PASSWORD || undefined

// 注意：redis v4+ 的连接参数必须放在 socket 下，顶层 host/port 会被静默忽略
const clientOptions = {
  socket: {
    host: HOST,
    port: PORT,
    // 永不放弃：Redis 可能晚于应用启动，客户端会按此策略在后台持续自动重连，
    // 直到 Redis 就绪后自动恢复（无需重启应用）。首次 connect() 失败会 reject，
    // 但 redis 仍会按本策略后台重试，故不要返回 Error 让它停止。
    reconnectStrategy: (attempts) => Math.min(attempts * 500, 3000),
  },
  password: PASSWORD,
}

const redisClient = createClient(clientOptions)
const subscriber = redisClient.duplicate()
const publisher = redisClient.duplicate()

const bindLifecycleLogs = (client, label) => {
  client.on('connect', () => console.log(`[Redis] ${label} 已连接`))
  client.on('ready', () => console.log(`[Redis] ${label} 就绪`))
  client.on('end', () => console.log(`[Redis] ${label} 连接已关闭`))
  client.on('error', (err) => console.error(`[Redis] ${label} 错误:`, err.message))
}

bindLifecycleLogs(redisClient, '主客户端')
bindLifecycleLogs(subscriber, '订阅客户端')
bindLifecycleLogs(publisher, '发布客户端')

let connectPromise = null

/** 建立连接；重复调用复用同一次连接，避免 "Socket already opened" */
export async function initializeRedis() {
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    try {
      await redisClient.connect()
      await subscriber.connect()
      await publisher.connect()
      console.log('[Redis] 连接初始化完成')
      return true
    } catch (error) {
      // 首次 connect 失败只代表 Redis 此刻尚未就绪；客户端会按 reconnectStrategy 后台自动重连，
      // 因此这里不视为致命错误，应用照常启动，Redis 就绪后自动恢复。
      console.warn('[Redis] 暂未连接（将在后台自动重试）:', error.message)
      return false
    }
  })()
  return connectPromise
}

/** 发布消息到指定频道 */
export async function publishMessage(channel, message) {
  try {
    await publisher.publish(channel, JSON.stringify(message))
    return true
  } catch (error) {
    console.error('[Redis] 发布消息失败:', error.message)
    return false
  }
}

/** 订阅频道消息，回调收到已解析的对象 */
export async function subscribeMessage(channel, callback) {
  try {
    await subscriber.subscribe(channel, (raw) => {
      try {
        callback(JSON.parse(raw))
      } catch {
        console.error('[Redis] 解析消息失败')
      }
    })
    return true
  } catch (error) {
    console.error('[Redis] 订阅消息失败:', error.message)
    return false
  }
}

/**
 * 写入缓存。value 为空或过期时间非法时按删除处理，
 * 这样调用方可以用 setCache(key, null) 表达"失效"。
 */
export async function setCache(key, value, expireSeconds = 300) {
  try {
    if (value === null || value === undefined || !Number.isFinite(expireSeconds) || expireSeconds <= 0) {
      await redisClient.del(key)
      return true
    }
    const payload = typeof value === 'string' ? value : JSON.stringify(value)
    await redisClient.setEx(key, expireSeconds, payload)
    return true
  } catch (error) {
    console.error('[Redis] 设置缓存失败:', error.message)
    return false
  }
}

/** 读取缓存，命中 JSON 自动反序列化，未命中返回 null */
export async function getCache(key) {
  try {
    const value = await redisClient.get(key)
    if (!value) return null
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  } catch (error) {
    console.error('[Redis] 获取缓存失败:', error.message)
    return null
  }
}

export async function deleteCache(key) {
  try {
    await redisClient.del(key)
    return true
  } catch (error) {
    console.error('[Redis] 删除缓存失败:', error.message)
    return false
  }
}

export async function closeRedis() {
  try {
    await redisClient.quit()
    await subscriber.quit()
    await publisher.quit()
    console.log('[Redis] 连接已关闭')
  } catch (error) {
    console.error('[Redis] 关闭连接失败:', error.message)
  }
}

export { redisClient, subscriber, publisher }
