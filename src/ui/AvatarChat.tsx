import { useCallback, useEffect, useRef, useState } from 'react'
import { COPY, LIMITS } from '../chat/config'
import {
  friendly,
  getConversationId,
  isRetryable,
  recordTurn,
  resetConversation,
  streamReply,
  turnsLeftToday,
  type Turn,
} from '../chat/cloud'
import { CHAT_OPEN_EVENT, CHAT_OPEN_SOON_EVENT } from '../chat/open'

/* ============================================================================
   和 Keira 聊聊 · 面板
   ----------------------------------------------------------------------------
   接入包里 chat-widget.js 是「右下角一个橙色圆钮 + 通用客服气泡」。直接搬过来
   有个问题：这个站的开场是一部滚动驱动的影片，右下角常驻一个橙色按钮会把
   整场电影的气氛拆掉；而且橙色 (#C96F43) 和站内的墨色/米白完全不是一个语言。

   所以这一版保留「右下角入口 + 面板」的骨架，但把它改成了这个站自己的东西：

   ① **滚过开场影片才出现**。影片期间右下角是空的，第一屏保持干净；
      只有访客真的进了简历，那个钮才慢慢浮出来（visible 由 App 传进来）。
   ② **它是「闲着才开口」的**。平时只是一个不打扰人的小圆点（里面一圈缓慢
      呼吸的光，呼应影片最后那个光环）。只有在页面上**连续 45 秒没有任何操作**
      时，它才展开成一句「无聊了？聊两句」—— 这就是「当朋友无聊的时候」那句
      需求本身，做成行为而不是文案。鼠标一动它就自己收回去，
      而且**一次会话只开口一次**，不骚扰。
      点开过一次之后，它就安静地待着，需要的人自己会来点。
   ③ **配色和排版跟着站点走**：墨色玻璃面板 + 米白字，和履历、作品区同一套
      变量；不用 emoji、不用「智能助手」那套话术。
   ④ **边打字边上屏**：走流式（SDK 只支持流式），像有人在对面敲字；
      等第一个字的时候给一个三点呼吸。不想等了可以按「停」中断。

   ⚠️ 约束（来自接入包 README 的「硬性约束」，别省）：
      · system prompt 永远是 messages[0]，见 cloud.ts —— 用户输入改不动它
      · 单条输入 2000 字上限、只看最近 20 条上下文、前端再叠一层每日次数和连点间隔
      · 面板里必须写明「这是分身不是本人」，别在这里说不能外传的事
   ========================================================================== */

type Item = { kind: 'me' | 'them' | 'sys'; text: string }

/** 闲置多久才「开口」；开口后保持多久自己收回 */
const IDLE_MS = 45_000
const BLOOM_MS = 9_000

/* ── 右下角那个圆钮入口：已停用 ──────────────────────────────────────────
   2026-09-19 用户：「去掉右下角那个跟我聊聊」。
   停用的是**整个圆钮**（不是只把那行字去掉），因为一个不带字的 46px 小圆点
   没人知道那是干什么的 —— 留着比去掉更糟。入口还剩两个，都够用：
     · **点 3D 人物**（她会先卖萌再弹面板，主线入口）
     · 收尾板块「保持联系」里那张卡
   右下角那个胶囊本来就是接入包 chat-widget.js 的遗留物：第一屏之后一直贴在
   那儿，越往下看越像挂了个客服。

   ⚠️ 只停「渲染」，代码和样式都原地留着，恢复只要一步：
       把 ORB_ENTRY 改回 true。
      （外观相关的 CSS `.kc-orb*` 也保留在 styles.css 里，没删。）
   ⚠️ 连带停用：**「闲置 45 秒 → 自己开口」**。那个行为本来只长在圆钮上
      （展开成「无聊了？聊两句」），圆钮没了就没有载体 —— 见下面那个 useEffect
      的守卫。想把它挪到别处（比如面板头像）是另一件事，别顺手改。
   ⚠️ 别把 COPY.orbLabel / bloomLabel 删掉：文案集中管理，哪天回来还要用。 */
const ORB_ENTRY = false
/** 面板里最多留几轮，超过就把最老的对话行丢掉（发给模型的另有 maxHistory 限制） */
const MAX_ITEMS = 60

