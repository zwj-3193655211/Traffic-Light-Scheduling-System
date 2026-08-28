// AI 动态红绿灯顾问
//
// 统一走 OpenAI 兼容的 Chat Completions 协议，支持云端与本地两种模式共存：
//   deepseek  —— DeepSeek 云端 API（默认）
//   zhipu     —— 智谱 GLM 云端 API
//   llamacpp  —— 本地 llama.cpp（llama-server），离线可用、免密钥
//
// 切换方式：仅改 .env，无需改动业务代码。
//   AI_PROVIDER=deepseek  + DEEPSEEK_API_KEY + DEEPSEEK_MODEL
//   AI_PROVIDER=zhipu     + GLM_API_KEY      + GLM_MODEL
//   AI_PROVIDER=llamacpp  + LLAMACPP_BASE_URL(默认 http://127.0.0.1:8080/v1)
//
// 双模式互为备份（可选）：
//   AI_FALLBACK_PROVIDER=deepseek 表示本地 llamacpp 失败时自动走 DeepSeek，
//   反之 AI_PROVIDER=deepseek + AI_FALLBACK_PROVIDER=llamacpp 亦可。
//   两者都不可用时，由上层退回规则配时（ruleBasedTiming），系统始终可用。
//
// 启动 llama.cpp 服务示例：
//   llama-server -m model.gguf -c 4096 --host 127.0.0.1 --port 8080

// 优化（见 docs/AI优化设计.md）：
//  - reason 可解释：返回 { green, reason }，供前端/广播展示与审计。
//  - 运行时热切换模型：setModelOverride() 由 server 从 Redis system:ai_model 读取后设置。
//  - 熔断器（Circuit Breaker）：连续失败 >= 5 次进入 OPEN（60s 内不调用、走规则降级），冷却后 HALF_OPEN 探活。
//  - 退避重试：仅对 429/5xx/网络超时做指数退避（最多 2 次），4xx 直接失败。
//  - 指标埋点：getAdvisorMetrics() 暴露调用量/成功率/耗时/熔断跳过。

export type AiAdvice = {
  green: number
  reason?: string
}

export type AiContext = {
  intersectionId: string
  stats: Record<string, unknown>
}

export type Constraints = {
  minGreen: number
  maxGreen: number
  minYellow: number
  maxYellow: number
  cycleMax: number
}

// ---- Provider 注册表（均为 OpenAI 兼容协议）----
//
// 支持的三种模式：
//   deepseek  —— 云端 API，延迟低、无需本地算力，需要 DEEPSEEK_API_KEY
//   zhipu     —— 云端备选（智谱 GLM）
//   llamacpp  —— 本地 llama.cpp 的 llama-server，离线可用、免密钥，但推理较慢且 JSON 依从性较弱
//
// 关键点：llama.cpp 的 llama-server 原生暴露 OpenAI 兼容端点（/v1/chat/completions），
// 因此本地模式不需要第二套协议实现，只需切换 baseURL / model 即可，
// 仅在默认超时上对本地推理做差异化（CPU 推理可能达数十秒）。
type ProviderConfig = {
  label: string
  baseURL: string
  apiKeyEnv: string
  defaultModel: string
  /** 本地推理（llama.cpp）免密钥，云端 provider 缺失密钥时快速失败并给出明确提示 */
  requiresApiKey: boolean
  defaultTimeoutMs: number
}

const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    requiresApiKey: true,
    defaultTimeoutMs: 12_000,
  },
  zhipu: {
    label: '智谱 GLM',
    baseURL: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyEnv: 'GLM_API_KEY',
    defaultModel: process.env.GLM_MODEL ?? 'glm-4-flash',
    requiresApiKey: true,
    defaultTimeoutMs: 12_000,
  },
  llamacpp: {
    label: 'llama.cpp(本地)',
    baseURL: process.env.LLAMACPP_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    apiKeyEnv: 'LLAMACPP_API_KEY',
    defaultModel: process.env.LLAMACPP_MODEL ?? 'local-gguf',
    requiresApiKey: false,
    defaultTimeoutMs: 60_000,
  },
}

const providerName = (process.env.AI_PROVIDER ?? 'deepseek').toLowerCase()
const provider: ProviderConfig = PROVIDERS[providerName] ?? PROVIDERS.deepseek

