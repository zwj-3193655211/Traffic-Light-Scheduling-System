# 智能交通管理系统

用于演示“路口监控 + 自适应配时 + AI 动态红绿灯 + 紧急车辆优先”的全栈项目。

## 运行环境
- Node.js ≥ 18
- npm ≥ 9
- MySQL ≥ 8（本地或远程）
- Redis ≥ 5（可选；缺失时后端会降级启动，但 AI 开关缓存会失效）

## 项目结构简述
- 前端：React 18 + TypeScript + Vite + TailwindCSS
- 后端：Express（ESM/TS 混合），Socket.IO 实时通信
- 数据库：MySQL（自动建库建表）
- 缓存与消息：Redis（Pub/Sub、缓存）

## 克隆与安装依赖
```bash
git clone https://github.com/zwj-3193655211/honglvdengtest.git
cd honglvdengtest
npm install
```

## 环境变量（.env）
### 基础
- `PORT`：后端端口（默认 3001）
- `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`
- `REDIS_HOST`、`REDIS_PORT`、`REDIS_PASSWORD`

### 自适应调度（低车流快速切绿）
- `LOW_FLOW_WINDOW_SECONDS`：统计窗口秒数
- `LOW_FLOW_THRESHOLD`：低车流阈值（窗口内车辆数）
- `MIN_GREEN_FLOOR_SECONDS`：触发低车流时绿灯最短保底秒数

### AI 动态红绿灯
AI 统一走 **OpenAI 兼容的 Chat Completions 协议**，已弃用本地 Ollama。默认可接 **DeepSeek**，并以智谱 GLM 作为备选：

- 默认 DeepSeek（推荐）：`AI_PROVIDER=deepseek`
- 备选智谱 GLM：`AI_PROVIDER=zhipu`

通用：
- `AI_ADVICE_INTERVAL_MS`：AI 建议刷新间隔（默认 10000ms）
- `AI_TIMEOUT_MS`：单次 AI 请求超时（默认 12000ms）
- `MAX_GREEN_SECONDS`：绿灯上限
- `MIN_YELLOW_SECONDS`、`MAX_YELLOW_SECONDS`：黄灯上下限
- `CYCLE_MAX_SECONDS`：整周期上限（也会读取数据库 system_settings.max_cycle_length）

DeepSeek（默认 provider）：
- `DEEPSEEK_API_KEY`：API Key（不要提交到仓库）
- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`：模型名（按平台实际填写，例如 `deepseek-v4-flash`；未配置时使用代码默认值）

智谱 GLM（备选 provider，AI_PROVIDER=zhipu 时启用）：
- `GLM_API_KEY`：API Key（不要提交到仓库）
- `GLM_BASE_URL`：默认 `https://open.bigmodel.cn/api/paas/v4`
- `GLM_MODEL`：模型名（建议 `glm-4-flash`；未配置时使用代码默认值）

### 前端演示参数（Vite）
Vite 仅识别以 `VITE_` 开头的变量：
- `VITE_LOW_FLOW_WINDOW_SECONDS`、`VITE_LOW_FLOW_THRESHOLD`、`VITE_MIN_GREEN_FLOOR_SECONDS`
- `VITE_DEMO_ARRIVAL_SCALE_STRAIGHT`、`VITE_DEMO_ARRIVAL_SCALE_LEFT`
- `VITE_DEMO_RELEASE_STRAIGHT_SCALE`、`VITE_DEMO_RELEASE_LEFT_SCALE`

## 初始化数据库与缓存
- 确保 MySQL 与 Redis 服务已启动，账号与端口与 `.env` 一致。
- 首次启动时，后端会自动创建数据库与表（`api/config/database.js` 的 `initializeDatabase`）。

## 开发模式运行
```bash
# 前后端同时启动（推荐）
npm run dev

# 仅后端（nodemon + tsx 运行 api/server.ts）
npm run server:dev

# 仅前端（Vite 默认端口 5173）
npm run client:dev
```
前端默认访问地址：`http://localhost:5173`，后端 API 地址：`http://localhost:3001`。

## 常用脚本
```bash
npm run build       # 前端构建
npm run preview     # 前端本地预览（构建产物）
npm run lint        # 代码检查
npm run check       # TypeScript 类型检查
npm run ai:smoke    # AI 对话连通性（DeepSeek 或 Zhipu）
npm run ai:advice   # AI 严格 JSON 建议连通性
npm run ai:test     # AI 约束夹紧测试（不依赖模型）
```

## 主要功能
- 仪表盘：实时红绿灯状态、车流趋势、紧急状态提醒、路口快速切换
- 路口管理：路口列表/详情、路口之间“下一路口”链路
- 交通控制：人工介入（切相位/全黄/全红/取消保持）、路口自动/手动模式切换
- 自适应调度：低车流快速切绿（按窗口统计车流、阈值触发提前结束绿灯）
- 紧急管理：紧急车辆优先通行与恢复
- AI 动态红绿灯：周期性请求 AI 给出建议时长，按约束夹紧后实时应用
- 功能演示：本地虚拟路口与可视化参数调节（用于快速体验配时效果）

## 目录结构与文件职责