export default function AvatarChat({ visible }: { visible: boolean }) {
  const [open, setOpen] = useState(false)
  const [bloom, setBloom] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /* 发失败时把她刚打的字留下来 —— 网络抖一下（或她刚去改完代理）之后，
     不该让人重新打一遍。见 .kc-note 里的「重试」。null = 不给重试入口。 */
  const [retryText, setRetryText] = useState<string | null>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<AbortController | null>(null)
  const greetedRef = useRef(false)
  const bloomedRef = useRef(false)
  const lastSentRef = useRef(0)
  const convRef = useRef<string>('')

  /* ── 打开 / 收起 ───────────────────────────────────────────────────── */
  const openPanel = useCallback(() => {
    setOpen(true)
    setBloom(false)
    bloomedRef.current = true // 手动开过一次，就不再主动「开口」了
  }, [])

  /* 「点她」走这条：她先卖萌，620ms 之后面板才浮上来。
     ⚠️ 为什么延迟必须在这个组件里做（而不是 chat/open.ts 或 Scene）：
        ① 点她会触发一次父组件 setState，Scene 的 3D 子树会被卸载重挂，
           挂在那边组件里的定时器会在 cleanup 里被清掉 → 面板永远不弹
           （那次的现象就是"点了有反应，但窗口不出来"）；
        ② 「这 620ms 里用户接着往下滚了 → 就别弹了」这个判断得和面板的
           open 状态是同一个事实，和打开动作放在一起才不会各说各话。
     这个组件挂在最外层，只在 visible 变化时重渲染，不会被 3D 子树带着重挂。 */
  const soonRef = useRef<number | null>(null)
  const openSoon = useCallback(
    (delay = 620) => {
      const off = () => {
        window.removeEventListener('wheel', drop, true)
        window.removeEventListener('touchmove', drop, true)
      }
      // 延迟窗口里用户滚了 → 这次作废（他已经往下看了，别突然糊一个面板上去）
      function drop() {
        if (soonRef.current !== null) window.clearTimeout(soonRef.current)
        soonRef.current = null
        off()
      }
      if (soonRef.current !== null) window.clearTimeout(soonRef.current)
      off() // 连点：旧的监听/计时都换成这一轮
      window.addEventListener('wheel', drop, { passive: true, capture: true })
      window.addEventListener('touchmove', drop, { passive: true, capture: true })
      soonRef.current = window.setTimeout(() => {
        soonRef.current = null
        off()
        openPanel()
      }, delay)
    },
    [openPanel],
  )
  useEffect(
    () => () => {
      if (soonRef.current !== null) window.clearTimeout(soonRef.current)
    },
    [],
  )

  // 两个入口都在这个事件上：圆钮 / 收尾那张卡（立刻开），点她（延迟开）
  useEffect(() => {
    const onNow = () => openPanel()
    const onSoon = () => openSoon()
    window.addEventListener(CHAT_OPEN_EVENT, onNow)
    window.addEventListener(CHAT_OPEN_SOON_EVENT, onSoon)
    return () => {
      window.removeEventListener(CHAT_OPEN_EVENT, onNow)
      window.removeEventListener(CHAT_OPEN_SOON_EVENT, onSoon)
    }
  }, [openPanel, openSoon])

  // 滚回影片里 / 还没滚到 → 收起来，别压在影片上
  useEffect(() => {
    if (!visible) {
      setOpen(false)
      setBloom(false)
    }
  }, [visible])

  // Esc 收起
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /* 面板开着的时候继续滚鼠标 → 面板自己收起来（2026-09-19 用户要求）。
     为什么用 wheel/touchmove 而不是 scroll：面板是 fixed，滚页面时它是不会产生
     scroll 事件的，但 wheel 一定收得到 —— 而且它比 scroll 早，能配合下一屏的内容。
     ⚠️ 必须豁免「在面板内部滚」：聊天记录长了要在 .kc-log 里翻，那一下不该把面板关掉。
     触屏同理（在面板里滑聊天记录不算）。 */
  useEffect(() => {
    if (!open) return
    const inPanel = (t: EventTarget | null) =>
      !!panelRef.current && !!t && panelRef.current.contains(t as Node)
    const onWheel = (e: WheelEvent) => {
      if (inPanel(e.target)) return
      setOpen(false)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (inPanel(e.target)) return
      setOpen(false)
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchmove', onTouchMove)
    }
  }, [open])

  /* 第一次打开：先自我介绍一句（文案在 config.ts），并focus 输入框 */
  useEffect(() => {
    if (!open) return
    if (!greetedRef.current) {
      greetedRef.current = true
      convRef.current = getConversationId()
      setItems((v) =>
        v.length ? v : [{ kind: 'them', text: COPY.greeting }, { kind: 'sys', text: COPY.sysOpen }]
      )
    }
    const t = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [open])

  /* ── 闲置 45 秒 → 开口一次 ───────────────────────────────────────────
     任何输入都会重置计时；开过口（bloomedRef）之后不再开口。
     mousemove 单独限流，不然它一个人就把计时器踹得停不下来。 */
  useEffect(() => {
    if (!ORB_ENTRY) return // 圆钮停用 → 「开口」没有载体（见 ORB_ENTRY 注释）
    if (!visible || open || bloomedRef.current) return
    let idleTimer: number | undefined
    let closeTimer: number | undefined
    const arm = () => {
      window.clearTimeout(idleTimer)
      window.clearTimeout(closeTimer)
      setBloom(false)
      idleTimer = window.setTimeout(() => {
        if (bloomedRef.current) return
        bloomedRef.current = true
        setBloom(true)
        closeTimer = window.setTimeout(() => setBloom(false), BLOOM_MS)
      }, IDLE_MS)
    }
    const events: (keyof WindowEventMap)[] = ['scroll', 'wheel', 'keydown', 'pointerdown', 'touchstart']
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }))
    let lastMove = 0
    const onMove = () => {
      const now = Date.now()
      if (now - lastMove < 1000) return
      lastMove = now
      arm()
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    arm()
    return () => {
      window.clearTimeout(idleTimer)
      window.clearTimeout(closeTimer)
      events.forEach((e) => window.removeEventListener(e, arm))
      window.removeEventListener('mousemove', onMove)
    }
  }, [visible, open])

  /* 新内容进来就把对话滚到底 */
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  /* 输入框跟着字数长高（最高 110px，再高就自己滚） */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`
  }, [input])

  /* ── 发送 ────────────────────────────────────────────────────────────
     `raw` 只给「重试」按钮用：把上次发失败那句原样再发一次，
     不用让她重新打。正常提交走 input。 */
  const send = useCallback(async (raw?: string) => {
    const text = (raw ?? input).trim()
    if (busy || !text) return
    if (!convRef.current) convRef.current = getConversationId()

    // 前端这三道闸（真正的配额在平台侧，超了会以 quota_ 回来）
    if (text.length > LIMITS.maxInput) {
      setNote('这条太长了，短一点发给我呀')
      return
    }
    if (Date.now() - lastSentRef.current < LIMITS.minGapMs) return
    if (turnsLeftToday() <= 0) {
      setNote('今天聊得有点多了，明天再来找我吧～')
      return
    }
    lastSentRef.current = Date.now()
    setNote(null)
    setRetryText(null)
    setInput('')

    /* 发给模型的上下文 = 界面上那些 me/them 行（sys 行只是给人看的提示，不进模型）。
       这样界面和历史永远是同一份，不会各说各话。 */
    const history: Turn[] = [
      ...items
        .filter((i) => i.kind !== 'sys')
        .map((i) => ({ role: i.kind === 'me' ? ('user' as const) : ('assistant' as const), content: i.text })),
      { role: 'user', content: text },
    ]
    const appended: Item[] = [
      { kind: 'me', text },
      { kind: 'them', text: '' },
    ]
    setItems((v) => [...v, ...appended].slice(-MAX_ITEMS))

    const ac = new AbortController()
    acRef.current = ac
    setBusy(true)
    try {
      const full = await streamReply({
        history,
        conversationId: convRef.current,
        signal: ac.signal,
        onDelta: (d) =>
          setItems((v) => {
            const n = v.slice()
            const last = n[n.length - 1]
            if (last && last.kind === 'them') n[n.length - 1] = { kind: 'them', text: last.text + d }
            return n
          }),
      })
      recordTurn()
      if (!full) {
        // 一个字都没回来：别留一个空气泡
        setItems((v) => {
          const n = v.slice()
          const last = n[n.length - 1]
          if (last && last.kind === 'them' && !last.text) n[n.length - 1] = { kind: 'them', text: '……刚才没接上，再说一次？' }
          return n
        })
      }
    } catch (e) {
      const msg = friendly(e)
      setItems((v) => {
        const n = v.slice()
        const last = n[n.length - 1]
        // 一个字都没吐出来 → 把那个空泡收掉，只留一行系统提示
        if (last && last.kind === 'them' && !last.text) n.pop()
        return n
      })
      if (msg) {
        setNote(msg)
        // 能重发的才给按钮 —— 额度用完 / 输入不合法那类，重发还是同一个结果
        setRetryText(isRetryable(e) ? text : null)
      }
    } finally {
      acRef.current = null
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [busy, input, items])

  const stop = useCallback(() => {
    acRef.current?.abort()
  }, [])

  const restart = useCallback(() => {
    acRef.current?.abort()
    setItems([{ kind: 'them', text: COPY.greeting }, { kind: 'sys', text: COPY.sysOpen }])
    convRef.current = resetConversation()
    setNote(null)
    setRetryText(null)
  }, [])

  /* 开发期钩子：headless 验收脚本靠它驱动（点不动按钮时用） */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__keiraChat = {
      open: openPanel,
      close: () => setOpen(false),
      send,
      state: () => ({ open, busy, items, note, visible, turnsLeft: turnsLeftToday() }),
    }
  }, [openPanel, send, open, busy, items, note, visible])

  return (
    <>
      {/* 右下角圆钮 —— 2026-09-19 停用（ORB_ENTRY 改回 true 即可恢复，见文件顶部的说明） */}
      {ORB_ENTRY && (
        <button
          type="button"
          className={`kc-orb${visible ? ' is-in' : ''}${bloom ? ' is-bloom' : ''}`}
          onClick={() => (open ? setOpen(false) : openPanel())}
          aria-expanded={open}
          aria-label={COPY.panelTitle}
          tabIndex={visible ? 0 : -1}
        >
          <span className="kc-orb-dot" aria-hidden="true" />
          <span className="kc-orb-label">{bloom ? COPY.bloomLabel : COPY.orbLabel}</span>
        </button>
      )}

      <div
        className={`kc-panel${open ? ' is-open' : ''}${visible ? '' : ' is-away'}`}
        role="dialog"
        ref={panelRef}
        aria-label={COPY.panelTitle}
        aria-hidden={!open}
      >
        <div className="kc-head">
          <div className="kc-head-text">
            <b>{COPY.panelTitle}</b>
            <span>{COPY.panelSub}</span>
          </div>
          <button type="button" className="kc-icon" onClick={restart} title="重新开始">
            ↻
          </button>
          <button type="button" className="kc-icon" onClick={() => setOpen(false)} aria-label={COPY.close}>
            ×
          </button>
        </div>

        <div className="kc-log" ref={logRef} aria-live="polite">
          {items.map((it, i) => (
            <div
              key={i}
              className={`kc-msg kc-${it.kind}`}
              data-streaming={busy && i === items.length - 1 && it.kind === 'them' ? '1' : undefined}
            >
              {it.text || <span className="kc-dots"><i /><i /><i /></span>}
            </div>
          ))}
        </div>

        {note && (
          <div className="kc-note">
            <span>{note}</span>
            {retryText && (
              <button
                type="button"
                className="kc-retry"
                onClick={() => send(retryText)}
                disabled={busy}
              >
                {COPY.retry}
              </button>
            )}
          </div>
        )}

        <form
          className="kc-form"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder={COPY.placeholder}
            maxLength={LIMITS.maxInput}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <button type="button" className="kc-send" onClick={stop}>
              {COPY.stop}
            </button>
          ) : (
            <button type="submit" className="kc-send" disabled={!input.trim()}>
              {COPY.send}
            </button>
          )}
        </form>

        <div className="kc-foot">
          这是她的分身，不是本人。别在这里说不能外传的事。
        </div>
      </div>
    </>
  )
}
