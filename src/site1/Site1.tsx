import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BEATS,
  DRIFT,
  EXIT_MS,
  FRAME_COUNT,
  FRAME_SET,
  SEG_VH,
  frameSrc,
  stepDuration,
} from './stops'
import { flashAt, setSite1Height } from './anchor'
import { useStopSnap } from './snap'

/* ==================================================================
   网站1 —— 滚动擦洗开场（4 个停留界面，一格一站）
   ------------------------------------------------------------------
   机制一句话：
     一站 = 一屏高。u = 已滚距离 / 一屏高（0 … N-1）就是连续的「站进度」，
     帧号 = 相邻两站之间线性插值，整数处就是停留点。
   轨道高 400vh，里面 100vh 的舞台 position:sticky 钉在视口上。

   ⚠️ 滚轮不是自由滚动：snap.ts 会接管，一次滑动 = 直接走一站。
      `u` 仍然连续 —— 接管只是把「停下来」的位置钉在整数站上，
      中间那段滚动过程就是在把影片这一段放给用户看。

   为什么用「帧序列」而不是 <video> + currentTime：
     浏览器 seek 受关键帧间隔限制，滚动时会抖、会闪黑帧。
     预先拆成等间隔独立图片、直接 drawImage 才真的跟手。
   （本机没有 ffmpeg，帧是 _tools/extract_frames.cjs 用 Chrome 的解码器抽的。）

   ⚠️ 帧号写死在 stops.ts；改停留点只改那个文件，这里不用动。
   ================================================================== */

const N = BEATS.length
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