### 后端（api/）
- api/app.ts：Express 应用与路由挂载（/api/*）
- api/server.ts：本地开发入口；红绿灯调度、AI 建议循环、Socket.IO 广播
- api/config/database.js：MySQL 连接池 + 自动建库建表 + schema 兜底
- api/config/redis.js：Redis 客户端 + Pub/Sub + 简单缓存封装
- api/services/aiTrafficAdvisor.ts：AI 提示词、请求适配（DeepSeek/Zhipu，OpenAI 兼容）、JSON 解析与约束夹紧
- api/routes/*：路口、红绿灯、车流、紧急车辆、系统设置、配时算法等 REST API

### 前端（src/）
- src/App.tsx：路由与登录态骨架（仪表盘/路口/交通控制/紧急/系统设置/功能演示）
- src/pages/Dashboard.tsx：仪表盘（趋势图、状态、路口切换、AI 开关与回显）
- src/pages/TrafficControl.tsx：交通控制（手动控制、AI 开关与回显）
- src/pages/Demo.tsx：功能演示（虚拟路口、参数调节、AI 开关与回显）
- src/components/IntersectionMonitor.tsx：路口红绿灯 + 排队/车流可视化组件
- src/stores/trendEngine.ts：趋势数据聚合与轮询/降级策略
- src/stores/demoEngine.ts：演示引擎（模拟时钟/节奏）
- src/hooks/useIntersectionSim.ts：虚拟路口仿真（相位、队列、出入流）
- src/workers/*：Worker 负责倒计时与定时更新，减少主线程抖动

### 脚本（scripts/）
- scripts/ai-chat-smoke.ts：AI 对话连通性
- scripts/ai-advice-smoke.ts：AI 严格 JSON 建议连通性
- scripts/ai-clamp-test.ts：约束夹紧单测脚本

## AI 动态红绿灯（实现细节）

### 开关与状态同步
- 后端接口：
  - `GET /api/settings/ai-mode`：读取是否启用
  - `POST /api/settings/ai-mode`：写入启用状态
- Redis Key：`system:ai_mode`（仪表盘/交通控制/功能演示三处页面共用同一开关）
- 前端入口：三处页面的“开启AI动态红绿灯”复选框

### 运行机制（实时生效）
启用后，后端会按 `AI_ADVICE_INTERVAL_MS` 周期：
1. 汇总近窗口车流数据作为上下文（按方向统计）
2. 请求 AI 返回 `{ green, yellow, red, reason }` 的严格 JSON
3. 对返回值做约束夹紧（绿/黄上下限，周期总长上限）
4. 写入数据库：
   - 更新该路口的默认配时（default_green_time/default_yellow_time/default_red_time）
   - 同时把当前相位的 remaining_time 立即重置为新建议值，实现“实时使用 AI 建议”
5. 通过 Socket.IO 广播 `trafficTimingUpdate` 与 `trafficLightUpdate` 给前端回显

### 使用的模型
模型通过环境变量控制（均走 OpenAI 兼容协议，逻辑在 `api/services/aiTrafficAdvisor.ts`）：
- DeepSeek（默认）：`AI_PROVIDER=deepseek` + `DEEPSEEK_MODEL`（例如 `deepseek-v4-flash`）
- 智谱 GLM（备选）：`AI_PROVIDER=zhipu` + `GLM_MODEL`（建议 `glm-4-flash`）

### 使用的提示词（Prompt）
系统提示词：
```text
你是交通信号优化助手。必须仅输出严格符合规范的JSON对象，禁止任何额外文本或标记。
```

用户提示词模板（其中约束值与数据为运行期注入）：
```text
任务：根据路口数据给出下一周期时长建议，仅返回严格JSON。
输出要求：
- 仅输出一段合法JSON，不得包含任何说明、代码块或其他文本。
- 字段与类型：{ green: number, yellow: number, red: number, reason: string }。
- 所有数值单位为秒，取整数。
- 约束：green ∈ [minGreen, maxGreen]；yellow ∈ [minYellow, maxYellow]；(green + yellow + red) ≤ cycleMax。
- 依据：车流量多时适度延长绿灯；车流量少时适度缩短；遵守限值。
- 如信息不足，给出合理默认值并在 reason 说明依据。
数据：
{ intersectionId, stats }
/no_think
```

## Socket.IO 事件（前端实时刷新）
- `trafficLightUpdate`：推送某路口完整红绿灯数组（用于列表/面板刷新）
- `light_status_update`：每秒推送单灯状态与剩余秒数（用于倒计时）
- `vehicleFlowUpdate`：推送车流数据（用于趋势图与动画）
- `emergencyMode`：推送紧急/正常状态
- `trafficTimingUpdate`：推送配时更新来源与建议（AI 或 fallback）

## 常见问题
- 端口占用 `EADDRINUSE: :::3001`
  - 原因：已有进程占用 3001 或重复启动多个后端进程
  - 解决：结束占用进程或修改 `.env` 的 `PORT` 后重启
- 无法连接数据库或缓存
  - 检查 `.env` 配置与服务是否已启动
  - MySQL 需具备建库建表权限
- 前端未读取环境变量
  - Vite 仅识别以 `VITE_` 开头的变量；修改 `.env` 后需重启前端开发服务

## 备注
- 开发时只保留一个后端入口（建议 `npm run server:dev` 的 `api/server.ts`），避免重复启动导致端口冲突。
