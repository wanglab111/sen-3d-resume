/* ============================================================================
   和 Keira 聊聊 · 前端配置
   ----------------------------------------------------------------------------
   ⚠️ 这里**只允许**放前端公开的东西。任何 `sk-` 开头的模型 key 都不许出现在
      这个目录里 —— 所以本站没有自建后端、也不走 Node 代理，而是用 WorkBuddy
      云服务的「免密钥通道」：前端只持有 endpoint + publishableKey，
      真正的模型凭据在服务端，前端拿不到也不需要。

   publicConfig 来自 2026-09-19 为**这个站**（应用「3D 简历主页」，
   wbapp_D7DvVInXMcsopSYmDNfo0y）开通的云服务环境：
     · endpoint       该应用的发布域名，也就是这个站自己的域名
     · publishableKey 只标识「哪个应用」，本身不含权限；
                      安全性由服务端按 Origin 精确匹配提供，可以打进前端产物
   ⚠️ endpoint 必须跟着 publicConfig 走：如果哪天这个站换到别的域名发布，
      endpoint 要一起换，否则数据面请求会打到旧域名上、被 Origin 校验拒掉
      （现场表现是跨域预检失败，很难归因）。
   ========================================================================== */
import SYSTEM_PROMPT_RAW from './system-prompt.txt?raw'

export const PUBLIC_CONFIG = {
  endpoint: 'https://sen-3d-resume.app.workbuddy.host',
  publishableKey: 'wbpk_D7DvVInXMcsopSYmDNfo0y_3PGNP9HgUhrfNIIyiBXsT7YaJloRWdgf',
}

/* ── 人格本体 ────────────────────────────────────────────────────────────
   `system-prompt.txt` 是**原样**从接入包里拷过来的（md5
   27f649f4fb1e75a9422b9cc66e4a1fc5，8408 字节），一个字都没改、没总结、没删减。
   它必须以 messages[0] 的身份发给模型，且**不能被用户输入覆盖** ——
   用户输入只进 user 消息，见 cloud.ts 的 streamReply。
   ⚠️ 别在这个文件里「顺手优化」措辞：改了就不再是她的分身了。
   ⚠️ 用 ?raw 引入而不是复刻成 .ts 字符串：改动 diff 时能直接看见人格文件的原文差异。 */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_RAW.trim()

/* ── 硬性上限（接入包 README 的「别省」清单）──────────────────────────────
   README 要求「限流必须有：40 次 / IP / 天、单条输入 2000 字」。
   自建后端时这三条由 backend-node.js 在服务端执行；本站没有自己的后端，
   真正的配额在**平台侧**（超了会返回 quota_ 错误，见 cloud.ts 的兜底文案）。
   下面是前端这一层能做的三件事，方向和 README 一致、比 40 次更保守一点：
     · maxInput     单条输入上限，超了不发出去
     · maxHistory   只带最近 20 条上下文（README 第 4 条）
     · dailyTurns   单浏览器一天的发消息次数上限，存 localStorage
     · minGapMs     连点间隔，挡住「按住回车猛发」
   ⚠️ 这些只是防手滑，**不是安全边界** —— 真要防刷只能在服务端做。 */
export const LIMITS = {
  maxInput: 2000,
  maxHistory: 20,
  dailyTurns: 30,
  minGapMs: 900,
  /** 单次回复上限，和接入包 README 的「最大输出 800 token」一致 */
  maxTokens: 800,
}

/* ── 界面文案 ────────────────────────────────────────────────────────────
   全部集中在这里，改词只动这一处。
   基调跟着站点走（2026-09-18 用户：不要装、不要油腻）：
   入口说的是**一句人话**，不是「AI 助手」「智能客服」那套。 */
export const COPY = {
  /** 常驻的小圆钮：悬停/聚焦时展开成这个标签 */
  orbLabel: '跟我聊聊',
  /** 闲置够久时才「开口」的那一句 —— 就是字面上的「无聊的时候」 */
  bloomLabel: '无聊了？聊两句',
  panelTitle: '和 Keira 聊聊',
  panelSub: '她的语气、她的想法，但不是她本人。',
  /**
   * 面板里**她说的第一句**（也是每次重置后的开场白）——
   * 2026-09-19 用户定稿：「Hi，很高兴和你聊天~」。
   * 基调：当面打招呼，不是客服话术。「嗨，怎么啦？」那种"我在等你开口"的姿态
   * 会把人往回推——现在这句是先伸手，随后的 sysOpen 再补"这是分身不是本人"。
   */
  greeting: 'Hi，很高兴和你聊天~',
  /** 面板里的首条系统提示（对应 README「页面上要写明：这是分身不是本人」） */
  sysOpen: '这是她的分身，不是本人。对话会经过大模型，别在这里说不能外传的事。',
  placeholder: '说点什么吧…',
  send: '发送',
  sending: '…',
  /** 生成中时按钮变成这个，点了就中断（对应 README 的「可中断」） */
  stop: '停',
  /** 发失败时挂在提示语后面的重试入口（把上一条原样再发一次） */
  retry: '重试',
  close: '收起',
} as const

/* ── 收尾板块那张卡（Contact.tsx 用）──────────────────────────────────── */
export const CONTACT_CARD = {
  label: 'AI 分身',
  value: '无聊了，聊两句 ↗',
}
