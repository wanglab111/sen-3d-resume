import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type Ref,
  type SVGProps,
} from 'react'
import { motion, useScroll, useTransform } from 'framer-motion'
import {
  WORKS,
  SECTION_COVERS,
  groupLinks,
  platformOf,
  type WorkLink,
  type WorkListItem,
  type WorkPhoto,
  type WorkPlatform,
  type WorkSection,
  type WorksLang,
} from '../data/works'
import {
  BilibiliIcon,
  CameraIcon,
  DouyinIcon,
  TiktokIcon,
  WebLinkIcon,
  XiaohongshuIcon,
} from './SocialIcons'

// 浮层 / 预览栏小标题左边的图标。新增平台：SocialIcons 里加图标 → 这里挂一行。
const PLATFORM_ICONS: Record<WorkPlatform, ComponentType<SVGProps<SVGSVGElement>>> = {
  bilibili: BilibiliIcon,
  douyin: DouyinIcon,
  xiaohongshu: XiaohongshuIcon,
  tiktok: TiktokIcon,
  web: WebLinkIcon,
}

// ============================================================================
// 作品区交互（2026-09-17 第二次改造）
//
// 背景：上一版是「行下方（footer 行向上）弹一个绝对定位的浮层」，浮层必然压住
//   后面几行的作品名 —— 实测 1440×900 下 hover「黄浦江三文鱼」盖掉 3 行名字，
//   hover「视频剪辑…」盖掉 4 行（量法见 _tools/occl.cjs，它会数浮层与其它行文字的交集）。
//
// 现在按界面分两套，DOM 都渲染，由 CSS 媒体查询决定谁出现，组件里不做分支：
//
//   · 宽屏 + 有指针（hover:hover 且 ≥1080px）→「左清单 + 右预览栏」：
//       卡片右侧常驻一栏，指到哪一行，右栏就换成那一行的链接 / 照片。
//       弹出不再压在任何东西上 —— 零遮挡，而且右栏比 360px 的浮层宽裕得多。
//   · 窄屏 / 触屏 → 保留原来的浮层：屏太窄摆不下第二栏，浮动仍是唯一入口；
//       弹上还是弹下由几何自动判定（见 WorkLine）。
// ============================================================================