export default function Site1({ onHeight }: { onHeight?: (h: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /* 封面「浮动」用的**人物贴片**（2026-09-18 用户第二次纠偏：
     「不是首图在动，太唐了，是只有首图里的人在动」）。
     一开始的写法是给整张画面（.s1-poster / .s1-canvas）加位移+缩放 —— 那是"整幅画在晃"，
     画面边界、黑底、四角都跟着动，一眼就假。
     现在这层 canvas 与主画布**同一帧、同一套 fit / 底垫 / 压暗**（逐像素一致），
     再用 CSS mask 只露出人物那一块，位移只作用在它身上 →
     画面边界一动不动，只有人在呼吸。细节见 styles.css 的 .s1-float。 */
  const floatRef = useRef<HTMLCanvasElement>(null)
  const beatRefs = useRef<(HTMLDivElement | null)[]>([])
  const cueRef = useRef<HTMLDivElement>(null)
  // 交接段的白光（末站 → 网站2 那一下）。⚠️ 它挂在 .s1-stage **外面**，见 tick 里的说明。
  const flashRef = useRef<HTMLDivElement>(null)
  const [posterGone, setPosterGone] = useState(false)
  const [ready, setReady] = useState(false)

  /* 2026-09-18：配乐整套删掉了（用户「我把声音去掉了」）。
     原先这里有 Audio 对象 + 淡入淡出 + 右上角开关按钮（默认关）+ 滑出视野自动停，
     全部移除 —— 现在这条片子是无声的，纯靠画面。 */

  // —— 滚动几何：「一格一站」控制器要的那些位置 ——
  // 轨道顶一般就是文档顶（网站1 是第一个 section），但别写死 0，从 DOM 量。
  const baseY = () => {
    const t = trackRef.current
    return t ? t.getBoundingClientRect().top + window.scrollY : 0
  }
  // 一站一屏；越过末站之后再走一屏，网站1 的底边就贴住视口顶 = 网站2 首屏
  const stationY = (i: number) => baseY() + i * window.innerHeight
  const exitY = () => baseY() + N * window.innerHeight
  const snap = useStopSnap({
    base: baseY,
    count: N,
    stationY,
    exitY,
    duration: stepDuration,
    exitMs: EXIT_MS,
  })

  // 运行时状态（不参与渲染，避免每帧 setState）
  const rt = useRef({
    progress: 0,
    frame: 0,
    beat: 0,
    lastFrame: -1,
    numText: '',
    sizes: new WeakMap<Element, string>(),
    needSize: true,
    drawnAtLeastOnce: false,
    loaded: 0,
    // 交接段（末站 → 网站2）的三个量，-1 = 还没写过，保证第一帧一定写一次
    exitFade: -1,
    exitZoom: -1,
    exitFlash: -1,
    // 封面浮动是否正在生效（用于「最后一帧把它归零」）
    driftOn: false,
  })

  // 预载帧序列。**两套**（桌面 1600×900 JPEG ≈ 11MB / 手机 1080×608 WebP ≈ 2.4MB），
  // 由 `stops.ts` 的 FRAME_DIR 按真实像素需求二选一，这里只认 `frameSrc(i)`
  // —— 手机上首次打开少下 8.6MB，这是「手机打开要转很久圈」的根因，画面本身没改。
  // 本地是瞬时的；真机上会边滚边补齐（没准备好的帧就保持上一帧，不闪黑）。
  // ⚠️ 2026-11-03：**不能 189 张一起发**。GitHub Pages（Fastly CDN）对单域突发
  //   189 个请求会整批挂起 —— 实测 T+60s 一个都没回（frameDone=0），而且同一条
  //   HTTP/2 连接上的 glb/hdr 流也被压在后面，useProgress 卡死 → loading 屏 164s。
  //   改成小并发队列按序拉：f000 最先就绪（ready 一到就撤 s1-loading），其余边滚
  //   边补 —— paint() 对未就绪帧本来就返回 false 保持上一帧，快速滚动也不闪黑。
  const frames = useMemo(() => {
    const rtNow = rt.current
    const arr: HTMLImageElement[] = []
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image()
      img.decoding = 'async'
      arr.push(img)
    }
    const CONCURRENCY = 4
    let next = 0
    let done = 0
    const start = (i: number) => {
      const img = arr[i]
      img.onload = () => {
        rtNow.loaded++
        if (i === 0) setReady(true)
        done++
        pump()
      }
      // 失败也要放行队列 —— 一张坏帧不能卡死后面全部
      img.onerror = () => {
        done++
        pump()
      }
      img.src = frameSrc(i)
    }
    const pump = () => {
      while (next < FRAME_COUNT && next - done < CONCURRENCY) start(next++)
    }
    pump()
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 把「本站占掉的高度」报出去 —— 网站2 的滚动阈值靠这个值往回退。
  // 两条路都走：
  //   · setSite1Height → 模块里的 motion value，给非 React 的读者（Scene 的 useFrame）
  //   · onHeight       → App 的 useState，让 App 重渲染一次，把 React 侧的 transform
  //                      一起刷新。只写模块变量是不够的 —— 详见 anchor.ts 顶部那段：
  //                      父组件的订阅是在子组件的 layout effect **之后**才挂上的。
  // ⚠️ 必须用 useLayoutEffect（首次绘制之前）：首屏闪一下那圈画框就是晚一帧的代价。
  useLayoutEffect(() => {
    const t = trackRef.current
    if (!t) return
    const report = () => {
      const h = t.offsetHeight
      setSite1Height(h)
      onHeight?.(h)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(t)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [onHeight])

  // 主循环
  useEffect(() => {
    const track = trackRef.current
    const cvs = canvasRef.current
    const stage = stageRef.current
    if (!track || !cvs || !stage) return
    const ctx = cvs.getContext('2d', { alpha: false })
    if (!ctx) return

    // 舞台尺寸变了才重建画布（重建会清空内容，所以用 needSize 标记）
    const ro = new ResizeObserver(() => {
      rt.current.needSize = true
      // 尺寸变了必须重画一次：帧号不一定变（只拖窗口、不滚动），而 mask 的几何、
      // 底垫尺寸全都是按画布尺寸算的 —— 不重画就会停在旧比例上
      rt.current.lastFrame = -1
    })
    ro.observe(stage)

    const fit = (W: number, H: number, iw: number, ih: number) => {
      // 宽屏：cover（铺满，四周裁一点）
      if (W / H >= 1.15) {
        const s = Math.max(W / iw, H / ih)
        return { dw: iw * s, dh: ih * s }
      }
      // 竖屏：**不能 cover** —— 1600×900 硬 cover 到 390×844 只会裁出画面中间 26%，
      // 手机上就是一只巨大的眼睛，什么都看不出来。
      // 做法改成"填充宽 + 1.35 倍轻裁"，得到一条 16:9 的横带（画面上下的空档由
      // paint() 里的模糊底垫住，见那里）。
      const s = (W / iw) * 1.35
      return { dw: iw * s, dh: ih * s }
    }
    // 模糊底垫用的标准 cover 铺满
    const fitCover = (W: number, H: number, iw: number, ih: number) => {
      const s = Math.max(W / iw, H / ih)
      return { dw: iw * s, dh: ih * s }
    }

    /* 竖屏的"模糊底垫"缓存。
       ------------------------------------------------------------------
       一开始竖屏只是"横带居中 + 上下留黑"，结果 844px 高的屏里只有 296px 有画面，
       上下 65% 是纯黑 —— 文字量出来的背景亮度是 0.002（等于没有背景）。
       现在把同一帧按 cover 画进一张 1/64 大小的小画布，再放大铺满整屏当底：
       小画布本来就毫无细节，放大后天然就是虚化，**不需要 ctx.filter（省掉全屏模糊的开销）**。

       ⚠️ 为什么是 1/64 而不是 1/24：底垫是 cover（只剩中间 ~26% 宽）、横带是 1.35 倍轻裁，
       两者取景范围根本对不上，交界处必然有一条缝。缝没法彻底消掉（要对齐就得把底垫拉伸变形），
       但可以**让它退成一层色调**：1/24 时底垫还能看出人形，缝就是"内容错位"；
       1/64 之后底垫只剩这帧的色块（绿野 / 雾灰 / 暗红），缝就只是深浅变化，读起来像刻意的画框。
       配 0.42 的压暗，横带仍然是画面上唯一清晰、唯一亮的区域。
       （试过用 12 条渐变把缝"揉开"，反而糊出可见的横条纹，别走那条路。） */
    const blurCache = new Map<number, HTMLCanvasElement>()
    const backdrop = (fi: number, img: HTMLImageElement) => {
      const bw = Math.max(8, Math.round(cvs.width / 64))
      const bh = Math.max(8, Math.round(cvs.height / 64))
      let bc = blurCache.get(fi)
      if (!bc) {
        bc = document.createElement('canvas')
        bc.width = bw
        bc.height = bh
        const bx = bc.getContext('2d')
        if (!bx) return null
        const c = fitCover(bw, bh, img.naturalWidth, img.naturalHeight)
        bx.drawImage(img, (bw - c.dw) / 2, (bh - c.dh) / 2, c.dw, c.dh)
        if (blurCache.size > 260) blurCache.clear()
        blurCache.set(fi, bc)
      }
      return bc
    }

    const paint = (fi: number) => {
      const img = frames[fi]
      // 没加载好就保持上一帧 —— 直接清屏会闪一下黑
      if (!img || !img.complete || !img.naturalWidth) return false
      const fcv = floatRef.current
      const fctx = fcv ? fcv.getContext('2d') : null
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssW = stage.clientWidth
      const cssH = stage.clientHeight
      if (rt.current.needSize || cvs.width !== Math.round(cssW * dpr)) {
        cvs.width = Math.max(1, Math.round(cssW * dpr))
        cvs.height = Math.max(1, Math.round(cssH * dpr))
        if (fcv) {
          fcv.width = cvs.width
          fcv.height = cvs.height
        }
        rt.current.needSize = false
        blurCache.clear() // 尺寸变了，缓存的底垫也得重做
      }
      const { dw, dh } = fit(cvs.width, cvs.height, img.naturalWidth, img.naturalHeight)
      const portrait = cvs.width / cvs.height < 1.15
      // 竖屏的横带整体略高于中线（0.46）—— 下面要给文字留出地方；
      // 宽屏是 cover（图比画布高或等高），居中就行，别动。
      const oy = portrait ? (cvs.height - dh) * 0.46 : (cvs.height - dh) / 2
      const dx = (cvs.width - dw) / 2

      const render = (c: CanvasRenderingContext2D, w: number, h: number, clear: boolean) => {
        c.imageSmoothingEnabled = true
        c.imageSmoothingQuality = 'high'
        if (clear) c.clearRect(0, 0, w, h)
        if (portrait) {
          // 竖屏：模糊底垫 → 压暗 → 清晰横带
          const bc = backdrop(fi, img)
          if (bc) c.drawImage(bc, 0, 0, w, h)
          else {
            c.fillStyle = '#06080d'
            c.fillRect(0, 0, w, h)
          }
          c.fillStyle = 'rgba(4, 7, 12, 0.42)'
          c.fillRect(0, 0, w, h)
        }
        c.drawImage(img, dx, oy, dw, dh)
      }

      render(ctx, cvs.width, cvs.height, false)

      /* 人物贴片：与主画布逐像素一致的一份复制。
         ⚠️ 必须画**同一帧 + 同一套 fit/底垫/压暗** —— 只要有一点不一样（比如少画那层
           0.42 的压暗），贴片就会在画面上显出一块偏亮的补丁。
         ⚠️ 只在封面浮动生效时才画（rt.driftOn）：滚起来之后每帧两次全屏 drawImage
           是白扔的性能，而那时位移已经衰减到看不出来。 */
      if (fctx && fcv && rt.current.driftOn) render(fctx, fcv.width, fcv.height, true)

      /* 人物重心（相对画布宽高的百分比）——CSS 侧 .s1-float 拿它当 transform-origin，
         缩放时以人为中心。0.49 / 0.53 是在 f000 上量出来的亮部重心
         （面部 + 两只张开的手，亮部几乎铺满整帧，重心略低于画面中心）。
         mask 本身用不到它：那层是上下线性羽化，参数固定，见 styles.css。 */
      stage.style.setProperty('--float-cx', `${((dx + 0.49 * dw) / cvs.width * 100).toFixed(3)}%`)
      stage.style.setProperty('--float-cy', `${((oy + 0.53 * dh) / cvs.height * 100).toFixed(3)}%`)
      return true
    }

    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const vh = window.innerHeight
      const top = track.getBoundingClientRect().top + window.scrollY
      const range = Math.max(1, track.offsetHeight - vh)
      const p = clamp01((window.scrollY - top) / range)
      rt.current.progress = p

      // —— 滚动位置 → 帧号 ——
      // u = 连续的「站进度」：0 = 第 1 站，N-1 = 末站，整数处就是停留点。
      // 相邻两站之间**线性**插值：过场动画本身有 easeInOutCubic，
      // 这里再加一层缓动就会「一顿一顿」的，影片要匀速播才像片子。
      const u = p * (N - 1)
      const bi = Math.min(N - 2, Math.max(0, Math.floor(u)))
      const local = Math.min(1, Math.max(0, u - bi))
      const f0 = BEATS[bi].frame
      const f1 = BEATS[bi + 1].frame
      const fi = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(f0 + (f1 - f0) * local)))
      rt.current.frame = fi
      rt.current.beat = Math.round(u)
      if (fi !== rt.current.lastFrame) {
        if (paint(fi)) {
          rt.current.lastFrame = fi
          if (!rt.current.drawnAtLeastOnce) {
            rt.current.drawnAtLeastOnce = true
            setPosterGone(true)
          }
        }
      }

      // —— 文案显隐 ——
      // 窗口必须**互不重叠**：两句话都停在左下角同一个位置，
      // 只要有一小段同时半透明，看上去就是两行字叠在一起（糊成一坨）。
      // 所以：到站前 0.36 站开始淡入、前 0.14 站全亮；离站 0.14 站开始淡出、0.36 站全灭。
      // 中间 u≈0.5 那一段一句都没有 —— 纯画面，让影片自己说话。
      /* 交接段的进度（末站再往下滚一屏 = 0→1）。
         这里是"提前算一份"：下面末站那句文案要在**白光冲顶之前**就退干净，
         得用到它。真正的 e 在交接那一段还会再算一次（那边带着全部时序注释）。 */
      const e0 = clamp01((window.scrollY - (top + (N - 1) * vh)) / vh)
      for (let j = 0; j < N; j++) {
        const el = beatRefs.current[j]
        if (!el) continue
        const fin = sstep((u - (j - 0.36)) / 0.22)
        /* 末站不回淡出：那句话要一直留到网站1 滚走。
           但"滚走"这一步在交接段里是**先被白光吃掉**的 —— 所以它自己也要提前退场：
           e 0.04→0.20 之间收干净，正好在白光冲顶（e=0.18）前后。
           ⚠️ 不这么做的话，画面上会出现"光已经糊满整屏、那句『光散下去』还浮在光里"
              —— 语义正好说反，而且字在半透明白光上是脏的。 */
        const fout =
          j === N - 1
            ? 1 - sstep((e0 - 0.04) / 0.16)
            : 1 - sstep((u - (j + 0.14)) / 0.22)
        const op = Math.min(fin, fout)
        const txt = op.toFixed(3)
        if (rt.current.sizes.get(el) !== txt) {
          rt.current.sizes.set(el, txt)
          el.style.opacity = txt
          // 只在真的可见时才让它参与命中/无障碍树
          el.style.visibility = op > 0.01 ? 'visible' : 'hidden'
        }
      }

      // —— 封面「浮动」——
      // 停在第 1 站时画面是一张静止的帧，太死。叠一层极慢的呼吸式微动（用户：要有灵性）。
      // 三个**不同周期**的正弦分别驱动 缩放 / 上下 / 左右 —— 同周期会像钟摆一样机械。
      // ⚠️ 现在驱动的是 **.s1-float 那一层人物贴片**，不是整张画面（用户：「不是首图在动，
      //    太唐了，是只有首图里的人在动」）。CSS 里只有 .s1-float 读这几个变量。
      // ⚠️ 权重 w：只在封面附近生效，离开第 1 站就归零，否则过场时"影片在播 + 人物在漂"
      //    两件事叠在一起会抖。near 那一项让它在「停在整数站」时最强、过场中降到 40%，
      //    避免起步/落定那一瞬间突然开始漂或突然停住。
      const near = 1 - clamp01(Math.abs(u - Math.round(u)) / 0.5)
      const w = (1 - sstep(u / 0.6)) * (0.4 + 0.6 * near)
      const on = w > 0.001
      if (on) {
        const t = performance.now() / DRIFT.period
        const ds = 1 + DRIFT.scale * Math.sin(t * Math.PI * 2)
        const dy = DRIFT.y * Math.sin(t * Math.PI * 2 + 0.7)
        const dx = DRIFT.x * Math.sin(t * Math.PI * 2 * 0.73 + 1.9)
        stage.style.setProperty('--float-s', (1 + (ds - 1) * w).toFixed(5))
        stage.style.setProperty('--float-y', `${(dy * 100 * w).toFixed(3)}%`)
        stage.style.setProperty('--float-x', `${(dx * 100 * w).toFixed(3)}%`)
        stage.style.setProperty('--float-o', '1')
      } else if (rt.current.driftOn) {
        // 位移先归零、透明度再淡出（CSS transition）—— 两件事都在它已经和底图重合之后发生
        stage.style.setProperty('--float-s', '1')
        stage.style.setProperty('--float-y', '0%')
        stage.style.setProperty('--float-x', '0%')
        stage.style.setProperty('--float-o', '0')
      }
      /* 开关变了就立刻补画一次。
         ⚠️ 必须补：paint 平时只在**帧号变化**时跑，而"停在第 1 站"时帧号是不变的
            —— 不补这一下，贴片永远是空画布（浮动就完全没效果）。 */
      if (on !== rt.current.driftOn) {
        rt.current.driftOn = on
        paint(rt.current.frame)
      }

      // —— 交接段：光环「砰」地一下，把画面交给网站2 ——
      // 位置 = 末站（top + (N-1)*vh，就是 p=1 那一点）再往下滚**一屏**，
      // 滚满时网站1 的底边贴住视口顶 = 网站2 首屏。用上面已经读到的 top，不再量一次 DOM。
      //
      // 这一段里同时发生四件事，全由 e（0→1）驱动 —— 跟手、可逆：
      //   · zoom  1 → 1.14：光环迎面放大 = 爆发
      //   · fade  1 → 0   ：影片**连同它那块不透明底色**整块散掉
      //   · flash 0 → 1 → 0：一层**均匀**的白光，把整个"消失过程"盖住
      //   · 网站2「浮现」：3D 场景 + 首屏文字 + 画框从光里一点点显出来
      //     （emerge，见 anchor.ts），**与白光严格互补** —— 两者相加恒为 1。
      // 顺序：白光先炸开（0.06~0.18）、影片在白光底下退场（0.22~0.46）、
      // 白光再散成薄雾并褪干净（0.26~1.00）；网站2 的份额 = 1 - 白光，全程守恒，
      // 所以读起来是**同一张画面在散雾**，而不是"两张画面互相切换"。
      //
      // ⚠️ flash 的曲线只在 anchor.ts 的 flashAt() 里定义一份，这里调用、不要重写：
      //    两边各写一条"差不多的"曲线就会出现中段空档（白已经淡了、网站2 还没出来），
      //    那就是用户看到的「分明的分界线」。
      // ⚠️ flash 那层是 position:fixed 而且**放在 .s1-stage 外面**，两个原因：
      //    ① 舞台是 sticky 的，末站之后再滚它整块随页面上移，闪光挂在里面会被"推着走"；
      //    ② 舞台这一帧要淡出（opacity → 0），闪光在里面会被一起淡掉，就白闪了。
      const e = clamp01((window.scrollY - (top + (N - 1) * vh)) / vh)
      const zoom = 1 + 0.14 * (1 - Math.pow(1 - clamp01(e / 0.5), 3))
      const fade = 1 - sstep((e - 0.22) / 0.24)
      const flash = flashAt(e)
      if (Math.abs(rt.current.exitZoom - zoom) > 0.002) {
        rt.current.exitZoom = zoom
        stage.style.setProperty('--exit-zoom', zoom.toFixed(4))
      }
      if (Math.abs(rt.current.exitFade - fade) > 0.003) {
        rt.current.exitFade = fade
        stage.style.setProperty('--exit-fade', fade.toFixed(4))
      }
      if (flashRef.current && Math.abs(rt.current.exitFlash - flash) > 0.003) {
        rt.current.exitFlash = flash
        flashRef.current.style.opacity = flash.toFixed(3)
      }

      // —— HUD ——
      // 页码「01 / 04」2026-09-18 去掉了（用户「去掉页码吧」）：它把开场变成了一份
      // 有章节编号的幻灯片，正是要避开的那种"用力"。底部那条进度条同日一起删了
      // （用户：「划到网页2 的时候有一条黄线」）—— 现在 HUD 只剩左下角一行署名。
      if (cueRef.current) {
        cueRef.current.style.opacity = (1 - sstep((u - 0.04) / 0.3)).toFixed(3)
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames])

  // 开发钩子：验收脚本靠它定位（#p=0.66 也能直接落到 66%）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const goTo = (p: number) => {
      const track = trackRef.current
      if (!track) return
      const top = track.getBoundingClientRect().top + window.scrollY
      const range = Math.max(1, track.offsetHeight - window.innerHeight)
      window.scrollTo({ top: top + clamp01(p) * range, behavior: 'instant' as ScrollBehavior })
    }
    ;(window as any).__site1 = {
      goTo,
      // ⚠️ 验收脚本要停在「非车站」的位置量数据时，必须走 seek —— 它会顺手关掉
      // 「一格一站」的接管（否则 260ms 后会被自动吸附回最近一站，量出来的全是车站）。
      seek: (p: number) => {
        snap.disable(true)
        goTo(p)
      },
      snapOn: () => snap.disable(false),
      snapOff: () => snap.disable(true),
      step: (d: 1 | -1) => snap.step(d),
      gotoStation: (i: number) => snap.seek(i),
      get animating() {
        return snap.isAnimating()
      },
      get progress() {
        return rt.current.progress
      },
      get frame() {
        return rt.current.frame
      },
      get beat() {
        return rt.current.beat
      },
      get station() {
        return Math.round(rt.current.progress * (N - 1))
      },
      get stations() {
        return N
      },
      get loaded() {
        return rt.current.loaded
      },
      get frames() {
        return FRAME_COUNT
      },
      /** 这一趟吃的是哪套帧：'desktop' | 'mobile'（验收脚本断言用） */
      get frameSet() {
        return FRAME_SET
      },
      trackTop: () => baseY(),
      stationY: (i: number) => stationY(i),
      exitY: () => exitY(),
      trackHeight: () => trackRef.current?.offsetHeight ?? 0,
    }
    const hash = /#s1p=([\d.]+)/.exec(window.location.hash)
    if (hash) goTo(Number(hash[1]))
    return () => {
      delete (window as any).__site1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="s1" ref={trackRef} style={{ height: `${SEG_VH * N}vh` }}>
      <div className="s1-stage" ref={stageRef}>
        {/* 首帧占位：帧序列就绪前先撑住画面，就绪后淡出（放在 canvas 之前，
            被 canvas 盖住，所以不会出现"先闪一块黑"的反向层叠） */}
        <img
          className={`s1-poster${posterGone ? ' is-gone' : ''}`}
          src={frameSrc(0)}
          alt=""
          aria-hidden="true"
        />
        <canvas className="s1-canvas" ref={canvasRef} aria-hidden="true" />
        {/* 人物贴片（封面浮动用）：与上面那张 canvas **同帧同 fit 的一份复制**，
            靠 CSS mask 只露出人。顺序很关键 —— 它必须在 .s1-canvas 之后（盖在上面）、
            在 .s1-vignette 之前（暗角要照常压它，否则人物会比周围亮一块）。 */}
        <canvas className="s1-float" ref={floatRef} aria-hidden="true" />

        {/* 全局暗角：把四周压一点，正文所在的中间调留亮（压太狠就白瞎了素材） */}
        <div className="s1-vignette" aria-hidden="true" />

        {BEATS.map((b, i) => (
          <div
            key={i}
            className={`s1-beat s1-beat--${b.align}`}
            data-beat={i}
            ref={(el) => {
              beatRefs.current[i] = el
            }}
            style={{
              // 每站自己的压暗强度：画面亮的那几站要多压一点才看得清字
              ['--veil' as string]: String(b.veil),
              opacity: i === 0 ? 1 : 0,
            }}
          >
            {/* 三个字段全空的站（首屏封面、末站光环）**整块不渲染** ——
                不是渲染一个空的 .s1-copy：那会留下一个看不见但吃布局的盒子，
                也会让"这一屏有没有字"在 DOM 里读不出来。 */}
            {(b.kicker || b.title || b.sub) && (
              <div className="s1-copy">
                {b.kicker && <span className="s1-kicker">{b.kicker}</span>}
                {b.title && <h2 className="s1-title">{b.title}</h2>}
                {b.sub && <p className="s1-sub">{b.sub}</p>}
              </div>
            )}
          </div>
        ))}

        {/* 第一屏的滚动提示：一个向下的箭头（2026-09-18 用户：「第一个界面的那个文字
            应该是向下的箭头」—— 原来是「向下滚动」四个字 + 一条下落的竖线，
            字比箭头"用力"，而且英文站面的调性里不该出现中文提示语）。
            箭头自己也在极慢地上下浮动，跟画面的呼吸同一套语汇（.s1-arrow 的动画）。 */}
        <div className="s1-cue" ref={cueRef} aria-hidden="true">
          <svg className="s1-arrow" viewBox="0 0 24 30" fill="none" aria-hidden="true">
            <path d="M12 1 V27" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path
              d="M3.5 19.5 L12 28 L20.5 19.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* HUD：左下角署名（页码已去掉，见 tick 里的说明） */}
        <div className="s1-hud" aria-hidden="true">
          <span className="s1-hud-brand">王一妍 · Keira </span>
        </div>
        {/* 底部那条 2px 的进度条 2026-09-18 删掉（用户：「划到网页2 的时候有一条黄线，
            不要那个黄线」）—— 它是站内唯一的高亮暖色（#ffd9b3 → 满格时就是横贯整屏的
            一道黄线），而且"开场看到第几格了"这件事本来也不该被展示出来。 */}

        {/* 帧还没来时给一点点反馈（本地几乎看不到） */}
        {!ready && (
          <div className="s1-loading" aria-hidden="true">
            <span />
          </div>
        )}
      </div>

      {/* 交接段的白光（「砰」的那一下）。
          ⚠️ 必须在 .s1-stage **外面**：舞台是 sticky 的，末站之后再滚它整块往上走，
          而且这一帧舞台本身要淡出 —— 闪光挂在里面会被"推着走"、还会被一起淡掉。
          fixed 在这里是安全的：.content 只有 position:relative，祖先没有 transform。 */}
      <div className="s1-flash" ref={flashRef} aria-hidden="true" />
    </section>
  )
}
