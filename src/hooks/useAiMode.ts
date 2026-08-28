/**
 * AI 动态红绿灯开关
 *
 * Dashboard / TrafficControl / Demo / Settings 四处此前各写一份：
 * 拉取 /api/settings/ai-mode、提交开关、监听 aiModeChanged 广播、维护 Ref 供回调读取。
 * 逻辑完全相同但细节有漂移（有的页面漏了 loading、有的漏了广播同步），此处统一。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { aiModeApi } from '@/lib/api'
import { getSocket } from '@/lib/socket'

export interface UseAiModeResult {
  /** 当前是否启用 AI 动态配时 */
  enabled: boolean
  /** 提交中 */
  loading: boolean
  /** 更新开关，返回是否成功 */
  setEnabled: (next: boolean) => Promise<boolean>
  /**
   * 供 socket 回调等闭包读取最新值的 Ref。
   * 直接用 enabled 会读到渲染时的旧快照，导致 AI 建议判定错误。
   */
  enabledRef: React.MutableRefObject<boolean>
}

export function useAiMode(): UseAiModeResult {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const enabledRef = useRef(false)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  // 初始拉取 + 订阅广播，保证三处页面开关状态一致
  useEffect(() => {
    let alive = true

    aiModeApi
      .get()
      .then((value) => {
        if (alive) setEnabled(!!value)
      })
      .catch(() => {
        /* 后端不可用时保持关闭，不影响页面渲染 */
      })

    const socket = getSocket()
    const onChanged = (payload: { enabled?: boolean }) => {
      if (alive && typeof payload?.enabled === 'boolean') setEnabled(payload.enabled)
    }
    socket.on('aiModeChanged', onChanged)

    return () => {
      alive = false
      socket.off('aiModeChanged', onChanged)
    }
  }, [])

  const setEnabledSafe = useCallback(async (next: boolean) => {
    setLoading(true)
    try {
      const value = await aiModeApi.set(next)
      setEnabled(!!value)
      return true
    } catch {
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  return { enabled, loading, setEnabled: setEnabledSafe, enabledRef }
}