/**
 * 备用 provider：主 provider 不可用（超时 / 熔断 / 本地服务未启动）时自动接管。
 * 典型用法：AI_PROVIDER=llamacpp + AI_FALLBACK_PROVIDER=deepseek，
 * 本地离线优先、云端兜底，两种模式互为备份。
 */
const fallbackName = (process.env.AI_FALLBACK_PROVIDER ?? '').toLowerCase().trim()
const fallbackProvider: ProviderConfig | null =
  fallbackName && fallbackName !== providerName ? PROVIDERS[fallbackName] ?? null : null

// 运行时模型覆盖（由 server 从 Redis system:ai_model 读取后设置，实现不重启切换模型）
let modelOverride: string | null = null
export function setModelOverride(m: string | null) {
  const t = m ? String(m).trim() : ''
  modelOverride = t ? t : null
}
/**
 * 生效模型名。必须按 provider 解析：本地 llama.cpp 与云端 DeepSeek 的模型名不通用，
 * 否则回退到备用 provider 时会把 "local-gguf" 发给云端导致 model not found。
 */
function effectiveModel(p: ProviderConfig = provider): string {
  return modelOverride || p.defaultModel
}

// ---- 熔断器（Circuit Breaker）----
const CB_THRESHOLD = 5          // 连续失败达到该值进入 OPEN
const CB_COOLDOWN_MS = 60_000   // OPEN 持续时间
let cbFailures = 0
let cbOpenUntil = 0
let cbHalfOpen = false

function cbAllow(now: number): boolean {
  if (cbOpenUntil > 0 && now < cbOpenUntil) return false      // 仍在 OPEN，拒绝
  if (cbOpenUntil > 0 && now >= cbOpenUntil) {                // 冷却结束，放行一次探活
    cbHalfOpen = true
    cbOpenUntil = 0
  }
  return true
}
function cbOnSuccess() {
  cbFailures = 0
  cbOpenUntil = 0
  cbHalfOpen = false
}
function cbOnFailure(now: number) {
  cbFailures++
  if (cbFailures >= CB_THRESHOLD) {
    cbOpenUntil = now + CB_COOLDOWN_MS
    cbHalfOpen = false
  }
}

// ---- 指标埋点 ----
const metrics = {
  calls: 0,
  successes: 0,
  failures: 0,
  circuitOpenSkips: 0,
  totalLatencyMs: 0,
  lastLatencyMs: 0
}
export function getAdvisorMetrics() {
  return {
    ...metrics,
    avgLatencyMs: metrics.calls ? Math.round(metrics.totalLatencyMs / metrics.calls) : 0
  }
}

// 规范化为完整的 chat/completions 端点，避免用户只填了 base 域名。
function resolveEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

const SYSTEM_PROMPT = [
  '你是城市交通信号优化助手。根据各方向车流量与当前信号状态，给出下一周期最优绿灯时长（秒）。',
  '输出规则：',
  '1. 仅返回一段合法 JSON，禁止任何额外文本、代码块或思考过程。格式：{"green": 数值, "reason": "简要依据"}。',
  '2. green 为建议绿灯秒数（整数）；返回 -1 表示建议保持当前绿灯时长、不调整。',
  '3. 车流量大则适度延长绿灯，车流量小则适度缩短；避免在同相位内频繁剧烈变动。',
  '4. reason 用一句话说明依据，便于审计与可解释性。'
].join('\n')

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function clampAdvice(advice: AiAdvice, c: Constraints): AiAdvice {
  const green = clamp(Math.round(advice.green), c.minGreen, c.maxGreen)
  return { green, reason: advice.reason }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
function isRetryableStatus(s: number): boolean {
  return s === 429 || (s >= 500 && s < 600)
}

// 硬超时：无论 fetch 的 AbortSignal 是否生效，都在 timeoutMs 后强制 reject，
// 避免单个挂起的请求把相位机主循环阻塞数分钟（实测 Node22/undici 下 signal 不中止时可达 100s+）。
function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(msg)), timeoutMs)
    promise.then(
      (v) => { clearTimeout(id); resolve(v) },
      (e) => { clearTimeout(id); reject(e) }
    )
  })
}

