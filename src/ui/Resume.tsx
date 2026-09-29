import { motion } from 'framer-motion'
import { ZooopLogo } from './ZooopLogo'
import { DouyinIcon, SOCIAL_ICONS } from './SocialIcons'
import { FOCUS_POINTS } from '../data/focusPoints'
import { photo, type WorkLink, type WorkPhoto } from '../data/works'

// ⚠️ 社交链接暂时没挂到任何履历条目上 —— 现在这三条是各平台的**首页**，
// 点过去不是她的主页，挂上去等于放了个死链。等她给真实主页地址（或删掉不要的），
// 在下面的条目里加一行 `links: SOCIAL_LINKS` 就能重新点亮图标。
const SOCIAL_LINKS = [
  { id: 'douyin', label: '抖音', href: 'https://www.douyin.com/' },
  { id: 'bilibili', label: 'B站', href: 'https://space.bilibili.com/' },
  { id: 'xiaohongshu', label: '小红书', href: 'https://www.xiaohongshu.com/' },
]

// 履历数据（双语）。英文为译稿，可按需润色。
interface ResumeGroup {
  heading?: string
  logo?: string
  logoImg?: string
  sub?: string
  link?: string
  items?: string[]
  links?: { id: string; label: string; href: string }[]
}
interface ResumeEntry {
  period: string
  place: string
  role?: string
  logo?: { src: string; alt: string }
  points?: string[]
  groups?: ResumeGroup[]
  /** 该条经历的作品外链（2026-09-17 加）：滑到这一条时自动展开一张小卡，装 3 条抖音 */
  links?: WorkLink[]
  /** 该条经历的照片（2026-09-17 加）：跟在 points 后面平铺 */
  photos?: WorkPhoto[]
  /** links 小卡的抬头 */
  linksTitle?: string
}
// ============================================================================
// 履历内容 —— 2026-09-17 按最新版简历（王一妍-简历-藏蓝现代版.docx）重新校对。
//    · 条数必须与 data/focusPoints.ts 的 FOCUS_POINTS 一致（当前 7 条 = 7 个镜头停靠点）
//      增删履历：这里改条目 + focusPoints.ts 改名单 + data/cameraShots.ts 改机位（长度 = 条数 + 2）
//    · 顺序：教育背景（含技能/语言）→ 实习经历倒序 → 社团经历，与简历一致
//    · period 用简历里的**真实起止月份**。教育那段新版简历已给出 2023.09 – 2027.06，直接采用。
//    · points 是从简历原文**压缩**过的：删了修饰语，保留了所有数字（5w+ / 10w+ / 700w+ / TOP2 …）。
//      原文里一条 100+ 字的句子直接搬上来会一行挤成三行，读起来像文档而不像网站。
//    · 英文版是按中文译的，语言切换按钮目前是注释掉的（只显示中文），所以英文暂时看不到。
// ============================================================================
const RESUME: Record<'en' | 'zh', { title: string; entries: ResumeEntry[] }> = {
  en: {
    title: 'Experience',
    entries: [
      {
        period: '2023.09 – 2027.06',
        place: 'North University of China',
        role: 'Mathematics and Applied Mathematics · BSc',
        groups: [
          { heading: 'English', sub: 'CET-6 546 ｜ IELTS 7.0' },
          { heading: 'Agent workflows', sub: 'CC · Codex · WorkBuddy · Gemini · GPT · Veo3' },
          { heading: 'Also', sub: 'Video editing · traffic & private-domain ops · IP incubation · travel' },
        ],
      },
      {
        period: '2026.06 – 2026.09',
        place: 'Luoxi Jixian',
        role: 'Overseas AI Product Growth Intern · Internet / AI / Overseas',
        points: [
          'Owned end-to-end overseas user growth for several AI products — Genshot, Gizmo, X-polit; traffic discovery and conversion on overseas channels',
          'Built a viral AI content IP on Bilibili, "Huangpu River Salmon" — 100k+ followers; took multi-country brand promo films from script to delivery on my own',
          'Standardised a content pipeline on CC, ChatGPT, Gemini, Codex and WorkBuddy: market research → competitor analysis → scripting → assets → data review',
          'Explored AI agents in real growth scenarios; automated ops workflows supporting demand research, content iteration and strategy tuning, through to overseas launch and commercial validation',
        ],
      },
      {
        period: '2025.02 – 2026.06',
        place: 'Jieli Kechuang',
        role: 'Event Execution Intern · Investment / Hard Tech / Events',
        points: [
          'Ran science-innovation events end to end, working with incubators, Shanghai SOEs, Zhangjiang Moli Community and GCC',
          'Handled guest and attendee invitations, list management, venue coordination and on-site logistics',
        ],
        photos: [
          photo('gcc-1.jpg', 1100, 666, 'GCC startup relay · workshop session'),
          photo('gcc-2.jpg', 1100, 712, 'GCC startup relay · brand-owner pitch'),
        ],
      },
      {
        period: '2025.10 – 2026.02',
        place: 'DeVries Global',
        role: 'Market Growth & Brand Comms Intern · Advertising / Media / PR',
        points: [
          'Ran KOL / KOC partnerships and social distribution; lifted brand awareness in target audiences',
          'Helped Braun blood-pressure monitors reach #2 in category sales',
        ],
      },
      {
        period: '2025.06 – 2025.10',
        place: 'Alibaba',
        role: 'Cross-border Fashion Data Analysis Intern · Internet / E-commerce',
        points: [
          'Monitored merchant data for the fashion accessories category; tracked traffic and conversion and published briefs that backed themed campaigns',
          'Analysed competitor ad spend and promotions in jewellery and light luxury; wrote the competitive read-outs behind content seeding ideas',
          'Followed the full cycle of new-product campaigns and did the post-mortems that shaped the next plan',
          'Consolidated shopper preference feedback into monthly performance reports',
        ],
      },
      {
        period: '2024.05 – 2024.09',
        place: 'Nanchang Tangning Internet Tech',
        role: 'Self-media · Private-domain · Growth Ops · Internet / Content',
        points: [
          'Built multi-platform accounts from zero — 50k+ followers on Douyin in three months; private-domain pool of 9k+ contacts, 12k+ RMB in revenue',
          'Wrote the funnel copy that moved followers into the private-domain pool; kept it active through community management',
          'Ran two accounts end to end as the main operator: 7M+ ("Nuts in Taiyuan") and 97k+ ("Fanmading") followers',
          'Owned visual output — images and video — and negotiated directly with advertisers to open up monetisation',
        ],
      },
      {
        period: '2024.09 – 2025.12',
        place: 'Campus Youth Media',
        role: 'President · Campus Media',
        points: [
          'Helped shape the campus promotion plan; coordinated 15+ events reaching 30k+ students, lifting platform content exposure by 60%',
          'Led trending-content planning; the top single video hit 330k+ views, two pieces were named campus showcase cases',
          'Ran 8 skills workshops and mentored 20+ core members; team named "Outstanding Student Organisation", personally "Outstanding Student Cadre"',
          'Connected youth-media teams at 5 universities for a cross-campus culture showcase that was covered by the university site',
        ],
        linksTitle: 'Campus Youth Media · Douyin',
        // 三个都是中文专有名词（账号名 / 栏目名），不翻译，和 zh 版保持同一串文字
        links: [
          { label: '中北大学', url: 'https://v.douyin.com/OwT2y6pSb2A/' },
          { label: '中北通通通', url: 'https://v.douyin.com/B-n13CfeRpg/' },
          { label: '中北人物访谈', url: 'https://v.douyin.com/QECXymOWLd8/' },
        ],
      },
    ],
  },
  zh: {
    title: '履历',
    entries: [
      {
        period: '2023.09 – 2027.06',
        place: '中北大学（双一流）',
        role: '数学与应用数学 · 理学学士',
        groups: [
          { heading: '英语', sub: 'CET-6 546 ｜ 雅思 7.0' },
          { heading: 'Agent 工作流', sub: 'CC · Codex · WorkBuddy · Gemini · GPT · Veo3 · 即梦 · 可灵' },
          { heading: '其他', sub: '视频剪辑 · 公私域引流运营 · 爆款 IP 孵化 · 旅游' },
        ],
      },
      {
        period: '2026.06 – 2026.09',
        place: '洛希极限',
        role: '海外 AI 产品增长实习生 · 互联网 / AI / 海外',
        points: [
          '负责 Genshot、Gizmo、X-polit 等多款 AI 产品的海外用户增长全流程，主攻海外赛道流量挖掘与转化',
          '打造猎奇向 AI 原创内容，孵化 B 站 10w+ 粉丝爆款 IP「黄浦江三文鱼」，并独立承接多国品牌宣传片创作与落地',
          '依托 CC、ChatGPT、Gemini、Codex、WorkBuddy 搭标准化内容生产工作流：市场调研 → 竞品分析 → 脚本 → 素材 → 数据复盘',
          '探索 AI Agent 在海外增长场景的落地，搭自动化运营工作流，支撑需求研究、内容迭代与策略优化，助推产品海外落地与商业化验证',
        ],
      },
      {
        period: '2025.02 – 2026.06',
        place: '接力科创',
        role: '活动执行实习生 · 投资 / 硬科技 / 活动',
        points: [
          '参与多场科创主题活动全流程执行，联动顶孵、上海央国企、张江模力社区、GCC 等机构与企业办活动',
          '负责嘉宾与参会人员的邀约沟通、名单管理、场地对接，协调现场筹备工作',
        ],
        // 2026-09-17 按要求补两张 GCC 现场照（源图在 D:\修改要求.docx 里）
        photos: [
          photo('gcc-1.jpg', 1100, 666, 'GCC 创业接力 · 工作坊现场'),
          photo('gcc-2.jpg', 1100, 712, 'GCC 创业接力 · 品牌主理人路演'),
        ],
      },
      {
        period: '2025.10 – 2026.02',
        place: 'DeVries Global',
        role: '市场增长与品牌传播实习生 · 广告 / 传媒 / 公关',
        points: [
          '负责 KOL / KOC 生态合作与社媒传播执行，推动品牌在目标人群中的认知提升',
          '协同团队助力德国博朗血压计位列品类销量 TOP2',
        ],
      },
      {
        period: '2025.06 – 2025.10',
        place: '阿里巴巴',
        role: '跨境时尚品类数据分析实习生 · 互联网 / 电商',
        points: [
          '监测时尚配饰类目商家数据，追踪流量与转化核心指标，输出数据简报支撑主题营销策划',
          '拆解珠宝轻奢竞品投放与促销数据，撰写竞品分析，给出内容种草的优化思路',
          '跟进新品推广全周期数据，完成活动效果复盘并迭代营销方案',
          '汇总用户消费偏好反馈，输出月度经营复盘报表与客户数据汇报',
        ],
      },
      {
        period: '2024.05 – 2024.09',
        place: '南昌唐宁互联网科技',
        role: '自媒体 · 私域 · 增长运营 · 互联网 / 内容',
        points: [
          '从 0 到 1 搭建多平台账号，3 个月抖音涨粉 5w+；搭建私域流量池，累计好友 9k+，整体变现超 1.2w',
          '设计引流话术，引导用户沉淀至私域；通过社群维护与互动运营，保障用户活跃度与转化基础',
          '负责 700w+（坚果仁在太原）、9.7w+（樊马丁）双账号全流程运营，打造高端差异化人设',
          '统筹视觉内容输出（图片 / 视频），主动对接广告商洽谈合作，拓展账号商业化渠道',
        ],
      },
      {
        period: '2024.09 – 2025.12',
        place: '校青媒',
        role: '社长 · 校园媒体',
        points: [
          '协助制定校园宣传计划，统筹 15+ 场活动宣传，覆盖师生 3 万+ 人次，推动平台内容曝光提升 60%',
          '主导热点内容策划，单条视频最高浏览 33 万+，2 篇作品获评校级优秀宣传案例',
          '组织 8 场技能培训、培养 20 余名骨干；团队获「校园优秀学生组织」，个人获「优秀学生干部」',
          '对接 5 所高校青媒组织，发起跨校文化联展，合作案例获校级官网报道',
        ],
        // 2026-09-17 按要求加：滑到这一条时自动展开这三条抖音。
        // 前两条是分享出来的**主页**链接（分享文案平台给的是同一句「查看TA的更多作品」，
        // 光看文档分不出谁是谁）→ 拉 `iesdouyin.com/web/api/v2/user/info/?sec_uid=…` 把昵称取出来对上的：
        //   OwT2y6pSb2A → 中北大学（签名「校青年媒体中心运营」，就是校青媒官方号）
        //   B-n13CfeRpg → 中北通通通（中北超话路人采访）
        // 用户要求直接显示账号名，且「中北大学排第一」—— 正好是原顺序。
        linksTitle: '校青媒 · 抖音',
        links: [
          { label: '中北大学', url: 'https://v.douyin.com/OwT2y6pSb2A/' },
          { label: '中北通通通', url: 'https://v.douyin.com/B-n13CfeRpg/' },
          { label: '中北人物访谈', url: 'https://v.douyin.com/QECXymOWLd8/' },
        ],
      },
    ],
  },
}

