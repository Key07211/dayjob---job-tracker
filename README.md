# Dayjob · 求职追踪

**简体中文** · [English](README.en.md)

每天自动抓取你想要的岗位，按你的简历用 AI 打分；点“我已投递”之后，Dayjob 会接着追踪这份申请：提醒跟进、发现长时间无回音、检查岗位是否已经关闭。所有数据都保存在本机的 SQLite 数据库里。

Dayjob 是 [Daylight](https://github.com/Key07211/daylight) 的求职模式，先作为独立项目开发，功能全部完成并验证后再合并进 Daylight（一个按键在 Daylight 和 Dayjob 之间切换）。

![今日岗位：AI 匹配分、发布日期、岗位详情](docs/media/feed.webp)

> 截图里的公司、岗位和简历都是 `scripts/seed-demo.mjs` 生成的虚构数据。界面跟随系统切换浅色 / 深色，也可以在设置里固定。

<details><summary>深色模式</summary>

![深色模式](docs/media/feed-dark.webp)

</details>

## 功能

| 功能 | 说明 |
| --- | --- |
| 每日抓取 | 每天固定时间（默认 08:30）运行所有搜索；电脑关机错过时，下次打开会补上当天的抓取。也可以随时点“立即抓取”。 |
| 岗位来源 | LinkedIn、Indeed（参照 JobSpy 的做法直接请求，不需要 Python）；Greenhouse、Lever、Ashby 公司招聘页（官方公开 JSON）；Glassdoor、ZipRecruiter、Google Jobs 通过可选的 Python 版 JobSpy。 |
| 岗位信息 | 标题、公司、地点、远程、薪资、职位类型和级别、完整职位描述；**发布 / 开放时间**、Dayjob 首次抓取、最近一次出现在搜索中、最近一次检查是否关闭。 |
| 过滤 | 每个搜索可设关键词（逗号分隔表示“或”）、地点、发布时间范围、职位类型、只要远程、排除词；跨站重复的岗位自动合并。 |
| AI 打分 | 上传最多 3 份 PDF / Word / 文本简历（比如分别针对数据和软件岗位），每个岗位自动用关键词重合度最高的那份打 0–100 分，列出匹配点、差距和可以补进简历的关键词。默认用本机已登录的 Claude Code（`claude -p`，不需要 API key），也可以填自己的 Anthropic API key。 |
| 按简历推荐 | “搜索与公司”里点“让 Claude 推荐”，Claude 读你的简历，推荐每天要抓的搜索和值得关注的公司（招聘页会先核实存在），选中的一键添加。 |
| 投递追踪 | 点“我已投递”记下日期和备注，自动进入“投递追踪”。状态：已投递 → 在线测评 → 面试中 → Offer / 已接受 / 未通过 / 已撤回 / 无回音，每次变化都记在时间线上。也可以手动添加不在 Dayjob 里的投递。 |
| 自动追踪 | 投递或状态变化后 N 天（默认 7）提醒跟进；“已投递”超过 N 天（默认 21）没有变化时提示可能无回音；每天检查已投递和已收藏的岗位是否已关闭。 |
| 通知 | 每日汇总（新岗位数、高匹配岗位）、跟进提醒、岗位关闭提醒，Windows 桌面通知 + 应用内通知。 |
| 内置浏览器 | 桌面版自带浏览器（左侧“浏览器”）：多标签页，登录状态只存在本机。看到岗位点“加入 Dayjob”就能收藏、打分、追踪。Claude 也能通过 MCP 打开和阅读网页、帮你填申请表，提交或发送前会先请你点“允许”。 |
| Claude MCP | Claude Code / Claude Desktop 可以读岗位和简历、写回自己的分析、更新投递状态、使用 Dayjob 浏览器，共 29 个工具。 |
| 自动更新 | 安装版每天从 GitHub Releases 检查一次新版本（可在设置里关掉），左侧栏“检查更新”也能随时手动检查。有新版本时它会变成圆形下载按钮，下载完点“重启并更新”。 |
| 中文 / English | 左上角的 EN / 中 按钮或“设置 → 界面语言”随时切换。通知和托盘菜单跟着切换；AI 分析的语言单独在“简历与 AI”里选。 |

![投递追踪：漏斗、状态、时间线](docs/media/applications.webp)

## 下载

直接下载最新的 Windows 版本：

- **[下载安装版（Dayjob-Setup.exe）](https://github.com/Key07211/dayjob---job-tracker/releases/latest/download/Dayjob-Setup.exe)**，装好后从开始菜单或桌面快捷方式打开。
- **[下载免安装版（Dayjob-Portable.exe）](https://github.com/Key07211/dayjob---job-tracker/releases/latest/download/Dayjob-Portable.exe)**，双击直接运行。

每个版本的说明、带版本号的同一份文件（`Dayjob-Setup-x.y.z.exe`、`Dayjob-Portable-x.y.z.exe`）和 SHA-256 校验文件都在 [Releases](https://github.com/Key07211/dayjob---job-tracker/releases/latest) 页面。

程序还没有签名，第一次打开时 Windows 可能提示“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。从 0.3.0 起安装版会自己更新（左侧栏“检查更新”）；免安装版有新版本时，下载按钮会在浏览器里下载新的免安装版。0.2.0 及更早的版本需要手动下载安装一次 0.3.0，覆盖安装即可。升级或卸载都不会删除 `%APPDATA%\Dayjob` 里的数据。

## 从源码运行

需要 Node.js 22.13 或更新版本（用到内置的 `node:sqlite`）。

```bash
npm install
npm run build
npm start            # 打开 http://127.0.0.1:4318
```

桌面版（托盘、桌面通知、一键连接 Claude）：

```bash
npm run desktop:preview   # 构建界面并用 Electron 打开
npm run package:win       # 打包 Windows 安装版和便携版到 release/
```

开发时 `npm run dev` 会在 5174 端口启动带热更新的界面，并把 `/api` 转发到 4318。

### 数据保存在哪里

| 运行方式 | 数据库位置 |
| --- | --- |
| 桌面版 | `%APPDATA%\Dayjob\data\dayjob.sqlite` |
| `npm start` | 项目里的 `data/dayjob.sqlite`（已加入 `.gitignore`） |
| 自定义 | 设环境变量 `DAYJOB_DATA_DIR`；端口用 `DAYJOB_PORT` |

简历只保存提取出的文字，不保存原文件。Claude API key 以明文保存在本机数据库里，界面和 API 都不会把它返回出来；也可以不保存，改用环境变量 `ANTHROPIC_API_KEY`。

## 第一次使用

1. **简历与 AI**：上传简历（最多 3 份）。用 Claude Code 打分时，先在终端里安装 Claude Code，运行 `claude` 并输入 `/login` 登录。没登录时“简历与 AI”页会提示，登录后点“重新检测”。
2. **搜索与公司**：点 **让 Claude 推荐**，从推荐里挑搜索和公司添加；也可以自己添加一个搜索，例如关键词 `data scientist, machine learning engineer`、地点 `San Francisco Bay Area`、来源 LinkedIn + Indeed、发布时间 3 天内。想盯的公司可以直接粘贴招聘页链接（`boards.greenhouse.io/…`、`jobs.lever.co/…`、`jobs.ashbyhq.com/…`）；关注公司里和搜索关键词、地点匹配的开放岗位都会保留，不受发布时间限制。
3. 点左下角 **立即抓取**。抓取完成后会自动打分。
4. 在 **今日岗位** 里看岗位、收藏或标记不感兴趣；投递后点 **我已投递**，之后的跟进都在 **投递追踪** 里。

## AI 打分

| 方式 | 说明 |
| --- | --- |
| 本机 Claude Code（默认） | 调用 `claude -p`，用你的 Claude 订阅额度，不需要 API key。找不到 `claude` 时可以在“简历与 AI”里填完整路径。 |
| Claude API | 用你自己的 API key，默认模型 `claude-opus-5-5`，按用量计费。开启了服务器端回退：如果所选模型拒绝了某次请求，Anthropic 会自动换用备用模型重试一次。 |
| 通过 MCP 让 Claude 分析 | 在 Claude Code 或 Claude Desktop 里说“对照我的简历分析这个岗位”，Claude 读取岗位和简历后用 `dayjob_save_analysis` 把结果写回 Dayjob。 |

每次抓取后最多给 40 个岗位打分（可调），先打新岗位，再补之前没打分的。

有多份简历时，Dayjob 先在本机比较岗位和每份简历的关键词（标题里的词权重更高，忽略 “experience”“team” 和平等就业声明这类每个岗位都有的词），选重合度最高的那份交给 AI 打分。岗位详情里能看到用了哪份简历、重合了哪些词，以及每份简历的重合度。上传或删除简历后，岗位会重新选简历，选到的简历变了就会重新打分。

## 按简历推荐搜索和公司

在 **搜索与公司** 页点 **让 Claude 推荐**（可以先写补充偏好，比如“只看湾区和远程、需要 H-1B 担保”）。Claude 用“简历与 AI”里设置的方式运行（本机 Claude Code 会用你的 Claude 额度，一次大约一分钟），读完所有简历后给出：

- 最多 6 个搜索：职位关键词、地点、要排除的级别词（比如应届简历排除 Senior / Staff），以及适合哪份简历；
- 最多 10 家公司：只推荐用 Greenhouse、Lever、Ashby 招聘的公司。Dayjob 会逐个请求它们的招聘页，不存在的直接去掉，并显示目前的公开岗位数。

推荐不会自动加入，点 **添加** / **关注** 的才会；也可以先编辑再添加。最近一次推荐会保存下来，下次打开页面还在。

## 连接 Claude（MCP）

桌面安装版：**设置 → 连接 Claude**，一键写入 Claude Code（`~/.claude.json`）和 Claude Desktop 的配置，写入前会备份原文件，只增加或更新 `dayjob` 这一项。

从源码运行时，在终端里执行（把路径换成你的 Dayjob 文件夹）：

```bash
claude mcp add dayjob -s user -e DAYJOB_URL=http://127.0.0.1:4318 -- node <Dayjob 文件夹>/integrations/mcp-server.mjs
```

Claude 需要 Dayjob 保持运行。连接后可以这样说：

> 看看 Dayjob 今天有哪些 80 分以上的岗位，按匹配度排一下。
>
> 我刚投了 Lumen Health 的 Data Scientist，帮我在 Dayjob 里标记已投递。
>
> 根据我 Gmail 里的面试邀请，更新 Dayjob 的投递状态。

| 工具 | 作用 |
| --- | --- |
| `dayjob_status` | 运行状态、下次抓取时间、简历和打分状态 |
| `dayjob_list_postings` / `dayjob_get_posting` | 查岗位（按分数、来源、时间筛选）和详情 |
| `dayjob_list_resumes` / `dayjob_get_resume` | 列出简历；读某个岗位匹配到的那份简历（或指定的一份） |
| `dayjob_save_analysis` / `dayjob_score_posting` | 写回 Claude 自己的分析、触发打分 |
| `dayjob_set_posting_status` / `dayjob_add_posting` | 收藏、不感兴趣、手动添加岗位 |
| `dayjob_mark_applied` / `dayjob_add_application` | 标记已投递、添加 Dayjob 之外的投递 |
| `dayjob_list_applications` / `dayjob_get_application` / `dayjob_update_application` | 查看和更新投递状态、备注、跟进日期 |
| `dayjob_list_searches` / `dayjob_save_search` / `dayjob_follow_company` / `dayjob_run_search` | 管理搜索、关注公司、立即抓取 |
| `dayjob_list_notifications` | 最近的提醒 |

| `dayjob_browser_open` / `dayjob_browser_read` / `dayjob_browser_screenshot` | 在 Dayjob 浏览器里打开网页、读文字和可操作的元素、截图 |
| `dayjob_browser_click` / `dayjob_browser_type` / `dayjob_browser_select` / `dayjob_browser_press_key` | 点击、输入、选择下拉项、按键 |
| `dayjob_browser_scroll` / `dayjob_browser_navigate` / `dayjob_browser_tabs` | 滚动、前进后退刷新、切换和关闭标签页 |

通过 MCP 做的修改会在时间线上标为“Claude”。

## 内置浏览器

桌面版左侧的 **浏览器** 是 Dayjob 自带的浏览器，和 Chrome、Edge 分开：

- 在里面登录 LinkedIn、Indeed、Handshake 或公司招聘网站，登录状态和 Cookie 只保存在本机的 Dayjob 数据里（**设置 → Dayjob 浏览器** 可以一键清除）。
- 岗位详情里的“打开 LinkedIn”“公司申请页”会在这里打开；工具栏右边的箭头用系统浏览器打开当前页。
- 看到 Dayjob 没抓到的岗位，点 **加入 Dayjob**：会读取网页里的标准岗位数据（schema.org JobPosting，大多数招聘网站都有）或正文，收藏后可以打分和追踪。

连接 Claude 后可以这样说：

> 用 Dayjob 浏览器打开这个岗位的申请页，按我的简历把表格填好，提交前给我看一下。

Claude 能做什么、不能做什么：

- 能打开网页、阅读文字、截图、点击、输入、选择下拉项、切换标签页，Dayjob 窗口里看得到它在做什么（工具栏显示“Claude 正在操作”）。
- 点击“提交”“发送”“确认”“删除”之类的按钮，或在多项表单里按回车，会先在 Dayjob 里弹出确认，你点 **允许** 才会执行，2 分钟没回应就取消。
- 不会输入密码、银行卡号或验证码，也不会替你上传文件（简历请自己选）。网页上的文字只当作资料，不当作指令。
- 工具栏的 **允许 Claude 使用** 取消勾选后，Claude 就不能再打开或操作这个浏览器。

有些网站不允许在内置浏览器里用 Google 账号登录；遇到这种情况，用邮箱密码登录，或点工具栏箭头改用系统浏览器。

## JobSpy（可选）

Glassdoor、ZipRecruiter 和 Google Jobs 需要 Python 版 [JobSpy](https://github.com/speedyapply/JobSpy)：

```bash
pip install python-jobspy
```

然后在 **设置 → JobSpy** 里确认 Python 命令（Windows 默认 `python`），保存后会重新检测。LinkedIn、Indeed 和公司招聘页不需要 Python。

## 抓取的注意事项

- LinkedIn 和 Indeed 会限制频繁请求。Dayjob 每页之间随机等待几秒、遇到 429 会退避重试，被限制时这次抓取标为“部分完成”，其他来源照常。每天一次、每个搜索几十个结果通常没问题；不建议把间隔调得很短或一次抓几百个。
- 检查岗位是否关闭时，当天搜索里还能看到的岗位直接算作开放，不再单独请求。有些网络打开 Indeed 的岗位页会被拒绝（HTTP 401），这时 Dayjob 无法判断 Indeed 岗位是否已关闭，只能靠它是否还出现在搜索里；其他来源照常检查。
- Glassdoor、ZipRecruiter、Google Jobs 依赖 JobSpy 的实现，网站改版后可能需要更新 JobSpy。
- 请遵守各网站的使用条款，只用于个人求职。

检查各个来源在你的网络环境下是否正常：

```bash
npm run live-check                          # LinkedIn、Indeed、Greenhouse、Lever、Ashby
npm run live-check -- --pipeline            # 再跑一遍完整流程（临时数据库，跑完删除）
npm run live-check -- --score 简历.pdf      # 再用 Claude Code 给一个岗位打分
npm run live-check -- --jobspy              # 再试 Python JobSpy
```

## 测试

```bash
npm test
```

测试不访问任何网站：抓取用保存下来的页面（`tests/fixtures/`），AI 打分用假的 provider，MCP 用内存连接。

桌面版的冒烟测试（`electron . --smoke-test <结果.json>`，打包检查里每个安装包都会跑）还会在内置浏览器里打开一个本机的申请表，填写、选择，并确认点“提交”前会先请用户允许。安装版的检查还会从本机模拟一个“9.9.9”新版本：确认左侧栏出现圆形下载按钮、点它下载并校验安装包（不会真的安装）。

想看界面但不想抓取，可以生成一份虚构数据：

```bash
node scripts/seed-demo.mjs ./demo-data
DAYJOB_DATA_DIR=./demo-data npm start
```

## 发布新版本

每个 PR 和每次推送到 main，GitHub Actions 都会在 Windows 上跑测试、打包安装版和免安装版，并把这三种形态（解压版、静默安装后的安装版、免安装版）各启动一遍，同时检查打包后的 Claude MCP 连接。

发布时把 `package.json` 里的 `version` 改成新版本号（例如 `0.2.0`）并合并到 main。如果这个版本还没有发布过，工作流会用刚验证过的文件创建 `v0.2.0` 的 Release。不需要手动推送 tag，也不要在 GitHub 网页上手动发布。

在自己电脑上检查打包结果：

```bash
npm run package:win
powershell -ExecutionPolicy Bypass -File scripts/verify-windows-build.ps1 -Version 0.3.0
```

## 目录

```
server/            本机 HTTP 服务（只监听 127.0.0.1）
  jobs/scrapers/   LinkedIn、Indeed、公司招聘页、JobSpy 桥接
  jobs/scoring/    Claude Code / Claude API 打分
  jobs/            SQLite、搜索、追踪、每日调度、简历匹配、Claude 推荐
integrations/      Claude MCP 服务器
desktop/           Electron 主进程、托盘、Claude 一键连接、内置浏览器、自动更新
src/               React 界面
tests/             node:test 测试和抓取样本
scripts/           演示数据、真实网站检查、Windows 打包检查
.github/workflows/ Windows 打包、验证和发布
```

## 许可

抓取逻辑参考了 [JobSpy](https://github.com/speedyapply/JobSpy)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