// 带退避重试的 Chat Completions 请求。
// 仅对 429/5xx/网络超时做指数退避（最多 2 次重试）；4xx 直接失败（鉴权/参数错误不重试）。
// 超时：① AbortController 尽力取消底层 socket；② withHardTimeout 兜底，保证函数最迟 timeoutMs 返回/抛错。
async function postChatCompletions(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const maxAttempts = 3 // 1 次初始 + 2 次重试
  let lastErr: any = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let externalAbort: (() => void) | null = null
    // 合并外部取消信号（如相位机主循环 abort）
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else {
        externalAbort = () => controller.abort()
        try { externalSignal.addEventListener('abort', externalAbort, { once: true } as any) } catch {}
      }
    }
    try {
      const res = await withHardTimeout(
        fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        }),
        timeoutMs,
        `AI请求超时(${timeoutMs}ms)`
      )
      clearTimeout(timer)
      if (externalAbort && externalSignal) externalSignal.removeEventListener('abort', externalAbort)
      if (res.ok) return res
      const retryable = isRetryableStatus(res.status)
      if (!retryable || attempt === maxAttempts) {
        const text = await res.text().catch(() => '')
        throw new Error(`AI ${res.status}: ${text}`)
      }
      await sleep(500 * attempt) // 500ms, 1000ms
      continue
    } catch (e: any) {
      clearTimeout(timer)
      if (externalAbort && externalSignal) externalSignal.removeEventListener('abort', externalAbort)
      lastErr = e
      const msg = String(e?.message || '')
      const retryable = msg.includes('超时') || e?.name === 'TypeError' || msg.includes('aborted')
      if (!retryable || attempt === maxAttempts) throw e
      await sleep(500 * attempt)
      continue
    }
  }
  throw lastErr ?? new Error('AI 请求失败')
}

/** 模型明确答复"不建议调整"：这是有效响应而非失败，不应触发备用 provider 或降级 */
const AI_NO_CHANGE = 'AI建议不调整'

/**
 * 对单个 provider 执行一次完整调用：构造提示 -> 请求 -> 解析 -> 约束夹紧。
 * 熔断器与指标埋点在本函数内部维护。
 */
