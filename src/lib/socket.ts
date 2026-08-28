/**
 * Socket.IO 单例
 *
 * 此前 Dashboard / TrafficControl / Demo / IntersectionDetail / Header 各自 io() 建连接，
 * 同一次会话最多会开 5 条 WebSocket，且页面卸载时 s.disconnect() 会互相影响。
 * 改为全局单例：首次调用建立连接，之后复用；页面卸载不再断开。
 */
import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      // 断线后自动重连，避免后端重启导致前端永久失去实时推送
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    })
    return socket
  }
  // 自愈：socket.io 客户端手动 disconnect()/close() 后 skipReconnect 会被置 true，
  // 之后【永远不会自动重连】（active=false），而单例变量仍非空导致后续调用方
  // 拿到的是死连接——表现为红绿灯倒计时到 0s 后卡死，只有刷新页面才恢复。
  // 这里检测到死连接时主动 connect() 复活（connect 会重置 skipReconnect）。
  if (!socket.connected && !socket.active) {
    socket.connect()
  }
  return socket
}

/** 仅用于测试或整页销毁；常规页面卸载不要调用 */
export function closeSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
