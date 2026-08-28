import 'dotenv/config'

// AI 对话连通性冒烟测试
// 已弃用 Ollama，现支持 deepseek（默认）/ zhipu，均走 OpenAI 兼容协议。
// 用法：
//   npm run ai:smoke
// 需先在 .env 配置对应 provider 的 API Key。

const PROVIDERS: Record<string, { label: string; baseURL: string; apiKeyEnv: string; defaultModel: string }> = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
  },
  zhipu: {
    label: '智谱 GLM',
    baseURL: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyEnv: 'GLM_API_KEY',
    defaultModel: process.env.GLM_MODEL ?? 'glm-4-flash'
  }
}

function resolveEndpoint(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return `${trimmed}/chat/completions`
}

async function main() {
  const providerName = (process.env.AI_PROVIDER ?? 'deepseek').toLowerCase()
  const provider = PROVIDERS[providerName] ?? PROVIDERS.deepseek
  const url = resolveEndpoint(provider.baseURL)
  const model = provider.defaultModel
  const apiKey = (process.env[provider.apiKeyEnv] ?? '').trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  } else {
    console.error(`缺少 ${provider.apiKeyEnv}（请在 .env 中配置 ${provider.label} 的 API Key）`)
    process.exit(1)
  }
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: '请用一句话回答：你好' }
        ],
        stream: false
      })
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('HTTP', res.status, text)
      process.exit(1)
    }
    const data: any = await res.json()
    // OpenAI 兼容返回：{ choices: [{ message: { content: "..." } }] }
    let msg: string = data?.choices?.[0]?.message?.content ?? ''
    msg = msg.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const elapsed = Date.now() - t0
    console.log(JSON.stringify({ ok: true, provider: provider.label, model, elapsed_ms: elapsed, reply: msg }, null, 2))
    process.exit(0)
  } catch (e: any) {
    console.error('SMOKE_ERROR', e?.message ?? String(e))
    process.exit(1)
  }
}

main()
