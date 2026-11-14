// The user guide: what the assistant says the first time Dayjob opens, and again whenever it is asked for from
// Settings or from the assistant's own page. It is written out here in full, so it needs no model, no key and no
// network, and it reads the same for everyone.
//
// A step is one thing the assistant shows:
//   id      its name
//   view    the page to bring forward while it is explained (none: the page stays as it is)
//   key     the sidebar key a note flies to (the page's own key; the browser has a key but is not opened)
//   target  what to light up: CSS selectors, whose visible boxes are joined into one (none: nothing is lit and the
//           card stands in the middle of the window)
//   title   [中文, English]
//   say     paragraphs, each { text: [中文, English], when?: selector, state?: name }. One with `when` is said only
//           while that element is in sight; one with `state` only in that state of the assistant (see Guide.jsx)
//   can     the intro's list of what the assistant does: { icon, text }
//   where   where the settings for it are: { what: [中文, English], at: [中文, English], in?: page }. `at` names the
//           place with the words the page itself uses; tests/guide.test.mjs checks each against the page's source.
//
// browser: whether this Dayjob has its own browser (the desktop app does; the page in a web browser does not).

export const GUIDE_VERSION = 1;

const key = view => `.pkey[data-view="${view}"]`;

export function guideSteps({ browser = true } = {}) {
  const steps = [
    {
      id: 'intro',
      title: ['你好，我是 Dayjob 的助手', 'Hi, I\'m Dayjob\'s assistant'],
      say: [
        { text: ['我就是住在侧边栏里的那台留声机。要做什么，用一句话告诉我，我在 Dayjob 里替你做。', 'I\'m the gramophone that lives in the sidebar. Tell me what you need in a sentence, and I do it in Dayjob for you.'] },
      ],
      can: [
        { icon: 'search', text: ['查岗位：今天哪些是新的，哪些分数高', 'Look up jobs: what is new today and what scores highest'] },
        { icon: 'track', text: ['记下投递、更新状态，告诉你哪些该跟进了', 'Record applications, update their status, and say which need a follow-up'] },
        { icon: 'board', text: ['改搜索条件，找到公司自己的招聘页并加进每日抓取', 'Change your searches, and find a company\'s own job board to add to the daily search'] },
        ...(browser ? [{ icon: 'apply', text: ['在 Dayjob 浏览器里替你投递：填表、附上合适的简历、写求职信，提交前先问你', 'Apply for you in the Dayjob browser: fill in the form, attach the resume that fits and write the cover letter, asking before anything is sent'] }] : []),
        { icon: 'memory', text: ['记住你交代过的偏好，下次不用再说', 'Keep in mind the preferences you tell me, so you only say them once'] },
        { icon: 'undo', text: ['我改动的每一处都能一键撤销', 'Every change I make can be undone in one click'] },
      ],
      lead: ['接下来我带你把 Dayjob 看一遍：每个页面是做什么的，设置在哪里改。大约两分钟。', 'Next I\'ll show you around Dayjob: what each page is for and where its settings are. It takes about two minutes.'],
      foot: ['以后想再看，到“设置”页右上角点“用户指南”。', 'To see this again later, click “User guide” at the top right of Settings.'],
    },
    {
      id: 'home', view: 'home', key: 'home', target: [key('home')],
      title: ['主页', 'Home'],
      say: [
        { text: ['这是总览：这周和这个月投了多少、回复率、每份投递走到了哪一步，还有分数高却还没投的岗位。', 'This is the overview: how many you applied to this week and this month, your reply rate, where each application stands, and strong matches you have not applied to yet.'] },
        { text: ['那排数字下面是当月目标。定一个每月的数，Dayjob 把它分成每周的任务。', 'Under the row of numbers are this month\'s goals. Set a monthly number and Dayjob splits it into weekly tasks.'] },
      ],
      where: [
        { what: ['目标', 'Goals'], at: ['就在本页的目标卡片里添加和修改', 'add and edit them in the goals card on this page'] },
      ],
    },
    {
      id: 'feed', view: 'feed', key: 'feed', target: [key('feed')],
      title: ['今日岗位', 'Today'],
      say: [
        { text: ['每天抓回来的新岗位都在这里，AI 对照你的简历给每个岗位打一个匹配分。', 'Each day\'s new jobs arrive here, and the AI gives every one a fit score against your resume.'] },
        { text: ['点开看详情，然后“收藏”、“我已投递”，或者“不感兴趣”。在岗位上点右键也是这几样。', 'Open one to read it, then choose Save, I applied or Not interested. A right-click on a job offers the same.'] },
      ],
      where: [
        { what: ['几点抓取、每个来源抓多少', 'When it runs and how many per source'], at: ['设置 → 每日抓取', 'Settings → Daily search'], in: 'settings' },
        { what: ['用哪个 AI 打分、什么时候打分', 'Which AI scores and when'], at: ['简历与 AI → AI 打分', 'Resume & AI → AI scoring'], in: 'resume' },
      ],
    },
    {
      id: 'saved', view: 'saved', key: 'saved', target: [key('saved')],
      title: ['已收藏', 'Saved'],
      say: [
        { text: ['你收藏的岗位留在这里，不会跟着旧岗位一起被清理。准备好了，就从这里去投。', 'Jobs you save stay here and are not cleared with the old ones. When you are ready, apply from here.'] },
      ],
      where: [
        { what: ['没收藏的旧岗位留多少天', 'How long unsaved jobs are kept'], at: ['设置 → 每日抓取 → 岗位保留天数', 'Settings → Daily search → Keep jobs (days)'], in: 'settings' },
        { what: ['每天检查岗位是否已经关闭', 'The daily check for closed jobs'], at: ['设置 → 投递追踪', 'Settings → Application tracking'], in: 'settings' },
      ],
    },
    {
      id: 'applications', view: 'applications', key: 'applications', target: [key('applications')],
      title: ['投递追踪', 'Applications'],
      say: [
        { text: ['每一份投递走到哪了：已投递、在线测评、面试中、Offer。每次变化都记在它的时间线上。', 'Where every application stands: Applied, Assessment, Interviewing, Offer. Each change is kept on its timeline.'] },
        browser
          ? { text: ['在 Dayjob 浏览器里投出去的申请会自动记进来；在别处投的，点“手动添加投递”。', 'An application sent in the Dayjob browser is recorded here by itself; for one sent elsewhere, use “Add an application”.'] }
          : { text: ['在岗位上点“我已投递”就记进来了；在别处投的，点“手动添加投递”。', 'Choosing “I applied” on a job records it here; for one sent elsewhere, use “Add an application”.'] },
      ],
      where: [
        { what: ['几天后提醒跟进、多久算没有回音', 'When to remind you, and when to flag no reply'], at: ['设置 → 投递追踪', 'Settings → Application tracking'], in: 'settings' },
      ],
    },
    ...(browser ? [{
      id: 'browser', key: 'browser', target: [key('browser')],
      title: ['浏览器', 'Browser'],
      say: [
        { text: ['Dayjob 自带的浏览器，点这个键就在页面旁边打开。在里面看招聘页，一键把你的资料填进申请表，并附上合适的简历。', 'Dayjob\'s own browser: this key opens it beside the page. Read job pages in it, fill an application form with your details in one click, and attach the resume that fits.'] },
        { text: ['网站密码只保存在这台电脑上，登录时自动填好，不会交给任何 AI。', 'Site passwords stay on this computer and are filled in when you sign in. They are never given to any AI.'] },
      ],
      where: [
        { what: ['填表用的个人资料', 'The details used to fill forms'], at: ['简历与 AI → 申请资料', 'Resume & AI → Application profile'], in: 'resume' },
        { what: ['保存的密码', 'Saved passwords'], at: ['设置 → 密码保管', 'Settings → Passwords'], in: 'settings' },
        { what: ['清除登录状态和缓存', 'Clearing sign-ins and cache'], at: ['设置 → Dayjob 浏览器', 'Settings → Dayjob browser'], in: 'settings' },
      ],
    }] : []),
    {
      id: 'searches', view: 'searches', key: 'searches', target: [key('searches')],
      title: ['搜索与公司', 'Searches & companies'],
      say: [
        { text: ['每天抓什么，在这里定：“保存的搜索”里是关键词、地点和要看的招聘网站，“关注的公司”里是公司自己的招聘页。', 'What the daily search looks for is decided here: “Saved searches” hold the keywords, the place and the job sites, and “Followed companies” are companies\' own job boards.'] },
        { text: ['每次抓到多少、哪里没成功，看本页的“最近的抓取”。', 'How much each run found, and what failed, is under “Recent searches” on this page.'] },
      ],
      where: [
        { what: ['搜索和关注的公司', 'Searches and followed companies'], at: ['就在本页添加、修改和停用', 'add, edit and switch them off on this page'] },
        { what: ['每个来源抓多少', 'Results per source'], at: ['设置 → 每日抓取 → 每个来源抓多少', 'Settings → Daily search → Results per source'], in: 'settings' },
      ],
    },
    {
      id: 'resume', view: 'resume', key: 'resume', target: [key('resume')],
      title: ['简历与 AI', 'Resume & AI'],
      say: [
        { text: ['这里最多放三份简历，AI 打分时给每个岗位挑最合适的那一份。', 'Keep up to three resumes here; when the AI scores a job it picks the one that fits best.'] },
        browser
          ? { text: ['“申请资料”也在这页：姓名、联系方式、教育和工作经历，浏览器填表时用的就是它。', 'The “Application profile” is on this page too: your name, contact details, education and work history, which is what the browser fills forms with.'] }
          : { text: ['“申请资料”也在这页：姓名、联系方式、教育和工作经历。', 'The “Application profile” is on this page too: your name, contact details, education and work history.'] },
      ],
      where: [
        { what: ['用哪个 AI 和模型、什么时候打分、用了多少', 'Which AI and model, when to score, and how much was used'], at: ['本页的“AI 打分”', '“AI scoring” on this page'], in: 'resume' },
        { what: ['API key 和花费提醒', 'API keys and spending alerts'], at: ['设置 → API key、API 消费', 'Settings → API key, API spending'], in: 'settings' },
      ],
    },
    {
      id: 'settings', view: 'settings', key: 'settings', target: [key('settings')],
      title: ['设置', 'Settings'],
      say: [
        { text: ['其余的都在这页，一张卡片管一类：每日抓取、投递追踪、通知、API key、助手、密码保管、更新、声音与音乐、语言和外观。', 'Everything else is on this page, one card for each kind: daily search, application tracking, notifications, API keys, the assistant, passwords, updates, sound and music, language and look.'] },
        { text: ['从“每日抓取”到“JobSpy”这几项，改完要点“保存设置”才生效。', 'The cards from “Daily search” to “JobSpy” take effect once you click “Save settings”.'] },
      ],
      where: [
        { what: ['让电脑上的 Claude 也能用 Dayjob', 'Letting Claude on this computer use Dayjob'], at: ['设置 → 连接 Claude（MCP）', 'Settings → Connect Claude (MCP)'], in: 'settings' },
        { what: ['关窗口时退出还是留在托盘', 'Quit or stay in the tray when the window closes'], at: ['设置 → 关闭窗口时', 'Settings → Closing the window'], in: 'settings', desktop: true },
      ].filter(item => browser || !item.desktop),
    },
    {
      id: 'deck', target: ['.sidebar-foot .week-bars', '.sidebar-foot .turntable'],
      title: ['唱片机', 'The record player'],
      say: [
        { text: ['点一下唱片，马上开始一次抓取；抓取中再点一下就停下，已经抓到的会留着。', 'Click the record to start a search now. Click it again while it runs to stop it; what it has found is kept.'] },
        { text: ['它上面的七根小柱子，是这周每天投了几份。', 'The seven small bars above it are how many you applied to each day this week.'], when: '.sidebar-foot .week-bars' },
      ],
      where: [
        { what: ['每天自动抓取的时间', 'The time of the daily search'], at: ['设置 → 每日抓取', 'Settings → Daily search'], in: 'settings' },
      ],
    },
    {
      id: 'bell', target: ['.sidebar-foot > .nav-item'],
      title: ['通知', 'Notifications'],
      say: [
        { text: ['每天抓取的结果、分数高的新岗位、该跟进的投递、已经关闭的岗位，都会在这里告诉你。', 'The result of each day\'s search, new jobs that score high, applications due a follow-up and jobs that have closed are all reported here.'] },
      ],
      where: [
        { what: ['Windows 桌面通知、多少分算高匹配', 'Desktop notifications and the strong-match score'], at: ['设置 → 通知', 'Settings → Notifications'], in: 'settings' },
      ],
    },
    {
      id: 'look', target: ['.sidebar .brand'],
      title: ['外观与声音', 'Look and sound'],
      say: [
        { text: ['左上角这一排：点标志回到主页，小喇叭开关提示音，旁边的按钮切换中文和 English。', 'This row at the top left: the logo goes back to Home, the speaker turns sounds on and off, and the button beside it switches between 中文 and English.'] },
        { text: ['每页标题上方的时钟旁边，是白天和黑夜的开关。默认按时间自己换。', 'Beside the clock above each page\'s title is the day and night switch. By default it follows the time of day.'] },
      ],
      where: [
        { what: ['外观、打开动画', 'The look and the opening'], at: ['设置 → 语言、外观与数据', 'Settings → Language, look and data'], in: 'settings' },
        { what: ['提示音、琴键音效、跟随正在播放的音乐', 'Sounds, key sounds and following the music that is playing'], at: ['设置 → 声音与音乐', 'Settings → Sound and music'], in: 'settings' },
      ],
    },
    {
      id: 'assistant', target: ['.sidebar-foot .assistant-card'],
      title: ['我就住在这里', 'This is where I live'],
      say: [
        { text: ['点“小对话”，我在窗口右边陪着你；点“全屏”，整页都用来聊。对话默认不保存，想留下的点“保留这段对话”。', 'Click “Side chat” and I stay at the right of the window; click “Full page” to give the conversation the whole page. Conversations are not saved unless you click “Keep”.'] },
        { text: ['现在还找不到 Claude Code，所以我暂时回答不了。装好并登录它，或者到“设置 → 助手”改用 Claude API。', 'Claude Code was not found, so I cannot answer yet. Install it and sign in, or switch to the Claude API under Settings → Assistant.'], state: 'no-cli' },
        { text: ['还没有 Anthropic API key，所以我暂时回答不了。到“设置 → API key”添加一把，或者到“设置 → 助手”改用 Claude Code。', 'There is no Anthropic API key yet, so I cannot answer yet. Add one under Settings → API key, or switch to Claude Code under Settings → Assistant.'], state: 'no-key' },
      ],
      where: [
        { what: ['用 Claude Code 还是 Claude API、哪个模型', 'Claude Code or the Claude API, and which model'], at: ['设置 → 助手', 'Settings → Assistant'], in: 'settings' },
        { what: ['我替你记着的东西', 'What I keep in mind for you'], at: ['设置 → 助手的记忆', 'Settings → What the assistant keeps in mind'], in: 'settings' },
        ...(browser ? [{ what: ['投递前先问你，还是全交给我', 'Ask before sending, or leave it all to me'], at: ['对话框旁的“手动确认 / 全权接管”', '“Ask me first / Full takeover” beside the chat box'], in: 'chat' }] : []),
      ],
    },
  ];
  return steps;
}

