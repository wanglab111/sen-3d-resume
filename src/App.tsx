import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion'
import * as THREE from 'three'
import Scene from './scene/Scene'
import Resume from './ui/Resume'
import Works from './ui/Works'
import Contact from './ui/Contact'
import LoadingScreen from './ui/LoadingScreen'
import AvatarChat from './ui/AvatarChat'
import Site1 from './site1/Site1'
import { chromeOpacityAt, getSite1Height, useSite2Emerge, useSite2Scroll } from './site1/anchor'
import { useStore } from './store'

function Backdrop() {
  // 点击空白处收起详情
  const setActive = useStore((s) => s.setActive)
  return (
    <mesh position={[0, 0, -40]} onClick={() => setActive(null)}>
      <planeGeometry args={[600, 300]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

type Lang = 'en' | 'zh'

// paragraphs：一条 = 一句正文；多条时自动渲染成左对齐的 ● 要点列表
// （条目自身不带 ●，标记由 .about-list li::before 画，换行时缩进才对得齐）
const COPY = {
  en: {
    title: 'About Me',
    paragraphs: [
      'Solo long-stays as a digital nomad — the UAE, Egypt, Thailand',
      'Appeared in TVCs for Shanghai Xintiandi and Delta Force',
      'Deep in AI: AIGC, agents, and AI user growth for North America',
    ],
  },
  zh: {
    title: 'About Me',
    paragraphs: [
      '独自旅居（数字游民）阿联酋，埃及，泰国',
      '参演上海新天地、三角洲行动TVC',
      '深耕 AI（AIGC、Agent、AI 用户增长（北美））',
    ],
  },
}

function Hero({
  lang,
  cueOpacity,
  s1h,
  emerge,
}: {
  lang: Lang
  cueOpacity: MotionValue<number>
  /** 网站1 占掉的高度，由 App 传下来（见 site1/anchor.ts 顶部的说明） */
  s1h: number
  /** 网站2 从交接的白光里「浮现」出来的进度 0→1（见 anchor.ts 的 useSite2Emerge） */
  emerge: MotionValue<number>
}) {
  const { title, paragraphs } = COPY[lang]
  const aboutRef = useRef(null)
  // ⚠️ 这里不能用 useScroll({ target: aboutRef, offset: ['start 0.6', 'start start'] })。
  // 那套进度取决于「.about 顶部有没有越过视口 60% 线」，而 .hero 是
  // justify-content:flex-end —— .about 贴底排，其顶部 ≈ 0.91*vh − 244px。
  // 于是视口一矮，它自己就早越过了那条线：**一个字都没滚，文字已经被糊了**
  // （实测 scrollY=0 时：vh=750 带 0.36px 模糊，vh=720 是 1.04px + 透明度 0.935，
  //   vh=600 是 4.62px + 透明度 0.711；vh≥787 才干净）。
  // 改成由「窗口已滚动距离」驱动 —— 静止时必然是 0，与视口高矮无关。
  // ⚠️ 这里读的是 useSite2Scroll（= 原始 scrollY 减去网站1 占掉的高度），不是 useScroll()。
  //    前面接了 720vh 的网站1 之后，原始 scrollY 一进网站2 就已经是几千，下面那几段
  //    ease(s, 0.32) 会立刻吃满 —— 症状是「刚滑到这一屏，文字已经是 blur(16px) + opacity 0」，
  //    也就是首屏整屏看不见。锚点修正见 site1/anchor.ts。
  const scrollY = useSite2Scroll(s1h)
  // 用函数式 transform 现算 vh，而不是模块级缓存：全屏/改窗口后不用重新挂载也跟得上
  const vhNow = () => (typeof window !== 'undefined' ? window.innerHeight : 800)
  const ease = (s: number, k: number) => Math.min(Math.max(s / (vhNow() * k), 0), 1)
  // 模糊 + 淡出：0.32vh 行程跑完（等价于原来 progress 0.5 的位置）
  const p = useTransform(scrollY, (s) => ease(s, 0.32))
  /* 交接那一下：文字**跟着白光的余晖一起浮出来**（emerge 0→1）。
     原来是「白光一散，整块文字已经全亮」—— 硬切。现在是淡入 + 从 6px 去模糊。
     ⚠️ 两路模糊取 max：滚动淡出的模糊、浮现的模糊，谁大听谁的（不会互相抵消）。 */
  const blurPx = useTransform([p, emerge], ([a, b]: number[]) => Math.max(a * 16, (1 - b) * 6))
  const blur = useTransform(blurPx, (v) => {
    // 静止时返回 none，而不是 blur(0px)：
    // 常驻的 filter 会把整块文字提升成独立合成层，而带 filter 的层在窗口尺寸变化后
    // 可能不重新栅格化、直接被拉伸 → 字发虚。静止时干脆不建这一层。
    return v <= 0.05 ? 'none' : `blur(${v.toFixed(2)}px)`
  })
  const opacity = useTransform([p, emerge], ([a, b]: number[]) => (1 - a) * b)
  // 视差：标题上升更快、字距随滚动拉开；正文上升慢一点（0.64vh ≈ 原来的 progress 1）
  const titleY = useTransform(scrollY, (s) => -96 * ease(s, 0.64))
  const bodyY = useTransform(scrollY, (s) => -52 * ease(s, 0.64))
  const titleSpacing = useTransform(scrollY, (s) => `${(0.01 + 0.41 * ease(s, 0.64)).toFixed(3)}em`)
  return (
    <section className="hero">
      <motion.div
        className="about"
        lang={lang}
        ref={aboutRef}
        style={{ filter: blur, opacity }}
      >
        {/* 入场动画放内层，避免其 fill 锁住 opacity 覆盖外层滚动 opacity */}
        <div className="about-intro">
          <motion.h1 className="about-title" style={{ y: titleY, letterSpacing: titleSpacing }}>
            {title}
          </motion.h1>
          {paragraphs.length === 1 ? (
            <motion.p className="about-body" style={{ y: bodyY }}>
              {paragraphs[0]}
            </motion.p>
          ) : (
            /* 多条 → 要点列表。外层 .about 是 text-align:center，这里再设成
               inline-block + text-align:left，让整块居中、但 ● 排成一列。 */
            <motion.ul className="about-body about-list" style={{ y: bodyY }}>
              {paragraphs.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </motion.ul>
          )}
        </div>
      </motion.div>
      <motion.div className="scroll-cue" style={{ opacity: cueOpacity }} aria-hidden="true">
        <span className="scroll-cue-label">{lang === 'en' ? 'SCROLL' : '向下滚动'}</span>
        <span className="scroll-cue-track">
          <span className="scroll-cue-dot" />
        </span>
      </motion.div>
    </section>
  )
}

function LangToggle({ lang, onToggle }: { lang: Lang; onToggle: () => void }) {
  return (
    <button className="lang-toggle" onClick={onToggle} aria-label="切换语言 / Switch language">
      {lang === 'en' ? '中文' : 'EN'}
    </button>
  )
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/* 预热：把「首次渲染」的成本从交接那一刻挪到加载遮罩后面
   ------------------------------------------------------------------
   用户报告：「为什么网页一到网页二卡卡的」。实测（`_tools/perf_handoff.cjs`，
   有头 Chrome / 真实 GPU，1440×900）：
     · 冷交接（本次会话第一次进网站2）= **一个 4142ms 的长任务**，那一帧完全冻住
     · 热交接（退回去再进一次）= 163fps、零长任务
   说明这 4 秒是**一次性**的：GL program 编译 + 贴图上传，全砸在 3D 场景的首帧上。

   而首帧原本恰好落在交接那一刻，因为 `frameloop` 在 glb 一加载完就切成 'never'
   （paused && loaded）—— Scene 是跟 loaded 同一次 commit 挂上去的，
   它**一帧都没画过**就被暂停了，于是这笔账一直欠到用户滚到交接段才还。

   所以挂载后先显式 `gl.compile()` 一次（把 onBeforeCompile 注入的那几个材质变体
   一并编出来），再放它真渲染几帧（贴图上传发生在真实绘制里），之后才允许暂停。
   ⚠️ 这几帧仍在加载遮罩底下（LoadingScreen 现在等 `warm` 才淡出），
      用户看到的是「还在转圈」，不是「网页卡死了」—— 遮罩的圆环是 CSS transform 动画，
      走合成器线程，主线程被编译冻住时它照转。
   ⚠️ 别只渲染一两帧：实测 3 帧时冷交接仍留 300~500ms 的尾巴 ——
      阴影 pass 之类的东西要第二帧以后才走到。 */
function Warmup({ onWarm }: { onWarm: () => void }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const frames = useRef(0)
  const done = useRef(false)

  useEffect(() => {
    /* 同步阻塞的那一下 —— 就是原来冻在交接里的那几秒。放这里之后它发生在遮罩底下。
       ⚠️ 用 try 包住：某些驱动上 compile 会抛（比如 program 数超限），
          抛了也不该连累正常渲染，静默跳过即可。 */
    try {
      gl.compile(scene, camera)
    } catch {
      /* 跳过预热，退回"首帧编译"，至少功能是好的 */
    }
  }, [gl, scene, camera])

  useFrame(() => {
    if (done.current) return
    /* 8 帧。为什么不是 1~3 帧：实测冷交接那一下是**一个 4142ms 的长任务**
       （3D 的 GL program 编译 + 贴图上传全砸在首帧上），3 帧只消掉大半，
       还留 300~500ms 的尾巴 —— 阴影 pass 之类的东西要第二帧以后才走到。
       ⚠️ 也别贪多：试过 30 帧，冷交接只从 297ms 降到 278ms（在噪声里），
          而加载遮罩要多留 0.8 秒。8 帧是这个函数上的拐点。 */
    if (++frames.current >= 8) {
      done.current = true
      onWarm()
    }
  })
  return null
}

/* 网站1 期间要不要把 3D 的渲染循环停掉。
   ------------------------------------------------------------------
   原本是 true（省 CPU：网站1 期间那块被不透明的影片舞台整个盖住，画了也看不见）。

   ⚠️ 2026-09-19 试过改成 false（"让 3D 一直渲染，就没有恢复那一下的开销"）——
      **不行，实测更差**：1440×900 下网站1 静止段从 146fps 掉到 25.8fps、
      过场掉到 16fps（3D 每帧 ~30ms 的渲染和影片的全屏 drawImage 抢主线程/GPU）。
      用户要的是"滚起来顺"，那就不能拿开场的流畅去换。
      真正的病根是"预热不足"（见 Warmup），在那边加热才是对的 —— 别再来动这个开关。 */
const PAUSE_3D_IN_SITE1 = true

/* 3D 场景外壳。
   网站1 期间这块被不透明的影片舞台整个盖住，没必要每帧渲染 ——
   那台机器同时还要解码 189 张 1600×900。滚出网站1 时再把循环还回去。
   ⚠️ 必须等**预热完成**（warm）才能关循环，不是等模型加载完（loaded）：
      加载完只代表资源到齐，首帧还没画过。提前关掉 = 把编译费欠到交接那一刻。 */
function SceneStage({
  emerge,
  s1h,
  warm,
  onWarm,
}: {
  /** 网站2 从交接的白光里浮现出来的进度（见 anchor.ts）—— 3D 场景的**可见度就是它** */
  emerge: MotionValue<number>
  s1h: number
  /** 首帧是否已经渲染过（由 Warmup 回调置位） */
  warm: boolean
  onWarm: () => void
}) {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const sync = () => {
      const h = getSite1Height()
      const vh = window.innerHeight
      setPaused(h > 0 && window.scrollY < h - vh)
    }
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [s1h])
  /* 交接那一下：3D 场景从「暗 + 略大」聚焦回原位 —— 镜头落定的感觉。
     ⚠️ 只用 brightness/scale，不用 blur：全屏 canvas 的 blur 每帧重算，交接时
        同时还在画 1600×900 的影片帧，会掉帧。这两项都是合成器直接吃的，几乎不要钱。
     ⚠️ emerge = 1 时**必须**回到 none / 1：常驻 filter 会把整个场景提升成独立合成层，
        之后的滚动都要多合成一次。
     ⚠️ 可见度也用 emerge，**不要**再叠一个"按 e 线性淡入"的 reveal：
        那两个量一相乘，中段就会变成 emerge×reveal（比如 0.5×0.6=0.3），
        网站2 比白光褪得慢 → 又出现一段"什么都没有"的空档，正是用户说的分界线。
        现在 opacity 与白光严格互补（opacity = emerge = 1 - flash），份额守恒。
        网站1 期间看不到它，靠的是不透明的舞台挡着（.s1-stage 有实底色），不是这里的透明度。 */
  const scale = useTransform(emerge, (v) => 1 + 0.05 * (1 - v))
  const bright = useTransform(emerge, (v) =>
    v >= 0.999 ? 'none' : `brightness(${(0.78 + 0.22 * v).toFixed(3)})`
  )
  return (
    <motion.div className="scene-bg" style={{ opacity: emerge, scale, filter: bright }}>
      <Canvas
        shadows={{ type: THREE.PCFShadowMap }}
        dpr={[1, 2]}
        frameloop={PAUSE_3D_IN_SITE1 && paused && warm ? 'never' : 'always'}
        // near/far 直接决定景深的精度：相机离人物只有 3~8 个单位，
        // 用 near 0.6 / far 120（而不是 0.1 / 500）能让自动对焦清晰得多。
        camera={{ position: [0, 5, 19], fov: 39, near: 0.6, far: 120 }}
        gl={{ antialias: false, stencil: false, depth: true, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <color attach="background" args={['#0a0e16']} />
        <Suspense fallback={null}>
          <Backdrop />
          <Scene />
          {/* 预热哨兵：必须在 Suspense **内部** —— 它一挂载就说明 glb 到位了，
              这时才谈得上"首帧"。见 Warmup 顶部那段说明。 */}
          <Warmup onWarm={onWarm} />
        </Suspense>
      </Canvas>
    </motion.div>
  )
}

export default function App() {
  const [lang] = useState<Lang>('zh')
  // 网站1 占掉的高度。⚠️ 必须是 state，不能只放模块变量：useTransform 只在输入变化时
  // 重算，而它「在 render 期同步重算」这条特性只有在 App 真的重渲染一次时才生效。
  const [s1h, setS1h] = useState(0)
  /* 3D 场景是否已经真渲染过（预热完成）。给两处用：
     · SceneStage 决定能不能把 frameloop 关掉（关早了 = 把编译费欠到交接那一刻）
     · LoadingScreen 决定能不能开始淡出（不然用户会在"页面已经能看"的状态下撞上 4 秒冻结） */
  const [warm, setWarm] = useState(false)
  // 原始滚动位置（含网站1 那一段），只用于「按绝对位置切网站1 ↔ 网站2」的两处
  const { scrollY: rawScrollY } = useScroll()
  // 网站2 自己的滚动位置：减掉网站1 的高度，让它以为页面还是从自己顶部开始的
  const scrollY = useSite2Scroll(s1h)
  // 网站1 的舞台滚走 → 背后的 3D 场景淡回来
  /* 网站2 从交接的白光里「浮现」出来的进度（0 = 还在光里，1 = 完全就位）。
     ⚠️ 它现在是网站2 在交接段的**唯一**入场量：3D 场景的可见度、首屏文字的透明度、
        画框角标，全部由它（或其派生）控制，而它 = 1 - 白光。
        原来这里还有一个 useSceneReveal（3D 按 e 线性淡入）—— 两个量相乘会让网站2
        比白光褪得慢，中段出现空档（就是那条分界线），已经去掉。 */
  const emerge = useSite2Emerge(s1h)
  /* AI 分身入口什么时候出现 —— 只在**开场影片交出接力棒之后**。
     ⚠️ 阈值按交接段算，不是随便给的：网站1 高度 h = N×100vh，末站（光环）在
        h − vh，交接段就是 [h − vh, h] 这最后 1vh。取 h − 0.2vh 时交接进度
        e = 0.8，白光只剩 8%（glow 那一段快走完了），画面基本已经是网站2，
        这时圆钮淡出来不会被白光盖住、也不会压在影片上。
     ⚠️ 滚回影片里要**收回去**（不是只出现一次），所以这里不设"只触发一次"的锁。 */
  const [pastFilm, setPastFilm] = useState(false)
  useEffect(() => {
    const sync = () => {
      const h = getSite1Height()
      const vh = window.innerHeight
      setPastFilm(h > 0 && window.scrollY >= h - vh * 0.2)
    }
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [s1h])
  // 作品区蒙层：以作品区顶部从视口底进入到视口中部的进度，驱动 3D 渐暗 + 模糊
  const worksRef = useRef(null)
  const { scrollYProgress: worksProgress } = useScroll({
    target: worksRef,
    offset: ['start end', 'start center'],
  })
  const fogBg = useTransform(
    worksProgress,
    [0, 1],
    ['rgba(8, 11, 18, 0)', 'rgba(8, 11, 18, 0.41)'] // 压暗减半（原 0.82）
  )
  const fogBlur = useTransform(worksProgress, [0, 1], ['blur(0px)', 'blur(10px)'])
  // 滚动渐暗：离开首屏后压暗 3D 场景，保证履历文字可读
  const scrimOpacity = useTransform(scrollY, [0, 520], [0, 0.4])
  // 首屏滚动提示随之淡出（并跟着交接的浮现一起进来）
  const cueBase = useTransform(scrollY, [0, 160], [1, 0])
  const cueOpacity = useTransform([cueBase, emerge], ([a, b]: number[]) => a * b)
  // 首屏底部渐变底色：开始滑动后淡出
  const heroGradientOpacity = useTransform(scrollY, [0, 240], [1, 0])
  // 磨砂右轨：进入履历区后淡入（首屏不磨砂）
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const railOpacity = useTransform(scrollY, [vh * 0.5, vh * 1.1], [0, 1])
  // 首屏装饰画框/角标：滚动后淡出。
  // ⚠️ 这一层是 z-index 12 —— 比 .content(z10) 还高，也就是说它会盖在网站1 上面。
  //    所以它必须按**原始**滚动量算：网站1 期间为 0，交出接力棒时才淡进来。
  //    （若直接用网站2 的 scrollY，网站1 期间那个值恒为 0 → 这圈画框会全程压在影片上。
  //      而且这里必须把 site1Height 当**第二个输入**传进去：普通变量改了 framer 不会重算，
  //      首屏那次的结果会一直沿用，症状就是「一进页面画框压着影片，手一滑又自己好了」。）
  const heroChromeOpacity = useTransform(rawScrollY, (s) => chromeOpacityAt(s, s1h))

  return (
    <>
      {/* 加载遮罩：模型全部加载完成**且 3D 首帧渲染完**（warm）才淡出 ——
          首帧那几秒的 GL 编译被挡在这里面，见 Warmup 的说明 */}
      <LoadingScreen ready={warm} />

      {/* 固定的 3D 背景（网站1 期间被影片舞台盖住 → 淡出 + 停渲染） */}
      <SceneStage emerge={emerge} s1h={s1h} warm={warm} onWarm={() => setWarm(true)} />
      {/* 滚动渐暗蒙层 */}
      <motion.div className="scrim" style={{ opacity: scrimOpacity }} aria-hidden="true" />

      {/* 作品区固定蒙层：仅压暗（减半），模糊先注释掉 */}
      <motion.div
        className="stage-fog"
        style={{ background: fogBg /* , backdropFilter: fogBlur, WebkitBackdropFilter: fogBlur */ }}
        aria-hidden="true"
      />

      {/* 固定磨砂右轨（进入履历区淡入） */}
      <motion.div className="glass-rail" style={{ opacity: railOpacity }} aria-hidden="true" />

      {/* 首屏底部渐变底色，滚动后淡出。
          2026-09-16 重新启用：这里原本被注释掉是为了"看效果"，但首屏正文换成真实自我介绍后
          （从一行占位变成两段），last 4 行的下半部分落在场景那片浅色底上 ——
          正文是浅墨色 var(--ink) #f4f1ea，浅底浅字几乎读不出来。
          这段 35vh 的深墨绿渐隐带就是为这件事写的，接回来才有对比度。 */}
      <motion.div
        className="hero-gradient"
        style={{ opacity: heroGradientOpacity }}
        aria-hidden="true"
      />

      {/* 中英切换暂时隐藏，默认中文 */}
      {/* <LangToggle lang={lang} onToggle={() => setLang((l) => (l === 'en' ? 'zh' : 'en'))} /> */}

      {/* 首屏装饰：发丝内框 + 四角定位标 + 角标元数据（随滚动淡出） */}
      <motion.div className="hero-chrome" style={{ opacity: heroChromeOpacity }} aria-hidden="true">
        <div className="hero-frame" />
        <span className="hero-mark tl">+</span>
        <span className="hero-mark tr">+</span>
        <span className="hero-mark bl">+</span>
        <span className="hero-mark br">+</span>
        <div className="hero-meta hm-tl">
          <span className="hm-name">王一妍 · Keira</span>
          <span>全球 AI 增长 · AIGC · Agent</span>
        </div>
        <div className="hero-meta hm-tr">Résumé · 2026</div>
        <div className="hero-meta hm-bl">Math · AI · Growth</div>
        <div className="hero-meta hm-right">Solo Travel · 数字游民</div>
      </motion.div>

      {/* 可滚动内容 */}
      <main className="content">
        {/* 网站1：滚动擦洗开场（6 个停留界面）。在它后面才是原来的简历站。
            它自己负责把占掉的高度报给 anchor.ts，网站2 的滚动阈值靠那个值往回退。 */}
        <Site1 onHeight={setS1h} />
        <Hero lang={lang} cueOpacity={cueOpacity} s1h={s1h} emerge={emerge} />
        <Resume lang={lang} />
        <Works lang={lang} innerRef={worksRef} />
        {/* 收尾：联系方式 + 「这一页是怎么做的」（面试官滑到底最先想知道的两件事） */}
        <Contact />
      </main>

      {/* AI 分身：右下角入口 + 面板。开场影片期间整个隐藏（visible=false），
          影片交棒之后才淡出来 —— 见上面 pastFilm 的说明。
          它的第二个入口在收尾板块「保持联系」的那张卡里（走 chat/open.ts 的事件）。 */}
      <AvatarChat visible={pastFilm} />
    </>
  )
}
