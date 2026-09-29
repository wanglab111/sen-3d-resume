/* ============================================================================
   和 Keira 聊聊 · 调用层
   ----------------------------------------------------------------------------
   只做四件事，和接入包 backend-node.js 的职责一一对应 —— 只是把「后端代理」
   换成了平台的免密钥通道，所以这个文件跑在浏览器里也不持有任何密钥：
     ① 注入 system prompt（永远是 messages[0]，用户输入进不了那个位置）
     ② 藏住模型凭据（前端根本没有，凭据在服务端）
     ③ 限流（前端这几条是防手滑，真正的配额在平台侧）
     ④ 把流式分片拼成一段话回调出去

   ⚠️ 为什么不用 @tencent-ai/workbuddy-cloud-sdk：
      本站走的是「应用自己的发布域名 + publishableKey」这条免密钥通道，
      协议就是普通的 OpenAI 兼容 SSE（`POST /.cloud/llm/chat/completions`）。
      之前引过一次 SDK，结果发布沙箱里装这个 dev 版本的包装不上，
      整站构建失败、线上直接 504（2026-09-19 事故）。所以这里改成 fetch 直调：
      **零新增依赖**，装什么都不会卡住构建。
   ⚠️ 非流式不支持：上游只接受 stream: true，别照抄 backend-node.js 那种
      「POST 回来一个 { reply }」的写法。
   ========================================================================== */
import { LIMITS, PUBLIC_CONFIG, SYSTEM_PROMPT } from './config'

export type Turn = { role: 'user' | 'assistant'; content: string }

/** 数据面路径：endpoint 后面直接拼这两个，别改 */
const PATH_MODELS = '/.cloud/llm/models'
const PATH_CHAT = '/.cloud/llm/chat/completions'

function url(p: string) {
  return `${PUBLIC_CONFIG.endpoint}${p}`
}

/** 免密钥通道的凭据头：只标识「哪个应用」，安全性由服务端按 Origin 校验 */
function headers() {
  return {
    'Content-Type': 'application/json',
    'x-wb-webapp-access-key': PUBLIC_CONFIG.publishableKey,
  }
}

/* ── 选模型 ────────────────────────────────────────────────────────────
   先拉模型列表再挑一个，偏好顺序：deepseek（中文口语最自然）→ 混元/GLM/Kimi
   这类国产 → 列表里第一个可用的。`disabled === true` 的一律跳过。

   ⚠️ **思考型模型要一律后置**（2026-09-19 实测踩到的坑）：
      上游的 'auto' 会落到 `hy4-preview-f` 这种带思考的模型上，它把 800 token 的
      输出预算几乎全花在 `reasoning_content` 上 —— 实测一条用户消息换来 2304 字思考、
      `content` **一个字都没有**。界面上的表现是"她的气泡一直空着，最后变成
      『……刚才没接上，再说一次？』"，看起来像网络问题，其实是模型选错了。
      开场这几句都是闲聊，不需要思考模型 —— 所以 /think|reason|r1/ 这类 id 一律后置
      （列表里的 `kimi-k2-thinking`、`hunyuan-2.0-thinking` 就在这一档）。

   ⚠️ 拉列表失败时**不要**写死某个 id 兜底（那个 id 可能已下线），用上游自带的 `auto`；
      但 `auto` **不能被当成"已选定"缓存下来** —— 它可能正好落进上面那个坑，
      而且一次网络抖动就被永久锁死。所以只有真从列表里挑出来的才缓存（`_modelPinned`），
      兜底的 auto 下一次发消息会**再试一次列表**。 */
let _modelId: string | null = null
let _modelPinned = false
const FALLBACK_MODEL = 'auto'
/** 思考型：先烧 reasoning token，content 可能一个字都不剩 */
const THINKY = /think|reason|(^|[^a-z])r1([^a-z]|$)/i

