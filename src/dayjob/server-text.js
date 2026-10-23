import { currentLanguage } from '../i18n.jsx';

// The local API, the scrapers and the MCP server speak English, since Claude
// reads the same messages. The interface shows the ones a user meets in Chinese.
const EXACT = {
  'Requests must use this local Dayjob server.': '请通过本机的 Dayjob 访问。',
  'This request origin is not allowed.': '不接受来自其他网站的请求。',
  'Cross-site requests are not allowed.': '不接受来自其他网站的请求。',
  'Missing or invalid Dayjob token. Reload the app and try again.': 'Dayjob 会话已过期，请刷新页面后重试。',
  'API endpoint not found.': '找不到这个接口，请更新 Dayjob。',
  'Paste a Greenhouse, Lever or Ashby careers link, for example https://jobs.lever.co/company.': '请粘贴 Greenhouse、Lever 或 Ashby 的招聘页链接，例如 https://jobs.lever.co/company。',
  'Add a search or follow a company first.': '请先添加一个搜索或关注一家公司。',
  'Upload a resume first.': '请先上传简历。',
  'Upload a resume before scoring.': '请先上传简历再打分。',
  'This job is already tracked as an application.': '这个岗位已经在投递追踪里了。',
  'This job is already tracked.': '这个岗位已经在投递追踪里了。',
  'Send the resume file as base64 data.': '简历文件没有读取成功，请重新选择。',
  'Upload a PDF, Word (.docx) or text resume.': '请上传 PDF、Word（.docx）或纯文本简历。',
  'The resume file is empty.': '简历文件是空的。',
  'The resume file is larger than 8 MB.': '简历文件超过 8 MB。',
  'Almost no text was found in this resume. If it is a scanned image, export it as a text-based PDF or upload a .docx.': '简历里几乎读不到文字。如果是扫描图片，请导出为可以复制文字的 PDF，或上传 .docx。',
  'Posting not found.': '找不到这个岗位。',
  'Claude Code was not found. Install it and sign in, or set its path in Settings.': '没有找到 Claude Code。请安装并登录，或在下面填写路径。',
  'Claude Code is not signed in. Run claude in a terminal and type /login, then check again.': 'Claude Code 还没有登录。在终端运行 claude 并输入 /login，登录后点“重新检测”。',
  'No Anthropic API key is set.': '还没有设置 API key。',
  'Add an Anthropic API key in Settings.': '还没有设置 API key。',
  'The Anthropic API key was rejected.': 'API key 无效，请检查后重新填写。',
  'The Claude API is rate limiting requests; scoring will resume on the next run.': 'Claude API 正在限流，下次抓取时会继续打分。',
  'Claude declined this request.': 'Claude 拒绝了这次请求。',
  'The Claude reply was cut off.': 'AI 回复被截断了，请重试。',
  'You can keep up to 3 resumes. Delete one before adding another.': '最多保存 3 份简历。请先删除一份再上传。',
  'Claude is already suggesting searches; wait for it to finish.': 'Claude 正在推荐，请等它完成。',
  'The AI reply is not a JSON object.': 'AI 回复的格式不对，请重试。',
  'The AI reply has no numeric score.': 'AI 回复里没有分数，请重试。',
  'The AI reply did not contain JSON.': 'AI 回复的格式不对，请重试。',
  'No enabled searches yet.': '还没有启用的搜索。',
  'Dayjob closed before this run finished.': '抓取还没完成 Dayjob 就关闭了。',
  'The site returned something that is not JSON.': '网站返回的内容格式不对。',
  'LinkedIn returned a page without jobs (it may be limiting requests).': 'LinkedIn 返回的页面里没有岗位（可能在限流）。',
  'LinkedIn limited the job-page requests; some descriptions are missing.': 'LinkedIn 限制了岗位详情请求，部分岗位没有描述。',
  'Indeed refused the request (HTTP 401); it usually works again on the next run.': 'Indeed 拒绝了请求（HTTP 401），通常下次抓取就会恢复。',
  'Needs Python with: pip install python-jobspy': '需要 Python：pip install python-jobspy',
  'Neither Claude Code nor Claude Desktop was found.': '没有找到 Claude Code 或 Claude Desktop。',
  'Registered in Claude, but the Dayjob MCP health check failed. Keep Dayjob running and retry.': '已经写入 Claude 配置，但 Dayjob MCP 检查没有通过。请保持 Dayjob 运行后重试。',
  'A different Dayjob connection already exists in Claude. It was not changed.': 'Claude 里已经有另一个 Dayjob 连接，没有改动它。',
  'Unable to update the Claude configuration. Existing settings were not changed.': '无法更新 Claude 配置，原有设置没有改动。',
  'Dayjob has not been registered in Claude.': '还没有连接到 Claude。',
  'Unable to check the Claude connection.': '无法检查 Claude 连接。',
  'Connection has not been checked.': '还没有检查连接。',
  'Email must look like name@example.com.': '邮箱格式不对，例如 name@example.com。',
};

const FOUND = { Posting: '岗位', Application: '投递记录', Search: '搜索', Company: '公司', Resume: '简历', Run: '抓取记录', Notification: '通知' };

const PATTERNS = [
  [/^(\d+) of (\d+) could not be scored: (.*)$/s, (all, failed, total, reason) => `${total} 个岗位中有 ${failed} 个没能打分：${serverText(reason)}`],
  [/^No (\w+) job board named "(.+)" was found\.$/, (all, ats, slug) => `没有找到 ${ats} 上名为“${slug}”的招聘页，请检查链接。`],
  [/^Could not read this (\w+) file: (.*)$/s, (all, type, detail) => `无法读取这个 ${type} 文件：${detail}`],
  [/^(\w+) not found\.$/, (all, what) => `找不到这个${FOUND[what] || what}。`],
  [/^Claude Code exited with (-?\d+): (.*)$/s, (all, code, detail) => `Claude Code 运行失败（退出码 ${code}）：${detail}`],
  [/^Claude API error (\d+): (.*)$/s, (all, status, detail) => `Claude API 出错（${status}）：${detail}`],
  [/^Network error: (.*)$/s, (all, detail) => `网络错误：${detail}`],
  [/^HTTP (\d+) \(the site is limiting requests; try again later\)$/, (all, status) => `HTTP ${status}（网站在限流，稍后再试）`],
  [/^Indeed API error: (.*)$/s, (all, detail) => `Indeed 接口出错：${detail}`],
  [/^JobSpy is not available \((.*)\)\. Install Python and run: pip install python-jobspy$/s, (all, detail) => `JobSpy 不可用（${detail}）。安装 Python 后运行 pip install python-jobspy。`],
  [/^JobSpy (\S+) failed: (.*)$/s, (all, site, detail) => `JobSpy 抓取 ${site} 失败：${detail}`],
  [/^Cannot start (.+?): (.*)$/s, (all, command, detail) => `无法启动 ${command}：${detail}`],
  [/^(\S+) limited requests; the rest are checked next time\.$/, (all, site) => `${site} 在限流，其余岗位下次再检查。`],
  [/^(LinkedIn|GitHub|Website) link must be (?:a web link|a full http\(s\) link)\.$/, (all, name) => `${name === 'Website' ? '个人网站' : name} 链接格式不对，请填写完整网址。`],
];

export function serverText(message) {
  const text = String(message ?? '');
  if (currentLanguage() !== 'zh' || !text) return text;
  if (EXACT[text]) return EXACT[text];
  for (const [pattern, render] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return render(...match);
  }
  return text;
}