// 预览栏 / 浮层共用的「链接 + 照片」正文
function MediaBody({
  links,
  photos,
  data,
}: {
  links: WorkLink[] | null
  photos: WorkPhoto[] | null
  data: WorksLang
}) {
  const groups = links ? groupLinks(links) : null
  return (
    <>
      {groups &&
        groups.map((g) => {
          const Icon = PLATFORM_ICONS[g.platform]
          return (
            <div className="wk-pop-group" key={g.platform}>
              <span className="wk-pop-title">
                <Icon className="wk-pop-title-ico" />
                {data.platformTitles[g.platform]}
              </span>
              <ul className="wk-pop-list">
                {g.links.map((l) => (
                  <li key={l.url}>
                    <a className="wk-pop-link" href={l.url} target="_blank" rel="noopener noreferrer">
                      <span className="wk-pop-link-label">{l.label}</span>
                      <span className="wk-pop-link-ico" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}

      {photos && (
        <div className="wk-pop-group">
          <span className="wk-pop-title">
            <CameraIcon className="wk-pop-title-ico" />
            {data.photoTitle}
          </span>
          {/* 单张用 max-height 收一下（竖图会很长）；多张走两栏瀑布，各自保留原始比例，不裁图 */}
          <div className={photos.length > 1 ? 'wk-pop-photos' : 'wk-pop-photos wk-pop-photos--single'}>
            {photos.map((p) => (
              // width/height 不是装饰：不写的话图没加载完时高度是 0，会「先扁后跳」。
              <img
                key={p.src}
                src={p.src}
                alt={p.alt}
                width={p.w}
                height={p.h}
                loading="lazy"
                decoding="async"
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// 列表里的一行 + 预览栏里的一份内容，两边靠同一个 key 对上
interface RowVM {
  key: string
  item: WorkListItem
  /** 贴在卡片底部的 footer 行：浮层要向上弹 */
  up?: boolean
}

// 把板块拆成「清单结构 + 扁平行表」。key 只在这一处生成 —— 列表和右栏不可能对错行。
function sectionRows(section: WorkSection) {
  const flat: RowVM[] = []
  const items: RowVM[] = []
  const groups: { heading: string; rows: RowVM[] }[] = []
  let n = 0
  const mk = (item: WorkListItem, up?: boolean): RowVM => {
    const row: RowVM = { key: 'r' + n++, item, up }
    flat.push(row)
    return row
  }

  if (section.items) for (const it of section.items) items.push(mk(it))
  if (section.groups)
    for (const g of section.groups) {
      const rows = g.items.map((name) => mk({ name }))
      groups.push({ heading: g.heading, rows })
    }

  let foot: RowVM | null = null
  // footer 挂了链接就变成一个「可预览 / 可弹浮层的行」；没挂就还是那行小字
  if (section.footer && section.footerLinks && section.footerLinks.length) {
    foot = mk({ name: section.footer, links: section.footerLinks }, true)
  }
  return { flat, items, groups, foot }
}

// 极简清单的一行：作品名靠左、数据（播放量/标签）靠右、发丝线分隔。
//
// ⚠️ 作品行不能点开全屏详情（2026-09-17 起）。带 links / photos 的行：
//    宽屏 → 指到它就点亮右侧预览栏；窄屏 / 触屏 → 点一下弹出浮层。
//    不带链接也不带照片的行是纯展示 —— 连 hover 反馈都没有。
//    ⚠️ 别再把这行换回 <button> —— 按钮语义会暗示「有东西会打开」。
function WorkLine({
  row,
  data,
  activeKey,
  onActivate,
}: {
  row: RowVM
  data: WorksLang
  activeKey: string | null
  onActivate: (key: string | null) => void
}) {
  const { item, up = false } = row
  // 触屏没有 hover，靠点击切这个类展开浮层；桌面 hover 由 CSS 负责，两者叠加无害
  const [open, setOpen] = useState(false)
  const liRef = useRef<HTMLLIElement>(null)
  const [upward, setUpward] = useState(up)

  const hasMeta = item.meta || (item.tags && item.tags.length)
  const links = item.links && item.links.length ? item.links : null
  const photos = item.photos && item.photos.length ? item.photos : null
  const interactive = !!(links || photos)
  // 行内常显提示：全是「真的视频」→「3 支视频」；掺了产品官网或**图文/笔记**→「3 个链接」。
  // ⚠️ 2026-09-19：小红书笔记、抖音图文都不能算视频。以前只排除了 web，
  //    于是「Agent 工作流搭建」那条（抖音图文 + 小红书笔记）行内写着「2 支视频」—— 假的。
  const allVideo = links
    ? links.every((l) => {
        const p = platformOf(l.url)
        return p === 'bilibili' || p === 'douyin' || p === 'tiktok'
      })
    : false
  const hint = photos
    ? data.photosLabel(photos.length)
    : links
      ? allVideo
        ? data.videosLabel(links.length)
        : data.linksCountLabel(links.length)
      : null

  // 窄屏浮层往下弹会越过卡片底边，被 .wk-gallery-sticky 的 overflow:hidden 裁掉
  // （实测：1440×900 下「泰国」那一行行底 y=645，两张照片的浮层高 267 → 底部 913，被切掉 13px）。
  // 行在卡里的位置随视口高矮浮动，写死方向迟早会在某个分辨率上翻车，所以按几何自动定：
  // 行下方装不下、且上方更宽裕 → 改成向上弹。
  //
  // ⚠️ 能这样量，是因为浮层隐藏态用的是 visibility:hidden（不是 display:none）——
  //    元素仍在文档流里、有完整布局盒，所以不用等 hover 就能量到真实高度。
  //    （宽屏下 .wk-pop 被 display:none 收掉，这里量到 0 → 结果无意义，
  //     但宽屏显示的是预览栏、根本不看这个方向，所以无所谓。）
  // ⚠️ 别给 <img> 去掉 width/height：照片没加载完时高度会缩水，方向就会判错。
  useEffect(() => {
    const li = liRef.current
    if (!li || !interactive) {
      setUpward(up)
      return
    }
    const pop = li.querySelector('.wk-pop') as HTMLElement | null
    const host = li.closest('.wk-gallery-sticky') as HTMLElement | null
    if (!pop || !host) return
    const measure = () => {
      const need = pop.getBoundingClientRect().height
      const row = li.getBoundingClientRect()
      const box = host.getBoundingClientRect()
      const below = box.bottom - row.bottom
      const above = row.top - box.top
      setUpward(up || (below < need && above > below))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(pop)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [interactive, up])

  return (
    <li
      ref={liRef}
      className={[
        'wk-line',
        interactive ? 'wk-line--links' : '',
        photos ? 'wk-line--photo' : '',
        upward ? 'wk-line--up' : '',
        open ? 'is-open' : '',
        activeKey === row.key ? 'is-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={interactive ? () => onActivate(row.key) : undefined}
      // 收起绑在 li 上、不是绑在行按钮上：浮层是行按钮的**兄弟节点**，
      // 挂在行按钮上会因为「鼠标移进浮层 = 离开行按钮」而当场收起，链接就点不到了。
      // ⚠️ 只在真有指针（hover: hover）的设备上生效：触屏 tap 之后浏览器会补发一个合成的
      //    mouseleave，不做判断的话浮层会在刚展开的瞬间被自己收掉。
      onMouseLeave={
        interactive
          ? () => {
              if (window.matchMedia('(hover: hover)').matches) setOpen(false)
            }
          : undefined
      }
    >
      <div
        className="wk-line-btn"
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-expanded={interactive ? open : undefined}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        // div 不是 button，Enter/Space 得自己接 —— 键盘用户靠这个展开浮层 / 点亮右栏
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen((v) => !v)
                }
              }
            : undefined
        }
        onFocus={interactive ? () => onActivate(row.key) : undefined}
      >
        <span className="wk-line-lead">
          <span className="wk-line-name">{item.name}</span>
          {/* 常显的「这里有东西」提示：不然没人知道有链接/照片，等于藏起来了 */}
          {hint && (
            <span className={photos ? 'wk-line-play wk-line-play--photo' : 'wk-line-play'}>
              {photos && <CameraIcon className="wk-line-play-ico" />}
              {hint}
            </span>
          )}
        </span>
        {hasMeta && (
          <span className="wk-line-meta">
            {item.meta && <span className="wk-line-num">{item.meta}</span>}
            {item.tags &&
              item.tags.map((t, i) => (
                <span key={i} className="wk-line-tag">
                  {t}
                </span>
              ))}
          </span>
        )}
      </div>

      {interactive && (
        <div className="wk-pop">
          <div className="wk-pop-panel">
            <MediaBody links={links} photos={photos} data={data} />
          </div>
        </div>
      )}
    </li>
  )
}

// 宽屏右侧预览栏：空态是一句提示，指到某行就换成那一行的链接 / 照片。
// 它占的是一栏独立的版面，所以「弹出」永远不会压住清单里的字。
function WorkPane({ row, data }: { row: RowVM | null; data: WorksLang }) {
  const item = row?.item ?? null
  const links = item?.links && item.links.length ? item.links : null
  const photos = item?.photos && item.photos.length ? item.photos : null
  const filled = !!(row && (links || photos))
  return (
    <aside className="wk-pane" aria-live="polite">
      {filled ? (
        // key = 行的 key：换一行就换一个节点，framer 会重放一次淡入（同一行不重播）
        <div className="wk-pane-inner" key={row!.key}>
          <div className="wk-pane-head">
            <span className="wk-pane-name">{item!.name}</span>
            {item!.meta && <span className="wk-pane-meta">{item!.meta}</span>}
          </div>
          <MediaBody links={links} photos={photos} data={data} />
        </div>
      ) : (
        <p className="wk-pane-hint">{data.paneHint}</p>
      )}
    </aside>
  )
}

// 板块内的作品清单（items 扁平 / groups 分组 / awards · footer 底部小字）
function SectionWorks({
  section,
  data,
  activeKey,
  onActivate,
}: {
  section: WorkSection
  data: WorksLang
  activeKey: string | null
  onActivate: (key: string | null) => void
}) {
  const { items, groups, foot } = sectionRows(section)

  return (
    <div className="wk-col">
      {items.length > 0 && (
        <ul className="wk-list">
          {items.map((r) => (
            <WorkLine key={r.key} row={r} data={data} activeKey={activeKey} onActivate={onActivate} />
          ))}
        </ul>
      )}

      {groups.map((g, gi) => (
        <div key={gi} className="wk-sub">
          <div className="wk-sub-head">{g.heading}</div>
          <ul className="wk-list">
            {g.rows.map((r) => (
              <WorkLine key={r.key} row={r} data={data} activeKey={activeKey} onActivate={onActivate} />
            ))}
          </ul>
        </div>
      ))}

      {(section.awards || section.footer) && (
        <div className="wk-foot">
          {section.awards && (
            <p className="wk-foot-line">
              <span className="wk-foot-label">{data.awardsLabel}</span>
              <span className="wk-foot-val accent">{section.awards.join('  ·  ')}</span>
            </p>
          )}
          {/* footer 挂了链接就变成一个「可预览 / 可弹浮层的行」（2026-09-17：「视频剪辑…」
              那一行挂 6 条剪辑作品）；没挂链接就还是原来那行小字。 */}
          {foot ? (
            <ul className="wk-list wk-list--foot">
              <WorkLine row={foot} data={data} activeKey={activeKey} onActivate={onActivate} />
            </ul>
          ) : (
            section.footer && <p className="wk-foot-line">{section.footer}</p>
          )}
        </div>
      )}
    </div>
  )
}

// 一张全高板块卡：左侧标题 + 清单，右侧整条预览栏
function SectionCard({ section, data }: { section: WorkSection; data: WorksLang }) {
  const [coverError, setCoverError] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const cover = SECTION_COVERS[section.id]
  const { flat } = sectionRows(section)
  const activeRow = flat.find((r) => r.key === activeKey) ?? null

  return (
    <div
      className="wk-card"
      // 指针离开整张卡才清空右栏。不挂在行上 —— 那样指针从行挪进右栏（要去点链接）的
      // 路上就会清掉，右栏当场闪回空态，链接根本点不到。
      // ⚠️ 只在有指针的设备上清：触屏点完之后浏览器会补发合成 mouseleave。
      onMouseLeave={() => {
        if (window.matchMedia('(hover: hover)').matches) setActiveKey(null)
      }}
    >
      {/* ⚠️ 卡头不再挂编号（2026-09-19 用户：「作品里的每一个 01 02 这些很多余」）。
          编号原本有两处：这里的 .wk-card-no 和封面占位里的大号 .wk-card-cover-no ——
          一屏里同时出现两个同样的数字，纯装饰、无信息量，已全部摘掉。
          data 里的 section.no 保留（不清数据结构），只是不再渲染。 */}
      <div className="wk-card-head">
        <h3 className="wk-card-title">{section.title}</h3>
        <span className="wk-card-tagline">{section.tagline}</span>
      </div>

      {/* 封面：有图才出现。以前没有图时是「一块深色空盒 + 大号编号」，
          现在编号没了，空盒就是一块没意义的深色矩形 → 直接不渲染，把空间让给清单。
          public/works/covers/ 目录空了这么久也从没被填过，等于一直挂着占位盒。 */}
      {cover && !coverError && (
        <div className="wk-card-cover">
          <img src={cover} alt="" onError={() => setCoverError(true)} />
        </div>
      )}

      <div className="wk-card-body">
        <SectionWorks section={section} data={data} activeKey={activeKey} onActivate={setActiveKey} />
        <WorkPane row={activeRow} data={data} />
      </div>
    </div>
  )
}

export default function Works({ lang, innerRef }: { lang: 'en' | 'zh'; innerRef: Ref<HTMLElement> }) {
  const data = WORKS[lang]
  const sections = data.sections
  const count = sections.length

  // 竖滚 pin 转横移：测量整排卡片的实际可横移距离（px），竖滚进度 → 横移
  const galleryRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: galleryRef,
    offset: ['start start', 'end end'],
  })

  // track 实际宽度 - 视口宽 = 需要横移的距离；随尺寸/语言变化重测
  const [scrollRange, setScrollRange] = useState(0)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => setScrollRange(Math.max(0, el.scrollWidth - window.innerWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [count, lang])

  // px 数值插值（比 vw 字符串更顺）；竖滚行程与横移 1:1
  const x = useTransform(scrollYProgress, [0, 1], [0, -scrollRange])
  // 横移到底时「继续下滑」提示渐隐
  const hintOpacity = useTransform(scrollYProgress, [0.85, 1], [1, 0])

  return (
    <section className="works" lang={lang} ref={innerRef}>
      <div
        className="wk-gallery"
        ref={galleryRef}
        style={{ height: `calc(100vh + ${scrollRange}px)` }}
      >
        <div className="wk-gallery-sticky">
          <span className="wk-gallery-title">{data.title}</span>

          <motion.div className="wk-track" ref={trackRef} style={{ x }}>
            {sections.map((s) => (
              <SectionCard key={s.id} section={s} data={data} />
            ))}
          </motion.div>

          <div className="wk-progress" aria-hidden="true">
            <motion.div className="wk-progress-fill" style={{ scaleX: scrollYProgress }} />
          </div>
          <motion.span className="wk-hint" style={{ opacity: hintOpacity }} aria-hidden="true">
            {data.hint}
          </motion.span>
        </div>
      </div>
    </section>
  )
}