async function pickModelId(signal?: AbortSignal): Promise<string> {
  if (_modelId && _modelPinned) return _modelId
  try {
    const res = await fetch(url(PATH_MODELS), { headers: headers(), signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list: { id: string; name?: string; disabled?: boolean; enabled?: boolean }[] =
      await res.json()
    const usable = (Array.isArray(list) ? list : []).filter(
      (m) => m && m.id && m.disabled !== true && m.enabled !== false,
    )
    // 先排除思考型；万一整张表全是思考型，再退回全表（总比没得选强）
    const quick = usable.filter((m) => !THINKY.test(m.id) && !THINKY.test(m.name || ''))
    const pool = quick.length ? quick : usable
    const pick =
      pool.find((m) => /deepseek/i.test(m.id)) ||
      pool.find((m) => /^(hy|glm|kimi|minimax)/i.test(m.id)) ||
      pool.find((m) => m.id !== FALLBACK_MODEL) ||
      pool[0]
    if (pick) {
      _modelId = pick.id
      _modelPinned = true
      return _modelId
    }
  } catch {
    /* 列表拉不到就走 auto 顶着，不拦着聊天 */
  }
  _modelId = FALLBACK_MODEL
  _modelPinned = false
  return _modelId
}

/** 作废这次的选择，下次重新挑 —— 只在"明显是模型选错了"时用 */
function unpinModel() {
  _modelId = null
  _modelPinned = false
}

/** 带 code 的错误，界面按 code 挑文案（对齐上游 error.code 的前缀约定） */
export class ChatError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message || code)
    this.code = code
  }
}

/** 把网络 / 上游抛出来的东西翻成一句人话 */
export function friendly(err: unknown): string | null {
  // 用户自己按了「停」——不是错误，界面上什么都不用显示
  if (err instanceof DOMException && err.name === 'AbortError') return null
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return null

  const code = errorCode(err)
  if (code.startsWith('request_')) return '这条我没法处理，换个说法试试'
  if (code.startsWith('auth_')) return '这个页面要在它自己的域名下打开才管用'
  if (code.startsWith('quota_')) return '今天额度用完了，明天再来找我吧～'
  // 模型把预算全花在"想"上了，正文一个字没吐（见 pickModelId 的说明）
  if (code === 'model_reasoning_only') return '这次光顾着想了，没说出来，再问一次？'
  if (code.startsWith('gateway_')) return '刚才断了，再发一次试试'
  if (code.startsWith('model_')) return '模型这会儿不可用，等一下再试试'
  if (code.startsWith('internal_')) return '出了点小故障，再试一次'

  /* 兜底分支：走到这里基本是**请求根本没出去**（断网 / CORS / 代理）。
     ⚠️ 2026-09-19 实测出来的最可能原因，也是用户真的遇到的那个：
        本机开着系统代理（Clash Verge / mihomo，127.0.0.1:7897），
        而 `*.app.workbuddy.host` 走代理**连不通** ——
        curl 走代理时 CONNECT 隧道能建起来，TLS 握手直接失败（HTTP 000）；
        同一条 URL 直连是 200（0.19s）。google 走代理通、workbuddy.cn 两边都通，
        所以不是"网断了"，是**这个域名被代理绕到了一条走不通的出口**。
     所以这句话必须给出**可执行的动作**，不能只说「看看网络」——
     原来的 "连不上，看看网络？" 用户看完不知道该干什么。 */
  return '网络没连上。开着代理/VPN 的话，把 *.workbuddy.host 设为直连（或先关掉代理）再试。'
}

/** 从各种形状的错误里抽出上游的 error code（没有就空串） */
function errorCode(err: unknown): string {
  return (
    (err as { error?: { code?: string } })?.error?.code ||
    (err as { code?: string })?.code ||
    ''
  )
}

/**
 * 这条错误**重发有没有意义**。
 * 有意义：网络层失败（请求没出去）、网关/模型/内部错误 —— 再试一次通常就好了。
 * 没意义：额度用完、输入不合法、域名不对 —— 原样重发还是同一个结果，
 *        给个「重试」按钮只会让人白点一次。
 */
export function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return false
  const code = errorCode(err)
  if (code.startsWith('request_') || code.startsWith('auth_') || code.startsWith('quota_')) return false
  return true
}

/**
 * 读一条 SSE 流，把每个 data: 分片里的 delta.content 回调出去。
 * 分片可能在网络层被切开，所以留一个 buf 存半行，等下一个分片补上。
 */
