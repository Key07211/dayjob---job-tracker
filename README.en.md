# Dayjob · Job tracker

[简体中文](README.md) · **English**

Dayjob fetches the jobs you want every day and scores each one against your resume with AI. Once you click "I applied", it keeps tracking the application: it reminds you to follow up, notices a long silence and checks whether the posting has closed. Everything is stored in a SQLite database on your computer.

Dayjob is the job-search mode of [Daylight](https://github.com/Key07211/daylight). It is developed as a separate project first and will be merged into Daylight, behind one button that switches between the two, once every feature is finished and verified.

![Today: AI match scores, posting dates and the job details](docs/media/feed-en.webp)

> The companies, jobs and resume in the screenshots are made-up data from `scripts/seed-demo.mjs`. The interface follows the system's light or dark theme, or a theme you pick in Settings.

## Features

| Feature | What it does |
| --- | --- |
| Daily search | Runs every saved search at a set time (08:30 by default). If the computer was off, Dayjob catches up the next time it opens that day. "Search now" runs it any time. |
| Sources | LinkedIn and Indeed, requested directly the way JobSpy does it (no Python needed). Greenhouse, Lever and Ashby company boards through their official public JSON. Glassdoor, ZipRecruiter and Google Jobs through the optional Python JobSpy. |
| Job details | Title, company, location, remote, pay, job type and level, the full description, and the dates: **posted / opened**, first found by Dayjob, last seen in a search, last checked open. |
| Filters | Each search has keywords (comma-separated means any of them), location, a posted-within window, job type, remote only and words to exclude. The same job on several boards is merged. |
| AI scoring | Upload up to 3 PDF, Word or text resumes (one for data roles and one for software roles, say). Each job is scored 0–100 against the resume that shares the most keywords with it, with strengths, gaps and keywords you could add. It uses your signed-in Claude Code (`claude -p`, no API key) by default, or your own Anthropic API key. |
| Suggestions | Under Searches, "Ask Claude" reads your resumes and suggests daily searches and companies worth following (each company board is checked first); add the ones you like in one click. |
| Application tracking | "I applied" records the date and a note and moves the job to Applications. Stages: Applied → Assessment → Interviewing → Offer / Accepted / Rejected / Withdrawn / Ghosted, each change on a timeline. Applications made elsewhere can be added by hand. |
| Automatic follow-through | A follow-up reminder N days (7 by default) after applying or a status change; a "possibly ghosted" flag after N days (21) at Applied; a daily check whether applied and saved jobs have closed. |
| Notifications | A daily summary (new jobs, strong matches), follow-up reminders and closed postings, as Windows notifications and in the app. |
| Built-in browser | The desktop app has its own browser (Browser in the sidebar) with tabs, and its sign-ins stay on this computer. "Add to Dayjob" saves the job you are looking at so it can be scored and tracked. Claude can open and read pages through MCP and help fill in applications; anything that submits or sends waits for you to click Allow. |
| Claude MCP | Claude Code and Claude Desktop can read jobs and your resume, write back their own analysis, update applications and use the Dayjob browser, with 29 tools. |
| Automatic updates | The installed app checks GitHub Releases for a new version once a day (you can turn this off in Settings), and "Check for updates" in the sidebar checks any time. When one is out it turns into a round download button; once downloaded, click "Restart to update". |
| 中文 / English | Switch with the EN / 中 button at the top left or under Settings → Language. Notifications and the tray menu follow; the AI analysis language is set separately under Resume & AI. |

![Applications: funnel, stages and timeline](docs/media/applications-en.webp)

## Download

Download the latest Windows version:

- **[Installer (Dayjob-Setup.exe)](https://github.com/Key07211/dayjob---job-tracker/releases/latest/download/Dayjob-Setup.exe)**: open Dayjob from the Start menu or the desktop shortcut afterwards.
- **[Portable (Dayjob-Portable.exe)](https://github.com/Key07211/dayjob---job-tracker/releases/latest/download/Dayjob-Portable.exe)**: runs without installing.

Each version's notes, the same files with the version in their names (`Dayjob-Setup-x.y.z.exe`, `Dayjob-Portable-x.y.z.exe`) and a SHA-256 checksum file are on the [Releases](https://github.com/Key07211/dayjob---job-tracker/releases/latest) page.

The programs are not signed yet, so the first time Windows may say "Windows protected your PC"; click "More info", then "Run anyway". From 0.3.0 the installed app updates itself ("Check for updates" in the sidebar); for the portable app, the download button gets the new portable app in your browser. Version 0.2.0 and earlier need 0.3.0 downloaded and installed over them once. Upgrading or uninstalling keeps your data in `%APPDATA%\Dayjob`.

## Run from source

Needs Node.js 22.13 or newer (for the built-in `node:sqlite`).

```bash
npm install
npm run build
npm start            # opens on http://127.0.0.1:4318
```

The desktop app (tray, desktop notifications, one-click Claude connection):

```bash
npm run desktop:preview   # builds the interface and opens it in Electron
npm run package:win       # Windows installer and portable build in release/
```

`npm run dev` serves the interface with hot reload on port 5174 and forwards `/api` to 4318.

### Where the data lives

| How you run it | Database |
| --- | --- |
| Desktop app | `%APPDATA%\Dayjob\data\dayjob.sqlite` |
| `npm start` | `data/dayjob.sqlite` in the project (git-ignored) |
| Custom | set `DAYJOB_DATA_DIR`; the port is `DAYJOB_PORT` |

Only the text extracted from your resume is stored, never the file. A Claude API key is stored in plain text in the local database and is never sent back to the interface or the API; you can use the `ANTHROPIC_API_KEY` environment variable instead.

## First steps

1. **Resume & AI**: upload your resume (up to 3). To score with Claude Code, install it, run `claude` in a terminal and type `/login`. If it is not signed in, the Resume & AI page says so; click "Check again" after signing in.
2. **Searches**: click **Ask Claude** and add the searches and companies you like from its suggestions, or add a search yourself, for example keywords `data scientist, machine learning engineer`, location `San Francisco Bay Area`, sources LinkedIn and Indeed, posted in the past 3 days. To follow a company, paste its careers link (`boards.greenhouse.io/…`, `jobs.lever.co/…`, `jobs.ashbyhq.com/…`); every open job there that matches a search's keywords and location is kept, however long ago it was posted.
3. Click **Search now** at the bottom left. Jobs are scored when the search finishes.
4. Browse **Today**, save jobs or mark them not interested. After applying, click **I applied**; everything after that happens in **Applications**.

## AI scoring

| Option | Notes |
| --- | --- |
| Claude Code on this computer (default) | Runs `claude -p` on your Claude plan; no API key. If `claude` is not found, enter its full path under Resume & AI. |
| Claude API | Your own API key, default model `claude-opus-5-5`, billed by usage. Server-side fallback is on: if the chosen model declines a request, Anthropic retries it once with a fallback model. |
| Claude through MCP | Ask Claude Code or Claude Desktop to "analyse this job against my resume"; Claude reads both and saves the result with `dayjob_save_analysis`. |

Each run scores up to 40 jobs (adjustable): new jobs first, then older unscored ones.

With several resumes, Dayjob first compares each job's keywords with each resume on your computer (title words count more; words every posting has, such as "experience", "team" and equal-opportunity text, are ignored) and sends the best-matching resume to the AI. A job's details show which resume was used, the shared keywords and every resume's overlap. After you add or delete a resume, jobs pick their resume again, and a job whose resume changed is scored again.

## Search and company suggestions

On **Searches**, click **Ask Claude** (optionally with preferences such as "Bay Area or remote only, needs H-1B sponsorship"). Claude runs the way it is set up under Resume & AI (Claude Code on this computer uses your Claude allowance; it takes about a minute) and, after reading all your resumes, suggests:

- up to 6 searches: job-title keywords, location, level words to exclude (Senior and Staff for a new-grad resume, for example) and which resume each fits;
- up to 10 companies, only ones that hire through Greenhouse, Lever or Ashby. Dayjob requests each board, drops those that do not exist and shows how many jobs are open.

Nothing is added until you click **Add** or **Follow**; you can also edit a search before adding it. The latest suggestions are kept for the next time you open the page.

## Connect Claude (MCP)

Desktop installer: **Settings → Connect Claude** adds Dayjob to Claude Code (`~/.claude.json`) and Claude Desktop, backing up each file first and touching only the `dayjob` entry.

From source, run this in a terminal (with your Dayjob folder):

```bash
claude mcp add dayjob -s user -e DAYJOB_URL=http://127.0.0.1:4318 -- node <Dayjob folder>/integrations/mcp-server.mjs
```

Dayjob needs to be running. Then try:

> Which jobs in Dayjob scored 80 or more today? Sort them by match.
>
> I just applied to the Data Scientist role at Lumen Health. Mark it as applied in Dayjob.
>
> Update my Dayjob applications from the interview invites in my Gmail.

| Tool | Purpose |
| --- | --- |
| `dayjob_status` | State, next daily run, resume and scoring status |
| `dayjob_list_postings` / `dayjob_get_posting` | Find jobs (by score, source, time) and read one |
| `dayjob_list_resumes` / `dayjob_get_resume` | List the resumes; read the one a job is matched to (or a given one) |
| `dayjob_save_analysis` / `dayjob_score_posting` | Save Claude's own analysis, run the scorer |
| `dayjob_set_posting_status` / `dayjob_add_posting` | Save or dismiss a job, add one by hand |
| `dayjob_mark_applied` / `dayjob_add_application` | Mark a job as applied, add an application made elsewhere |
| `dayjob_list_applications` / `dayjob_get_application` / `dayjob_update_application` | Read and update stages, notes and follow-up dates |
| `dayjob_list_searches` / `dayjob_save_search` / `dayjob_follow_company` / `dayjob_run_search` | Manage searches, follow companies, search now |
| `dayjob_list_notifications` | Recent reminders |

| `dayjob_browser_open` / `dayjob_browser_read` / `dayjob_browser_screenshot` | Open a page in the Dayjob browser, read its text and the elements to act on, take a screenshot |
| `dayjob_browser_click` / `dayjob_browser_type` / `dayjob_browser_select` / `dayjob_browser_press_key` | Click, type, pick a dropdown option, press a key |
| `dayjob_browser_scroll` / `dayjob_browser_navigate` / `dayjob_browser_tabs` | Scroll, go back, forward or reload, switch and close tabs |

Changes made through MCP show as "Claude" on the timeline.

## Built-in browser

**Browser** in the desktop app's sidebar is Dayjob's own browser, separate from Chrome and Edge:

- Sign in to LinkedIn, Indeed, Handshake or company career sites there. Sign-ins and cookies stay in Dayjob's data on this computer (**Settings → Dayjob browser** clears them).
- "Open on LinkedIn" and "Company apply page" in a job's details open there; the arrow at the right of the toolbar opens the page in your own browser.
- For a job Dayjob did not find, click **Add to Dayjob**. It reads the page's standard job data (schema.org JobPosting, which most job sites publish) or its text, and saves the job so it can be scored and tracked.

With Claude connected, try:

> Open this job's application page in the Dayjob browser, fill in the form from my resume, and show me before you submit.

What Claude can and cannot do there:

- It can open pages, read them, take screenshots, click, type, pick dropdown options and switch tabs. You see it happen in the Dayjob window ("Claude is working" in the toolbar).
- Clicking a button such as Submit, Send, Confirm or Delete, or pressing Enter in a multi-field form, first asks you in Dayjob. Nothing happens until you click **Allow**, and the request is dropped after 2 minutes.
- It never types passwords, card numbers or one-time codes, and it does not upload files; you choose the resume yourself. Text on web pages is treated as data, never as instructions.
- Untick **Let Claude use it** in the toolbar and Claude can no longer open or use the browser.

Some sites do not allow signing in with Google inside an app's browser. Sign in with email and password there, or use the toolbar arrow to switch to your own browser.

## JobSpy (optional)

Glassdoor, ZipRecruiter and Google Jobs need the Python [JobSpy](https://github.com/speedyapply/JobSpy):

```bash
pip install python-jobspy
```

Then check the Python command under **Settings → JobSpy** (`python` on Windows by default) and save to detect it again. LinkedIn, Indeed and company boards do not need Python.

## About scraping

- LinkedIn and Indeed limit frequent requests. Dayjob waits a few random seconds between pages and backs off on HTTP 429; when a site limits it, that run is marked partly succeeded and the other sources carry on. One run a day with a few dozen results per search is usually fine; avoid short intervals or hundreds of results at once.
- When checking whether jobs have closed, a job that today's search still lists counts as open and is not requested again. Some networks are refused Indeed's job pages (HTTP 401); then Dayjob cannot tell whether an Indeed job has closed, only whether it still shows up in searches. Other sources are checked as usual.
- Glassdoor, ZipRecruiter and Google Jobs rely on JobSpy, which may need updating when those sites change.
- Follow each site's terms of use and use Dayjob for your own job search only.

To check every source from your network:

```bash
npm run live-check                          # LinkedIn, Indeed, Greenhouse, Lever, Ashby
npm run live-check -- --pipeline            # plus a full run into a temporary database
npm run live-check -- --score resume.pdf    # plus one Claude Code score
npm run live-check -- --jobspy              # plus the Python JobSpy
```

## Tests

```bash
npm test
```

The tests never touch a real site: scrapers read saved pages (`tests/fixtures/`), scoring uses fake providers and MCP an in-memory connection.

The desktop smoke test (`electron . --smoke-test <result.json>`, run on every Windows build) also opens a local application form in the built-in browser, fills it in, picks an option, and checks that clicking Submit asks the user first. For the installed app it also serves a pretend "9.9.9" release from this computer, checks that the sidebar shows the round download button, then clicks it and downloads and verifies the installer (without installing it).

To try the interface without scraping, generate made-up data:

```bash
node scripts/seed-demo.mjs ./demo-data
DAYJOB_DATA_DIR=./demo-data npm start
```

## Releasing

For every pull request and every push to main, GitHub Actions runs the tests on Windows, builds the installer and the portable app, and starts each form (unpacked, silently installed and portable), including the packaged Claude MCP connection.

To release, change `version` in `package.json` (for example to `0.2.0`) and merge to main. If that version has not been released yet, the workflow publishes the files it just verified as release `v0.2.0`. There is no tag to push, and releases are never published by hand on GitHub.

To check a build on your own computer:

```bash
npm run package:win
powershell -ExecutionPolicy Bypass -File scripts/verify-windows-build.ps1 -Version 0.3.0
```

## License notes

The scrapers follow [JobSpy](https://github.com/speedyapply/JobSpy) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