// 履历条目依次对应 glb 里的聚焦锚点（相机停靠点），顺序须与 entries 一致。
// 名单是唯一真源，见 data/focusPoints.ts（Scene.tsx 也从那里取）。
const POINT_ORDER = FOCUS_POINTS

const EASE = [0.22, 1, 0.36, 1]
const containerV = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.04 } },
}
const itemV = {
  hidden: { opacity: 0, y: 26 },
  show: { opacity: 1, y: 0, transition: { duration: 0.75, ease: EASE } },
}

function Group({ group }: { group: ResumeGroup }) {
  const heading =
    group.logo === 'zooop' ? (
      <a
        className="zooop-logo-link"
        href={group.link}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="ZOOOP"
      >
        <ZooopLogo className="zooop-logo" animated />
      </a>
    ) : group.link ? (
      <a className="about-link" href={group.link} target="_blank" rel="noopener noreferrer">
        {group.heading}
      </a>
    ) : (
      <span>{group.heading}</span>
    )

  return (
    <motion.div className="tl-group" variants={itemV}>
      <div className="tl-group-head">
        {group.logoImg && (
          <span className="tl-group-logo">
            <img src={group.logoImg} alt={group.heading || ''} loading="lazy" />
          </span>
        )}
        {heading}
        {group.sub && <span className="tl-group-sub">{group.sub}</span>}
      </div>
      {group.items && (
        <ul className="tl-points">
          {group.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
      {group.links && (
        <div className="tl-logos">
          {group.links.map((l) => {
            const Icon = SOCIAL_ICONS[l.id as keyof typeof SOCIAL_ICONS]
            return (
              <a
                key={l.id}
                className="tl-logo"
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={l.label}
                title={l.label}
              >
                <Icon />
              </a>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

function Entry({ entry, index }: { entry: ResumeEntry; index: number }) {
  return (
    <motion.div
      className="tl-entry"
      data-point={POINT_ORDER[index]}
      variants={containerV}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-12% 0px -12% 0px' }}
    >
      <motion.span className="tl-dot" variants={itemV} aria-hidden="true" />
      {/* tl-body 包住文字内容（点保持在外做时间轴标记）：移动端可给它加卡片衬底，
          且它紧贴内容高度，不含 tl-entry 用于排布的大 padding。
          用普通 div（非 motion）：framer 变体经 React context 穿透它，叶子元素仍是
          tl-entry 的直接 stagger 子级，入场动画与包裹前完全一致。 */}
      <div className="tl-body">
        <motion.div className="tl-period" variants={itemV}>
          {entry.period}
        </motion.div>
        <motion.div className="tl-head" variants={itemV}>
          {entry.logo && (
            <span className="tl-logo-chip">
              <img src={entry.logo.src} alt={entry.logo.alt} loading="lazy" />
            </span>
          )}
          <h3 className="tl-place">{entry.place}</h3>
        </motion.div>
        {entry.role && (
          <motion.div className="tl-role" variants={itemV}>
            {entry.role}
          </motion.div>
        )}
        {entry.points && (
          <motion.ul className="tl-points" variants={itemV}>
            {entry.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </motion.ul>
        )}

        {/* 条目照片（2026-09-17 加，GCC 现场两张）。
            时间轴本来就是正常文档流，图直接平铺在条目里 —— 不弹层，也就不会有任何遮挡。 */}
        {entry.photos && (
          <motion.div className="tl-photos" variants={itemV}>
            {entry.photos.map((p) => (
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
          </motion.div>
        )}

        {/* 条目外链小卡（2026-09-17 加）：滑到这一条时自己「弹」出来。
            故意用独立的 whileInView 而不是跟 entry 的 stagger 一起走 ——
            entry 一进视口就整块淡入，小卡会「混在里面」；独立出来才读得出
            「滑到这一条 → 弹出这三条链接」。once:true，弹过一次就停住，不来回闪。 */}
        {entry.links && (
          <motion.div
            className="tl-links"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: '-16% 0px -16% 0px' }}
            transition={{ duration: 0.62, ease: EASE, delay: 0.18 }}
          >
            <div className="tl-links-head">
              <DouyinIcon className="tl-links-ico" />
              <span className="tl-links-title">{entry.linksTitle}</span>
            </div>
            <ul className="tl-links-list">
              {entry.links.map((l) => (
                <li key={l.url}>
                  <a className="tl-link" href={l.url} target="_blank" rel="noopener noreferrer">
                    <span className="tl-link-label">{l.label}</span>
                    <span className="tl-link-ico" aria-hidden="true">
                      ↗
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </motion.div>
        )}

        {entry.groups && entry.groups.map((g, i) => <Group key={i} group={g} />)}
      </div>
    </motion.div>
  )
}

export default function Resume({ lang }: { lang: 'en' | 'zh' }) {
  const data = RESUME[lang]
  return (
    <section className="resume" lang={lang}>
      {/* 履历区页眉 = 标题 + 真人照片（2026-09-16 加）。
          为什么照片放在「同一行的右端」而不是标题上方：
            · 标题仍贴着这一列的左边缘 → 与时间轴、竖线保持同一条竖线，原来那套对齐没被破坏；
            · 照片若压在标题上方，滚到第一条履历（相机 NODE_LINE 停靠位）时它已经出画了，
              等于白加；并排则和标题一起停在视野里。
          ⚠️ 别再往下挪进 .timeline：那一列只有 480px 宽，第一条履历的文字会直接压上来。 */}
      <div className="resume-head">
        <motion.h2
          className="resume-title"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10% 0px' }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          {data.title}
        </motion.h2>
        <motion.figure
          className="resume-photo"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10% 0px' }}
          transition={{ duration: 0.7, ease: EASE, delay: 0.12 }}
        >
          {/* 不加 loading="lazy"：它和外面的 whileInView 入场动画会脱节 ——
              动画开始播、图还在下，会看到"先空后弹"一下。整张 118KB，不值得省。 */}
          {/* 用 BASE_URL 拼，不要写 "/portrait.jpg" —— 部署到子路径（GitHub Pages 的
              <user>.github.io/<repo>/）时绝对路径会指到站点根，直接 404。 */}
          <img src={`${import.meta.env.BASE_URL}portrait.jpg`} alt="王一妍 Keira" width={840} height={1120} />
        </motion.figure>
      </div>
      <div className="timeline">
        {data.entries.map((e, i) => (
          <Entry key={i} entry={e} index={i} />
        ))}
      </div>
    </section>
  )
}
