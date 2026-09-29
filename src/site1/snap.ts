import { useEffect, useRef } from 'react'

/* ==================================================================
   网站1 的「一格一站」控制器
   ------------------------------------------------------------------
   需求原话（2026-09-18）：「每一次轻轻滑动鼠标，就会直接到下一个停留点」。
   所以这里不是「让页面自由滚、停手再吸附」，而是**接管**滚动：
     · 滚轮：一次手势 = 一步
     · 触屏：手指拖动跟手（直接驱动滚动），松手按惯性预测落到最近一站
     · 键盘：↑↓ / PgUp/PgDn / 空格 换站，Home 回片头，End 跳过整部片子
   接管范围**只限影片还占着屏幕 75% 以上的时候**，出了这个范围一根手指都不碰 ——
   网站2 的滚动手感保持原样。

   两个关键实现选择：

   ① 手势边界靠事件间隔判断，不靠 delta 大小。
      触控板的惯性尾巴会连续吐几十个 wheel 事件（间隔 8~16ms），
      鼠标滚轮一格一个（间隔通常 >100ms）。所以「静了 GESTURE_GAP_MS 以上才算
      新的一次滑动」这一条，天然就把惯性吞掉了 —— 不需要额外的锁，
      也不会出现「一滑冲三站」。
   ② 自己写 rAF 滚动，不用 scrollTo({behavior:'smooth'})。
      一来平滑滚动的时长各浏览器不同、且没法跟着「这一段影片有多少帧」走；
      二来拿不到进度，没法在中途做别的事。

   ③ 过场**可以打断**（2026-09-18「滑动的每一下都要很丝滑和灵敏」）。
      原来动画期间的新手势一律丢弃 —— 连滑两下只走一站，读起来就是迟钝。
      现在分三种情况：
        · 动画刚开始 <240ms → 丢掉。这是**同一次手势的尾巴**（触控板惯性 / 手抖），
          不是用户的新意图；留着它才会出现「一滑冲三站」。
        · 剩余 >340ms → 立刻打断，从「当前正走向的那站」再往前一站。
          ⚠️ 起点必须用**动画的目标站** st.toIdx，不能用当前位置反推的 indexAt(y)：
             动画过半时 y 已经被吸入下一站的邻域，用 indexAt 会算出"已经到了"，
             再 +1 就冲过头。
        · 剩余 ≤340ms → 排队，落地后立刻接着走（避免最后几帧硬拐弯，那一下最顿）。
      时长也跟着**剩余距离**缩短（最短 260ms），打断时才不会显得拖。
   ⚠️ styles.css 里 `html{scroll-behavior:smooth}`，所以每一帧都必须显式
      `behavior:'instant'`，否则每次 scrollTo 自己又变成一段平滑动画。
   ================================================================== */

/** 手势间隔阈值（ms）：小于它的连续 wheel 事件视为同一次滑动 */
const GESTURE_GAP_MS = 110
/** 动画开始后这段时间内到达的手势 = 同一次滑动的尾巴，丢掉 */
const EARLY_MS = 240
/** 动画剩余不足这么久 → 不再打断，改成落地后排队执行 */
const TAIL_MS = 340
/** 打断后的最短时长：再短就成了跳切，中间那段影片等于没播 */
const MIN_INTERRUPT_MS = 260
/** 停在影片区域内、松手后多久没动静就校正到最近一站（应付拖滚动条 / 锚点跳转 / 刷新还原） */
const SETTLE_MS = 260

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

export interface SnapGeo {
  /** 网站1 轨道（那个 section）在文档里的顶部 y */
  base: () => number
  /** 共几站（含首屏那站） */
  count: number
  /** 越过末站之后落到哪（= 网站1 的底边贴住视口顶 = 网站2 首屏） */
  exitY: () => number
  /** 第 i 站对应的 scrollY */
  stationY: (i: number) => number
  /** 换站动画时长（ms） */
  duration: (from: number, to: number) => number
  /** 越过末站的固定时长（ms） */
  exitMs: number
}

export interface SnapApi {
  /** 手工走一步（+1 往下 / -1 往上），会带上过场动画 */
  step: (dir: 1 | -1) => void
  /** 直接停到第 i 站 */
  seek: (i: number) => void
  /** 正在过场动画里 */
  isAnimating: () => boolean
  /** 临时交出/收回控制权（验收脚本要能停在任意位置量数据） */
  disable: (v: boolean) => void
}