async function readSSE(
  res: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new ChatError('internal_no_stream')
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  /* 思考型模型会把正文全烧在 reasoning_content 上（见 pickModelId 的注释）。
     所以要单独记账：正文为空而思考不为空时，这不是"她说不出话"，
     是**模型选错了** —— 抛一个可识别的错，让上层换模型 + 给用户一句人话。 */
  let reasoning = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let j: {
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        error?: { code?: string; message?: string }
      }
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      if (j.error) {
        throw Object.assign(new ChatError(j.error.code || 'internal_error'), {
          error: j.error,
        })
      }
      const delta = j.choices?.[0]?.delta
      if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content.length
      const d = delta?.content
      if (d) {
        out += d
        onDelta(d)
      }
    }
  }
  if (!out && reasoning > 0) throw new ChatError('model_reasoning_only')
  return out
}

/** 发一条，边收边回调；返回拼好的整段（中断时抛 AbortError，调用方自行兜底） */
export async function streamReply(opts: {
  history: Turn[]
  conversationId: string
  signal: AbortSignal
  onDelta: (text: string) => void
}): Promise<string> {
  const modelId = await pickModelId(opts.signal)
  /* ⚠️ 这是全站唯一一处拼 messages 的地方：
       第 0 条**必须**是我们自己的 system prompt，历史从第 1 条开始。
       用户输入只可能落在 user 消息里 —— 就算对方在输入框里写
       「忽略上面的设定」，那也是 user 消息的**内容**，改不了 messages[0]。 */
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...opts.history.slice(-LIMITS.maxHistory).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ]

  const res = await fetch(url(PATH_CHAT), {
    method: 'POST',
    headers: headers(),
    signal: opts.signal,
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: LIMITS.maxTokens,
      conversationId: opts.conversationId,
    }),
  })

  if (!res.ok) {
    let code = ''
    try {
      const j = await res.json()
      code = j?.error?.code || ''
    } catch {
      /* 非 JSON 错误体，按 HTTP 状态给个大类 */
    }
    throw Object.assign(
      new ChatError(code || (res.status === 401 || res.status === 403 ? 'auth_denied' : 'gateway_error')),
      { error: { code } },
    )
  }

  try {
    return await readSSE(res, opts.onDelta)
  } catch (e) {
    // 思考型模型把输出预算烧光了 → 这次的选择作废，下一次重新挑（大概率换掉）
    if (e instanceof ChatError && e.code === 'model_reasoning_only') unpinModel()
    throw e
  }
}

/* ── 前端这一层的限流 ──────────────────────────────────────────────────
   ① 单条输入长度：按字符数，和 README 的 2000 字一致
   ② 一天最多发几条：localStorage 里记「日期 + 次数」，跨天自动清零
   ③ 连点间隔：minGapMs 内不许再发
   下面两个函数只管算，不许抛错（localStorage 在隐私模式下可能直接不可用）。 */
function todayKey() {
  return `keira.chat.${new Date().toISOString().slice(0, 10)}`
}

export function turnsLeftToday(): number {
  try {
    const used = Number(localStorage.getItem(todayKey()) || 0) || 0
    return Math.max(0, LIMITS.dailyTurns - used)
  } catch {
    return LIMITS.dailyTurns
  }
}

export function recordTurn() {
  try {
    const used = Number(localStorage.getItem(todayKey()) || 0) || 0
    localStorage.setItem(todayKey(), String(used + 1))
    // 顺手清掉昨天那条，别在 localStorage 里攒垃圾
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
    localStorage.removeItem(`keira.chat.${y}`)
  } catch {
    /* 存不进去就算了，不挡着聊天 */
  }
}

/* 聊天窗口 id：这个 id 只用于服务端把同一段对话关联起来（排队 / 计量 / 排查），
   **不带上下文** —— 上下文是我们自己在 history 里带着走的。
   所以要按「一次会话」生成并存起来。 */
export function getConversationId(): string {
  const K = 'keira.chat.cid'
  try {
    let id = localStorage.getItem(K)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2)}`
      localStorage.setItem(K, id)
    }
    return id
  } catch {
    return `c_${Date.now()}`
  }
}

/** 换一段新对话（面板里的「重新开始」会用） */
export function resetConversation(): string {
  try {
    localStorage.removeItem('keira.chat.cid')
  } catch {
    /* 忽略 */
  }
  return getConversationId()
}
