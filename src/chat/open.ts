/* 打开分身面板的**唯一入口**。
   为什么走事件而不是把 props 一路传下去：入口有两个 ——
     · 右下角那个圆钮（在 App 里，和收尾板块不是父子）
     · 收尾板块「保持联系」里的那张卡（在 Contact 里）
   两个入口和面板之间隔着好几层，为这一个动作穿 props 不划算。
   监听方只有一个（AvatarChat），所以用 DOM 自定义事件足够，也不用再引状态库。 */
export const CHAT_OPEN_EVENT = 'keira-chat:open'

export function openChat() {
  window.dispatchEvent(new Event(CHAT_OPEN_EVENT))
}

/* 「稍后再开」—— 点她 → 她先卖萌 → 面板再浮上来（延迟 620ms，见 AvatarChat）。
   ⚠️ 这里只负责**发信号**，延迟和取消都由 AvatarChat 自己管。
      为什么不在这个文件里 setTimeout：
        · 定时器放模块里没有生命周期，组件卸载也不会清（虽然现在不重挂，但是隐患）；
        · 更要紧的是"这次延迟要不要作废"必须和面板组件看到的是同一个事实 ——
          用户在这 620ms 里接着往下滚，就该**不弹**（2026-09-19 用户要求：
          "继续滑动鼠标的时候弹窗就消失"，这里是同一件事的提前量）。
          判定和副作用放在一起才不容易各说各话。 */
export const CHAT_OPEN_SOON_EVENT = 'keira-chat:open-soon'

export function openChatSoon() {
  window.dispatchEvent(new Event(CHAT_OPEN_SOON_EVENT))
}