export function useStopSnap(geo: SnapGeo): SnapApi {
  const st = useRef({
    animating: false,
    raf: 0,
    lastWheel: 0,
    settle: 0,
    disabled: false,
    reduced: false,
    touch: null as null | { y0: number; y: number; scroll0: number; t0: number },
    // —— 可打断过场需要的三个量（见文件头 ③）——
    toIdx: 0, // 这次动画正走向第几站
    animStart: 0, // 这次动画的起始时刻
    animMs: 0, // 这次动画的总时长
    queued: 0 as 0 | 1 | -1, // 落地后要立刻接着走的方向
  }).current

  // 几何量每次都从 ref 读最新的：geo 里的函数是内联的，每次渲染都是新引用
  const gRef = useRef(geo)
  gRef.current = geo

  const inst = (y: number) =>
    window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })

  /** 落地后如果有排队的方向，立刻接着走（step 会重设 animStart，不会递归） */
  const drain = () => {
    const d = st.queued
    st.queued = 0
    if (d) step(d)
  }

  const anim = (to: number, ms: number) => {
    const from = window.scrollY
    const g = gRef.current
    st.animStart = performance.now()
    st.animMs = ms
    // 从「要滚到哪儿」反推目标站：打断时 step 要拿它当起点，否则会原地打转
    st.toIdx = clamp(Math.round((to - g.base()) / window.innerHeight), 0, g.count - 1)
    if (st.reduced || ms <= 0 || Math.abs(to - from) < 1) {
      cancelAnimationFrame(st.raf)
      st.animating = false
      inst(to)
      drain()
      return
    }
    cancelAnimationFrame(st.raf)
    st.animating = true
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = clamp((t - t0) / ms, 0, 1)
      /* easeInOutSine（不是原来的 easeInOutCubic）：
         cubic 的起步太"黏"—— 前 20% 只走了 0.8% 的距离，手指已经松开了画面还几乎没动，
         这正是「不灵敏」的来源。sine 的起步明显快、中段最顺、收尾一样柔和。 */
      const e = -(Math.cos(Math.PI * k) - 1) / 2
      inst(from + (to - from) * e)
      if (k < 1) st.raf = requestAnimationFrame(tick)
      else {
        st.animating = false
        st.raf = 0
        drain()
      }
    }
    st.raf = requestAnimationFrame(tick)
  }

  /** 离当前位置最近的一站 */
  const indexAt = (y: number) => {
    const g = gRef.current
    return clamp(Math.round((y - g.base()) / window.innerHeight), 0, g.count - 1)
  }

  /** 影片还占着屏幕 75% 以上 → 我们说话 */
  const inBand = (y = window.scrollY) => {
    const g = gRef.current
    const vh = window.innerHeight
    return y < g.base() + (g.count - 1) * vh + vh * 0.25
  }

  const step = (dir: 1 | -1) => {
    const g = gRef.current
    const y = window.scrollY
    const now = performance.now()
    /* 过场中又来一次手势（见文件头 ③）：
       刚开始不久 → 同一次滑动的尾巴，丢；快落地了 → 排队；其余 → 立刻打断往前走。 */
    if (st.animating) {
      const elapsed = now - st.animStart
      if (elapsed < EARLY_MS) return
      if (st.animMs - elapsed <= TAIL_MS) {
        st.queued = dir
        return
      }
    }
    // ⚠️ 打断时必须从「正走向的那站」算起，不能用 indexAt(y)（见文件头 ③）
    const cur = st.animating ? st.toIdx : indexAt(y)
    // 站在末站再往下 → 把整部片子交给网站2（走到网站1 的底边）
    if (dir > 0 && cur >= g.count - 1) {
      if (st.animating || y >= g.stationY(g.count - 1) - 2) anim(g.exitY(), g.exitMs)
      else anim(g.stationY(g.count - 1), g.duration(cur, g.count - 1)) // 还没站到末站，先站回去
      return
    }
    if (dir < 0 && cur === 0 && y <= g.base() + 2) return // 已经在片头，顶上没东西
    const to = clamp(cur + dir, 0, g.count - 1)
    const target = g.stationY(to)
    const full = g.duration(cur, to)
    // 打断时剩下的不是整屏 → 时长按距离缩，否则"只差一点点却要跑满全段"，反而拖
    const vh = window.innerHeight || 1
    const scale = clamp(Math.abs(target - y) / vh, 0.34, 1)
    anim(target, Math.max(MIN_INTERRUPT_MS, Math.round(full * scale)))
  }

  const seek = (i: number) => {
    const g = gRef.current
    const k = clamp(Math.round(i), 0, g.count - 1)
    st.queued = 0 // 直接定位 = 覆盖之前排队的那一步
    anim(g.stationY(k), 620)
  }

  useEffect(() => {
    st.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    /* deltaY 的三种单位：0=像素 / 1=行（Firefox 一格给 3） / 2=页。
       不归一化的话 Firefox 上 `deltaY=3` 会卡在「<2 不算一次滑动」的门槛外面。 */
    const norm = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
      return { dy: e.deltaY * k, dx: e.deltaX * k }
    }

    const onWheel = (e: WheelEvent) => {
      if (st.disabled || !inBand()) return
      const { dy, dx } = norm(e)
      // 横向手势（触控板两指左右滑）交给浏览器，别拿它换站
      if (Math.abs(dy) < 2 || Math.abs(dx) > Math.abs(dy)) return
      // 影片还在屏幕上 → 我们接管，不能让浏览器同时滚（否则两边抢，位置会飘）
      e.preventDefault()
      const now = performance.now()
      const gap = now - st.lastWheel
      st.lastWheel = now
      // ⚠️ 这里**不再** `if (st.animating) return` —— 那正是"连滑只走一站"的元凶。
      //    动画中该丢还是该打断，交给 step 里那三条规则判断。
      if (gap < GESTURE_GAP_MS) return // 同一次滑动的后续事件（含触控板惯性）→ 吞掉
      step(dy > 0 ? 1 : -1)
    }

    const onTouchStart = (e: TouchEvent) => {
      if (st.disabled || !inBand()) return
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      st.touch = { y0: t.clientY, y: t.clientY, scroll0: window.scrollY, t0: performance.now() }
      cancelAnimationFrame(st.raf)
      st.animating = false
      st.queued = 0 // 手指按下 = 新的意图，之前排队的那一步作废（手指要自己接管）
    }

    const onTouchMove = (e: TouchEvent) => {
      const T = st.touch
      if (!T) return
      // 手指拖动期间由我们驱动滚动（跟手），不交给浏览器 —— 不然松手时的吸附会打架
      e.preventDefault()
      T.y = e.touches[0].clientY
      const max = document.documentElement.scrollHeight - window.innerHeight
      inst(clamp(T.scroll0 + (T.y0 - T.y), 0, max))
    }

    const onTouchEnd = () => {
      const T = st.touch
      if (!T) return
      st.touch = null
      const g = gRef.current
      const vh = window.innerHeight
      const span = (g.count - 1) * vh
      const dy = T.y0 - T.y
      const dt = Math.max(1, performance.now() - T.t0)
      const v = dy / dt // px/ms
      const proj = window.scrollY + v * 200 // 惯性预测
      const from = indexAt(T.scroll0)
      const projIdx = clamp(Math.round((proj - g.base()) / vh), 0, g.count - 1)

      // 已经拖到「影片基本离场」的地方 → 直接送到网站2 首屏，别回吸
      if (window.scrollY - g.base() >= span + vh * 0.6) {
        anim(g.exitY(), 480)
        return
      }
      // 只是点了一下 / 原地动了动 → 回到最近一站
      if (Math.abs(dy) < 24) {
        anim(g.stationY(clamp(Math.round((window.scrollY - g.base()) / vh), 0, g.count - 1)), 420)
        return
      }
      /* 轻扫也要换站：方向说了算，跟「滚轮一格」同一条规则。
         惯性只用来在**同一方向**上多推几站（一次长长的拖动可以连过两站），
         不会因为预测过头而往回退。 */
      const dir = dy > 0 ? 1 : -1
      let to = from + dir
      to = dir > 0 ? Math.max(to, projIdx) : Math.min(to, projIdx)
      if (to > g.count - 1) {
        // 在末站再往上滑 → 交给网站2
        anim(g.exitY(), g.exitMs)
        return
      }
      to = clamp(to, 0, g.count - 1)
      anim(g.stationY(to), g.duration(from, to))
    }

    const onKey = (e: KeyboardEvent) => {
      if (st.disabled || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      const g = gRef.current
      const y = window.scrollY
      const k = e.key
      /* Home / End 是「跳过整部片子」的快捷键，所以**出了影片范围也接管** ——
         但必须各管一半，否则会往回滚：
           End  = 往片子外面走，已经在网站2 里（y ≥ 交班点）就别插手，交给浏览器去文档底；
           Home = 往片子开头走，已经在片头了就别插手。 */
      if (k === 'End') {
        if (y >= g.exitY() - 2) return
        e.preventDefault()
        anim(g.exitY(), g.exitMs)
        return
      }
      if (k === 'Home') {
        if (y <= g.base() + 2) return
        e.preventDefault()
        anim(g.base(), 620)
        return
      }
      if (!inBand()) return
      if (k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Spacebar') {
        e.preventDefault()
        step(1)
      } else if (k === 'ArrowUp' || k === 'PageUp') {
        e.preventDefault()
        step(-1)
      }
    }

    // 拖滚动条 / 锚点跳转 / 刷新还原之后，落在两站中间的话校正回最近一站
    const onScroll = () => {
      if (st.disabled || st.animating || st.touch) return
      window.clearTimeout(st.settle)
      st.settle = window.setTimeout(() => {
        if (st.disabled || st.animating || !inBand()) return
        const g = gRef.current
        const want = g.stationY(indexAt(window.scrollY))
        if (Math.abs(window.scrollY - want) > 3) anim(want, 420)
      }, SETTLE_MS)
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onTouchEnd, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(st.raf)
      window.clearTimeout(st.settle)
    }
    // 全部走 ref，订阅只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    step,
    seek,
    isAnimating: () => st.animating,
    disable: (v: boolean) => {
      st.disabled = v
    },
  }
}