const pick = (pair, lang) => (lang === 'en' ? pair[1] : pair[0]);

// The paragraphs of a step that are said just now: `seen(selector)` tells whether an element is in sight, and
// `state` is the assistant's (ready | no-cli | no-key).
export function spoken(step, lang, { seen = () => true, state = 'ready' } = {}) {
  return step.say.filter(part => (!part.when || seen(part.when)) && (!part.state || part.state === state)).map(part => pick(part.text, lang));
}

// How long a paragraph takes to say, in ms: about as long in either language, a little over a second for a short
// line and never more than a few seconds.
export function sayTime(text, lang) {
  const perChar = lang === 'en' ? 11 : 26;
  return Math.round(Math.max(500, Math.min(3200, text.length * perChar)));
}

// ---------- where things go on the window ----------

const round = value => Math.round(value);

// The lit box: the boxes of the step's targets joined into one, a few pixels larger, kept inside the window.
// rects are { left, top, right, bottom }; boxes with no size (hidden parts) are left out. Null when nothing is left.
export function spotBox(rects, view, pad = 6) {
  const shown = rects.filter(rect => rect && rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1);
  if (!shown.length) return null;
  const left = Math.max(0, Math.min(...shown.map(rect => rect.left)) - pad);
  const top = Math.max(0, Math.min(...shown.map(rect => rect.top)) - pad);
  const right = Math.min(view.width, Math.max(...shown.map(rect => rect.right)) + pad);
  const bottom = Math.min(view.height, Math.max(...shown.map(rect => rect.bottom)) + pad);
  return { left: round(left), top: round(top), width: round(right - left), height: round(bottom - top) };
}

// Where the assistant's card stands: in the middle of the window when nothing is lit, otherwise to the right of
// the lit box, level with it, never over the window's edge. `tail` is how far down the card its pointer sits (it
// points at the middle of the lit box), or null when the card stands free.
export function placeCard({ spot, card, view, gap = 18, margin = 12 }) {
  const maxLeft = Math.max(margin, view.width - margin - card.width);
  const maxTop = Math.max(margin, view.height - margin - card.height);
  if (!spot) {
    return { left: round(Math.min(maxLeft, Math.max(margin, (view.width - card.width) / 2))),
      top: round(Math.min(maxTop, Math.max(margin, (view.height - card.height) / 2))), tail: null };
  }
  const middle = spot.top + spot.height / 2;
  const left = Math.min(maxLeft, spot.left + spot.width + gap);
  // The pointer sits near the card's top, so a card beside a key reads from the key down.
  const top = Math.min(maxTop, Math.max(margin, middle - Math.min(56, card.height / 2)));
  const beside = left >= spot.left + spot.width;
  return { left: round(left), top: round(top), tail: beside ? round(Math.min(card.height - 24, Math.max(24, middle - top))) : null };
}
