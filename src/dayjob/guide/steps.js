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
//   terms   the Settings guide's list of what the settings in a group do: { name: [中文, English], means: [...] }.
//           `name` is the setting's own label on the page, checked the same way.
//   note    a line under the buttons: [中文, English]
//
// There are two guides. guideSteps is the one of the first day: a greeting, then every page of Dayjob. settingsSteps
// goes down the Settings page group by group and says in plain words what each setting does; it is asked for on
// that page ("Explain settings", or the question mark beside a group's title, which starts it at that group).
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
        { what: ['哪一组设置看不懂', 'A group of settings you are not sure about'], at: ['点它标题右边的问号，或本页右上角的“讲解设置”，我一项一项讲', 'click the question mark beside its title, or “Explain settings” at the top right of this page, and I go through it'], in: 'settings' },
        { what: ['让电脑上的 Claude 也能用 Dayjob', 'Letting Claude on this computer use Dayjob'], at: ['设置 → 连接 Claude（MCP）', 'Settings → Connect Claude (MCP)'], in: 'settings' },
        { what: ['关窗口时退出还是留在托盘', 'Quit or stay in the tray when the window closes'], at: ['设置 → 关闭窗口时', 'Settings → Closing the window'], in: 'settings', desktop: true },
      ].filter(item => browser || !item.desktop),
    },
    {
      id: 'deck', target: ['.sidebar-foot .turntable'],
      title: ['唱片机', 'The record player'],
      say: [
        { text: ['点一下唱片，马上开始一次抓取；抓取中再点一下就停下，已经抓到的会留着。', 'Click the record to start a search now. Click it again while it runs to stop it; what it has found is kept.'] },
        { text: ['唱片旁边那行小字，是下一次自动抓取的时间，或者正在抓取的进度。', 'The small line by the record is when the next daily search runs, or how far the one under way has come.'] },
      ],
      where: [
        { what: ['每天自动抓取的时间', 'The time of the daily search'], at: ['设置 → 每日抓取', 'Settings → Daily search'], in: 'settings' },
      ],
    },
    {
      id: 'bell', target: ['.sidebar-foot [data-fx="bell"]'],
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

// The Settings guide: one step for each group of settings on the page, top to bottom. A group is marked on the page
// with data-guide="<id>" (on its card, or on each of its parts where several groups share a card), and that is what
// the step lights. Groups the page does not show (the desktop app's own, in a web browser) are left out by Guide.jsx.
const group = id => [`[data-guide="${id}"]`];

export function settingsSteps({ browser = true } = {}) {
  const steps = [
    {
      id: 'daily', target: group('daily'),
      title: ['每日抓取', 'Daily search'],
      say: [
        { text: ['Dayjob 每天自己去招聘网站找一遍新岗位。这一组定它什么时候去、旧岗位留多久。', 'Each day Dayjob goes to the job sites by itself to look for new jobs. This group sets when it goes and how long old jobs are kept.'] },
      ],
      terms: [
        { name: ['每天自动抓取', 'Search every day'], means: ['关掉后，只有你点侧边栏的唱片时才抓。', 'Off, a search runs only when you click the record in the sidebar.'] },
        { name: ['时间', 'Time'], means: ['每天几点开始。那时电脑关着也不要紧，当天再打开 Dayjob 会补上。', 'When it starts each day. If the computer is off at that time, Dayjob catches up when it next opens that day.'] },
        { name: ['岗位保留天数', 'Keep jobs (days)'], means: ['没收藏、没投递的岗位，过了这么多天自动清掉。', 'Jobs you neither saved nor applied to are cleared after this many days.'] },
      ],
      note: ['从这里到 JobSpy 这几组，改完要点它们下面的“保存设置”才生效。', 'The groups from here to JobSpy take effect once you click “Save settings” below them.'],
    },
    {
      id: 'sources', target: group('sources'),
      title: ['每个来源抓多少', 'Results per source'],
      say: [
        { text: ['来源指的是各个招聘网站。这里定每次抓取向每个网站最多要多少条结果。', 'A source is a job site. This sets how many results each site is asked for, at most, in one run.'] },
      ],
      terms: [
        { name: ['按每个搜索', 'By each search'], means: ['每个搜索用它自己填的数，在“搜索与公司”里改。最省心。', 'Each search uses its own number, set under “Searches”. The simplest choice.'] },
        { name: ['按个数', 'By number'], means: ['给每个网站定一个数，比如 LinkedIn 50 条、Indeed 20 条。0 就是不抓它。', 'Give each site a number of its own, say 50 from LinkedIn and 20 from Indeed. 0 leaves a site out.'] },
        { name: ['按比例', 'By share'], means: ['只定一个总数，再按份数分：填 3 和 1，就是 75% 和 25%。', 'Set one total and split it by shares: 3 and 1 make 75% and 25%.'] },
      ],
    },
    {
      id: 'tracking', target: group('tracking'),
      title: ['投递追踪', 'Application tracking'],
      say: [
        { text: ['投出去以后，Dayjob 替你盯着：该跟进了提醒你，太久没消息的标出来。', 'After you apply, Dayjob keeps watch for you: it reminds you to follow up and flags the applications that have gone quiet.'] },
      ],
      terms: [
        { name: ['跟进提醒（天）', 'Follow-up reminder (days)'], means: ['投递或状态变化后过这么多天，通知你去问一声。填 0 就不提醒。', 'This many days after you apply or a status changes, a notification suggests you follow up. 0 turns it off.'] },
        { name: ['无回音提示（天）', 'No-reply flag (days)'], means: ['一份投递停在“已投递”超过这么多天，就标成没有回音。', 'An application still at “Applied” after this many days is flagged as having no reply.'] },
        { name: ['每天检查已投递和已收藏的岗位是否关闭', 'Check daily whether applied and saved jobs have closed'], means: ['每天去看一眼原帖，岗位下架了就告诉你。', 'Each day Dayjob looks at the original posting and tells you when it has been taken down.'] },
      ],
    },
    {
      id: 'notify', target: group('notify'),
      title: ['通知', 'Notifications'],
      say: [
        { text: ['Dayjob 有消息时怎么告诉你，以及多少分的岗位值得单独提一句。', 'How Dayjob tells you its news, and which score makes a job worth a line of its own.'] },
      ],
      terms: [
        { name: ['Windows 桌面通知', 'Windows desktop notifications'], means: ['开着，消息从屏幕右下角弹出来；关掉，就只在侧边栏的“通知”里看。', 'On, messages pop up at the corner of the screen. Off, you read them under “Notifications” in the sidebar.'] },
        { name: ['高匹配分数线', 'Strong-match score'], means: ['AI 给每个岗位打 0 到 100 分。达到这个分数的新岗位，在每日汇总里单独列出来。', 'The AI scores every job from 0 to 100. New jobs at or above this score are listed by name in the daily summary.'] },
      ],
    },
    {
      id: 'jobspy', target: group('jobspy'),
      title: ['JobSpy 抓取工具', 'JobSpy'],
      say: [
        { text: ['JobSpy 是替 Dayjob 去 Glassdoor、ZipRecruiter 和 Google Jobs 抓岗位的小工具。安装版自带，一般不用动。', 'JobSpy is a small tool that fetches jobs from Glassdoor, ZipRecruiter and Google Jobs for Dayjob. The installed app carries its own, so there is usually nothing to change.'] },
      ],
      terms: [
        { name: ['Dayjob 自带的', 'The one inside Dayjob'], means: ['推荐。装好 Dayjob 就能用，不需要另外安装 Python。', 'Recommended. It works as soon as Dayjob is installed, with no Python to set up.'] },
        { name: ['我自己的 Python', 'My own Python'], means: ['只有你自己装了 Python 和 JobSpy、想用自己那一份时才选。', 'Only if you installed Python and JobSpy yourself and want to use that copy.'] },
        { name: ['Python 命令', 'Python command'], means: ['用自己的 Python 时，填启动它的命令，比如 python 或 py。', 'With your own Python, the command that starts it, such as python or py.'] },
      ],
    },
    {
      id: 'keys', target: group('keys'),
      title: ['API key（密钥）', 'API key'],
      say: [
        { text: ['API key 是向 Claude 或 OpenAI 按用量付费的凭证。只有想用 API 来打分或让助手回答时才需要；用这台电脑上已登录的 Claude Code，就不用填。', 'An API key is what lets Dayjob use Claude or OpenAI and pay by use. You need one only to run scoring or the assistant on the API. With the Claude Code signed in on this computer, none is needed.'] },
      ],
      terms: [
        { name: ['使用中', 'In use'], means: ['存了好几把时，每种服务只用标着“使用中”的那一把；点“用这个”换一把。', 'With several keys saved, each service uses the one marked “In use”. Click “Use this” to switch.'] },
        { name: ['检查', 'Check'], means: ['问一下 Claude 这把 key 能不能用，不花钱。', 'Asks Claude whether the key works. It costs nothing.'] },
        { name: ['工作区 ID', 'Workspace ID'], means: ['只有能用于所有工作区的 key 才要填，在 Claude Console 的 Workspaces 页能查到。', 'Needed only for a key that works in every workspace. It is on the Workspaces page of the Claude Console.'] },
      ],
    },
    {
      id: 'spend', target: group('spend'),
      title: ['API 消费', 'API spending'],
      say: [
        { text: ['Dayjob 自己记的一本账：用 API key 打分和聊天，折成美元花了多少。走订阅的 Claude Code 不花这里的钱。', 'Dayjob\'s own tally of what scoring and chatting with your API keys cost, in US dollars. Claude Code on a subscription costs nothing here.'] },
        { text: ['这些数只算 Dayjob 里的调用，同一把 key 在别处用掉的不在内，实际以服务商的账单为准。', 'The sums count only calls made in Dayjob, not what the same key spends elsewhere. The service\'s bill is what counts.'] },
      ],
      terms: [
        { name: ['设置额度', 'Set allowance'], means: ['给一把 key 定一个预算。填了以后能看到还剩百分之几，快用完时发通知。', 'A budget for one key. With it you see what share is left, and a notification says when it runs low.'] },
      ],
    },
    {
      id: 'mcp', target: group('mcp'),
      title: ['连接 Claude（MCP）', 'Connect Claude (MCP)'],
      say: [
        { text: ['MCP 是让别的 AI 程序使用 Dayjob 的接口。连上以后，在 Claude Code 或 Claude Desktop 里说一句话，Claude 就能查看和修改 Dayjob 里的岗位和投递。', 'MCP is how other AI apps use Dayjob. Once connected, Claude Code or Claude Desktop can look up and change the jobs and applications in Dayjob when you ask.'] },
        { text: ['侧边栏里的助手用不着它，不连也照常工作。', 'The assistant in the sidebar does not need it and works without it.'] },
      ],
      terms: [
        { name: ['连接到 Claude', 'Connect to Claude'], means: ['把 Dayjob 写进 Claude 的配置文件，改之前自动备份。', 'Writes Dayjob into Claude\'s config files, with a backup made first.'] },
        { name: ['重新检查', 'Check again'], means: ['再看一眼现在连上了没有。', 'Looks again at whether it is connected.'] },
      ],
    },
    {
      id: 'assistant', target: group('assistant'),
      title: ['助手', 'Assistant'],
      say: [
        { text: ['侧边栏那台留声机由谁来思考、用哪个模型，在这里定。', 'Who does the thinking for the gramophone in the sidebar, and with which model, is set here.'] },
      ],
      terms: [
        { name: ['引擎', 'Engine'], means: ['Claude Code 用这台电脑上已登录的订阅，不需要 key；Claude API 用你的 API key，按用量计费。', 'Claude Code uses the subscription signed in on this computer and needs no key. The Claude API uses your API key and bills by use.'] },
        { name: ['模型', 'Model'], means: ['用哪一款 Claude。越强的越慢、越贵；拿不准就留着默认的。', 'Which Claude model. Stronger ones are slower and cost more. Leave the default if unsure.'] },
        ...(browser ? [{ name: ['替你投递', 'Applying for you'], means: ['“手动确认”是提交前先问你；“全权接管”是助手自己点提交。', '“Ask me first” asks before anything is sent. “Full takeover” lets the assistant click Submit itself.'] }] : []),
      ],
    },
    {
      id: 'memory', target: group('memory'),
      title: ['助手的记忆', 'What the assistant keeps in mind'],
      say: [
        { text: ['把每次都一样的答案写在这里，比如需不需要签证担保。助手填申请表时照着答，不再每次问你。', 'Write down the answers that never change, such as whether you need visa sponsorship. The assistant uses them when it fills in forms and stops asking each time.'] },
        { text: ['这些内容会随对话发给模型，所以不要写密码。', 'These notes go to the model with a conversation, so do not write passwords here.'] },
      ],
      terms: [
        { name: ['记住', 'Remember'], means: ['把输入框里那一行存成一条记忆。在对话里让助手记住什么，它也会自己记到这里。', 'Saves the line in the box as a note. Tell the assistant to remember something in a chat and it adds a note here itself.'] },
      ],
    },
    ...(browser ? [{
      id: 'vault', target: group('vault'),
      title: ['密码保管', 'Passwords'],
      say: [
        { text: ['招聘网站的账号和密码存在这里，只留在这台电脑上，由系统加密。在 Dayjob 浏览器里打开登录页时自动填好，不会交给任何 AI。', 'Your job-site accounts are kept here, on this computer only, encrypted by the system. They are filled in on login pages in the Dayjob browser and are never given to any AI.'] },
      ],
      terms: [
        { name: ['设置开箱密码', 'Set a vault password'], means: ['给密码箱加一把锁：要在这里查看或修改密码，得先输入它。上了锁，浏览器照样自动填。', 'Puts a lock on the vault: you enter it before passwords can be seen or changed here. The browser still fills them in while it is locked.'] },
        { name: ['从浏览器导入', 'Import from a browser'], means: ['把 Edge 或 Chrome 导出的密码文件一次导进来。', 'Brings in, all at once, the password file exported from Edge or Chrome.'] },
      ],
    }, {
      id: 'browser', target: group('browser'),
      title: ['Dayjob 浏览器', 'Dayjob browser'],
      say: [
        { text: ['Dayjob 自带的浏览器有它自己的一份登录状态，和 Chrome、Edge 互不相干。', 'Dayjob\'s own browser keeps its own sign-ins, apart from Chrome and Edge.'] },
      ],
      terms: [
        { name: ['清除登录状态和缓存', 'Clear sign-ins and cache'], means: ['让里面所有网站都退出登录，并清空缓存。某个网站打不开或登录出错时可以试试；密码保管里的密码不受影响。', 'Signs you out of every site in it and empties the cache. Worth a try when a site will not load or a sign-in goes wrong. Passwords kept in the vault are not touched.'] },
      ],
    }, {
      id: 'close', target: group('close'),
      title: ['关闭窗口时', 'Closing the window'],
      say: [
        { text: ['点窗口右上角的关闭按钮时，Dayjob 是留在后台，还是完全退出。', 'Whether Dayjob stays in the background or quits when you close its window.'] },
      ],
      terms: [
        { name: ['关闭窗口后继续在后台运行', 'Keep running in the tray'], means: ['开着：窗口关了，Dayjob 还在屏幕右下角的托盘里，按时抓取、发提醒。关掉：关窗口就是退出，错过的抓取等当天再打开时补上。',
          'On: with the window closed, Dayjob stays in the tray at the corner of the screen, so the daily search and reminders still run. Off: closing the window quits it, and a missed search runs when you next open Dayjob that day.'] },
      ],
    }, {
      id: 'updates', target: group('updates'),
      title: ['更新', 'Updates'],
      say: [
        { text: ['有新版本时，侧边栏的“检查更新”会变成下载按钮；下载完点“重启并更新”，你的数据都会保留。', 'When a new version is out, “Check for updates” in the sidebar turns into a download button. Once it has downloaded, click “Restart to update”. Your data stays.'] },
      ],
      terms: [
        { name: ['每天自动检查一次', 'Check once a day'], means: ['关掉后，只有你点“立即检查”时才检查。', 'Off, Dayjob looks for a new version only when you click “Check now”.'] },
      ],
    }] : []),
    {
      id: 'sound', target: group('sound'),
      title: ['声音与音乐', 'Sound and music'],
      say: [
        { text: ['Dayjob 的提示音，和跟着音乐动的那些效果。全都可以关，不影响任何功能。', 'Dayjob\'s sounds, and the motion that follows your music. All of it can be turned off without losing anything.'] },
      ],
      terms: [
        { name: ['提示音', 'Sounds'], means: ['落分、投递、开始抓取时响的一个短音。', 'A short note when a score lands, you apply or a search starts.'] },
        { name: ['琴键音效', 'Key sounds'], means: ['按侧边栏的键时，用哪一套音色。', 'Which set of tones the sidebar keys play.'] },
        { name: ['按键间隔', 'Key gap'], means: ['连着快点侧边栏时，这段时间里只响第一下。', 'When you click sidebar keys quickly, only the first one in this time sounds.'] },
        ...(browser ? [{ name: ['跟随音乐', 'Follow music'], means: ['音乐软件放歌时，唱片机和页面顶上的声浪跟着动。声音只在本机分析，不录音。', 'While a music app plays, the record player and the wave at the top of each page move with it. The sound is analysed on this computer and never recorded.'] }] : []),
      ],
    },
    {
      id: 'look', target: group('look'),
      title: ['语言、外观与数据', 'Language, look and data'],
      say: [
        { text: ['界面用什么语言、什么明暗，还有你的数据放在哪里。', 'The language and the look of the interface, and where your data is kept.'] },
      ],
      terms: [
        { name: ['界面语言', 'Language'], means: browser ? ['界面用中文还是 English，通知和托盘菜单跟着换。', 'The interface in 中文 or English. Notifications and the tray menu follow it.'] : ['界面用中文还是 English，通知跟着换。', 'The interface in 中文 or English. Notifications follow it.'] },
        { name: ['外观', 'Appearance'], means: ['“按时间”是白天浅色、晚上深色，到点自己换；也可以跟随系统，或者固定一种。', '“By the clock” is light by day and dark by night, changing by itself. Or follow the system, or keep one look.'] },
        { name: ['打开动画', 'Opening'], means: ['打开 Dayjob 时那一小段像素动画，不想看可以关掉。', 'The short pixel animation when Dayjob opens. Turn it off if you would rather not see it.'] },
        { name: ['数据库', 'Database'], means: ['你的岗位、投递和设置都存在这台电脑上的这个文件里。', 'Your jobs, applications and settings are kept in this file, on this computer.'] },
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
// rects are { left, top, right, bottom }; boxes with no size (hidden parts) are left out. Null when nothing is left,
// or when what is left lies outside the window.
export function spotBox(rects, view, pad = 6) {
  const shown = rects.filter(rect => rect && rect.right - rect.left >= 1 && rect.bottom - rect.top >= 1);
  if (!shown.length) return null;
  const left = Math.max(0, Math.min(...shown.map(rect => rect.left)) - pad);
  const top = Math.max(0, Math.min(...shown.map(rect => rect.top)) - pad);
  const right = Math.min(view.width, Math.max(...shown.map(rect => rect.right)) + pad);
  const bottom = Math.min(view.height, Math.max(...shown.map(rect => rect.bottom)) + pad);
  // Scrolled out of the window altogether: nothing is lit.
  if (right - left < 1 || bottom - top < 1) return null;
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

// The Settings guide's card stands in the column kept free for it at the window's right (App makes the page
// narrower meanwhile), its top level with the top of the lit group, so the two read side by side. `tail` points at
// the group's title. With nothing lit (the group has been scrolled away) it keeps to the top of that column.
export function dockCard({ spot, card, view, margin = 12 }) {
  const left = Math.max(margin, view.width - margin - card.width);
  const maxTop = Math.max(margin, view.height - margin - card.height);
  if (!spot) return { left: round(left), top: margin, tail: null };
  const top = Math.min(maxTop, Math.max(margin, spot.top));
  const title = spot.top + Math.min(28, spot.height / 2);
  const beside = left >= spot.left + spot.width;
  return { left: round(left), top: round(top), tail: beside ? round(Math.min(card.height - 24, Math.max(24, title - top))) : null };
}