async function requestAdvice(
  p: ProviderConfig,
  ctx: AiContext,
  constraints: Constraints,
  abortSignal?: AbortSignal
): Promise<AiAdvice> {
  const url = resolveEndpoint(p.baseURL)
  const apiKey = (process.env[p.apiKeyEnv] ?? '').trim()
  if (p.requiresApiKey && !apiKey) {
    throw new Error(`未配置 ${p.apiKeyEnv}，provider=${p.label} 不可用`)
  }
  const stats = ctx.stats as any
  const fmt = stats.formattedStats || {}
  const directions = ['North', 'South', 'East', 'West']

  const dataDesc = directions.map(dir => {
    const d = fmt[dir] || { straight: 0, left: 0 }
    const sStatus = d.straightStatus
    const lStatus = d.leftStatus

    const sText = sStatus
      ? (sStatus.current_status === 2 ? `直行绿灯剩余${sStatus.remaining_time}秒` : (sStatus.current_status === 1 ? '直行黄灯' : '直行红灯'))
      : '直行未知'

    const lText = lStatus
      ? (lStatus.current_status === 2 ? `左转绿灯剩余${lStatus.remaining_time}秒` : (lStatus.current_status === 1 ? '左转黄灯' : '左转红灯'))
      : '左转未知'

    return `   ${dir}：直行${d.straight}辆，左转${d.left}辆，${sText}，${lText}`
  }).join('\n')

  const userPrompt = [
    '数据：',
    dataDesc
  ].join('\n')

  console.log('============== [AI Request] ==============')
  console.log(`[AI] provider=${p.label} model=${effectiveModel(p)} intersection=${ctx.intersectionId}${cbHalfOpen ? ' (HALF_OPEN probe)' : ''}`)
  console.log('==========================================')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ]

  // 显式配置 AI_TIMEOUT_MS 优先，否则用 provider 默认值（本地 llama.cpp 需要更长）
  const timeoutMs = parseInt(process.env.AI_TIMEOUT_MS || String(p.defaultTimeoutMs))
  const startedAt = Date.now()
  metrics.calls++

  let res: Response
  try {
    res = await postChatCompletions(
      url,
      headers,
      { model: effectiveModel(p), messages, stream: false, temperature: 0.2 },
      timeoutMs,
      abortSignal
    )
  } catch (e: any) {
    cbOnFailure(Date.now())
    metrics.failures++
    throw e
  }

  if (!res.ok) {
    // postChatCompletions 已对非重试状态抛错；此处兜底（理论不可达）
    cbOnFailure(Date.now())
    metrics.failures++
    const text = await res.text().catch(() => '')
    throw new Error(`AI ${res.status}: ${text}`)
  }

  const data: any = await res.json()
  // OpenAI 兼容返回格式: { choices: [{ message: { content: "..." } }] }
  let content: string = data?.choices?.[0]?.message?.content ?? '{}'

  console.log('============== [AI Response] =============')
  console.log(`[AI] elapsed=${Date.now() - startedAt}ms`)
  console.log(content)
  console.log('==========================================')

  content = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```json|```/g, '')
    .trim()
  let parsed: { green?: number | string; reason?: string }
  try {
    parsed = JSON.parse(content)
  } catch {
    const m = content.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        parsed = JSON.parse(m[0])
      } catch {
        cbOnFailure(Date.now())
        metrics.failures++
        throw new Error('AI返回非JSON')
      }
    } else {
      cbOnFailure(Date.now())
      metrics.failures++
      throw new Error('AI返回非JSON')
    }
  }

  const reason = parsed?.reason ? String(parsed.reason) : undefined
  if (reason) {
    console.log(`[AI] reason=${reason}`)
  }

  const greenRaw = parsed?.green
  const greenText = String(greenRaw ?? '').trim()
  if (greenText === '-1') {
    // 模型明确"建议不调整"：视为有效调用（重置熔断器），由上层决定是否采用规则值
    cbOnSuccess()
    metrics.successes++
    metrics.lastLatencyMs = Date.now() - startedAt
    metrics.totalLatencyMs += metrics.lastLatencyMs
    throw new Error(AI_NO_CHANGE)
  }
  const normalized = greenText.toLowerCase().endsWith('s')
    ? greenText.slice(0, -1).trim()
    : greenText
  const greenVal = Number.parseInt(normalized, 10)
  if (!Number.isFinite(greenVal)) {
    cbOnFailure(Date.now())
    metrics.failures++
    throw new Error('AI返回的 green 非数值')
  }
  if (greenVal === -1) {
    cbOnSuccess()
    metrics.successes++
    metrics.lastLatencyMs = Date.now() - startedAt
    metrics.totalLatencyMs += metrics.lastLatencyMs
    throw new Error(AI_NO_CHANGE)
  }

  cbOnSuccess()
  metrics.successes++
  metrics.lastLatencyMs = Date.now() - startedAt
  metrics.totalLatencyMs += metrics.lastLatencyMs
  return clampAdvice({ green: greenVal, reason }, constraints)
}

/**
 * 对外入口：先走主 provider，失败时自动切换到备用 provider。
 *
 * 这样"本地 llama.cpp 优先 + 云端 DeepSeek 兜底"（或反过来）只靠环境变量组合，
 * 业务代码无需感知当前跑在哪种模式下。
 */
export async function getAdvice(
  ctx: AiContext,
  constraints: Constraints,
  abortSignal?: AbortSignal
): Promise<AiAdvice> {
  const now = Date.now()
  if (!cbAllow(now)) {
    metrics.circuitOpenSkips++
    throw new Error('AI熔断器开启(OPEN)，走规则降级')
  }

  try {
    return await requestAdvice(provider, ctx, constraints, abortSignal)
  } catch (err: any) {
    // "不建议调整"是模型的有效答复，不是故障，无需回退
    if (err?.message === AI_NO_CHANGE || !fallbackProvider) throw err

    console.warn(
      `[AI] 主 provider=${provider.label} 调用失败，切换备用 provider=${fallbackProvider.label}（原因：${err?.message}）`
    )
    try {
      return await requestAdvice(fallbackProvider, ctx, constraints, abortSignal)
    } catch {
      // 两者都失败时抛出主 provider 的错误，便于定位首选链路的问题
      throw err
    }
  }
}

export const aiTrafficAdvisor = {
  getAdvice,
  getAdvisorMetrics,
  /** 供健康面板展示当前生效的 provider 组合 */
  describeProvider: () => ({
    provider: providerName,
    label: provider.label,
    model: effectiveModel(),
    endpoint: resolveEndpoint(provider.baseURL),
    fallback: fallbackProvider
      ? { provider: fallbackName, label: fallbackProvider.label }
      : null,
  }),
}

export const clampAdviceForTest = clampAdvice
