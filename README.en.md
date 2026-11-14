# Dayjob · Job tracker

[简体中文](README.md) · **English**

Dayjob fetches the jobs you want every day and scores each one against your resume with AI. Once you click "I applied", it keeps tracking the application: it reminds you to follow up, notices a long silence and checks whether the posting has closed. Everything is stored in a SQLite database on your computer.

Dayjob is the job-search mode of [Daylight](https://github.com/Key07211/daylight). It is developed as a separate project first and will be merged into Daylight, behind one button that switches between the two, once every feature is finished and verified.

![Animation: Today and its right-click menu, Applications, the built-in browser filling in an application form, then the day / night switch going to night and back](docs/media/demo-en.webp)

Day and night each have their own colours: pale blue and warm yellow by day, brown-grey and desk-lamp yellow at night. By default the theme follows the clock (day at 07:00, night at 19:00); you can also click the day / night switch next to the time at the top, or follow the system or keep one theme under Settings.

| Day | Night |
| --- | --- |
| ![Today in the day theme](docs/media/feed-en.webp) | ![Today in the night theme](docs/media/feed-dark-en.webp) |

> The companies, jobs, applications and resume in the animation and screenshots are made-up demo data (`scripts/seed-demo.mjs` makes a set).

## Features

| Feature | What it does |
| --- | --- |
| Daily search | Runs every saved search at a set time (08:30 by default). If the computer was off, Dayjob catches up the next time it opens that day. "Search now" runs it any time. How many results each source is asked for can be set in Settings, by number or by share; see [Results per source](#results-per-source). |
| Sources | LinkedIn and Indeed, requested directly the way JobSpy does it. Greenhouse, Lever and Ashby company boards through their official public JSON. Glassdoor, ZipRecruiter and Google Jobs through the Python JobSpy, which the Windows installer and the portable app carry inside them: they work straight away, with no Python to install. |
| Job details | Title, company, location, remote, pay, job type and level, the full description, and the dates: **posted / opened**, first found by Dayjob, last seen in a search, last checked open. |
| Filters | Each search has keywords (comma-separated means any of them), location, a posted-within window, job type, remote only and words to exclude. The same job on several boards is merged. |
| AI scoring | Upload up to 3 PDF, Word or text resumes (one for data roles and one for software roles, say). Each job is scored 0–100 against the resume that shares the most keywords with it, with strengths, gaps and keywords you could add. It uses your signed-in Claude Code (`claude -p`, no API key) by default, or Codex signed in with your ChatGPT account, or your own Anthropic or OpenAI API key; you pick the model and the reasoning effort. Pause scoring at any time and resume later; remove every job under 60 in one click. |
| Suggestions | Under Searches, "Ask the AI" reads your resumes and suggests daily searches and companies worth following (each company board is checked first); add the ones you like in one click. |
| Application tracking | "I applied" records the date and a note and moves the job to Applications. Stages: Applied → Assessment → Interviewing → Offer / Accepted / Rejected / Withdrawn / Ghosted, each change on a timeline. Applications made elsewhere can be added by hand. |
| Automatic follow-through | A follow-up reminder N days (7 by default) after applying or a status change; a "possibly ghosted" flag after N days (21) at Applied; a daily check whether applied and saved jobs have closed. |
| Notifications | A daily summary (new jobs, strong matches), follow-up reminders and closed postings, as Windows notifications and in the app. |
| Running in the background | By default, closing the window leaves Dayjob in the tray, so searches, reminders and Claude keep working; "Quit Dayjob" in the tray menu closes it completely. To keep nothing running, untick "Keep running in the tray" under Settings → Closing the window: closing the window then quits Dayjob, and a missed daily search runs when you next open it that day. |
| Home | Dayjob opens on a statistics page: applications this week and month, reply rate, OA / interview rate, the monthly and weekly goals, the last 12 weeks, the funnel, a daily heatmap, where applications stand, results by job board, and what needs a follow-up, recent changes and the best matches not applied to yet. |
| Monthly goals | Set monthly targets for applications, interviews / OAs and goals of your own (practice problems, say); Dayjob splits them into weekly tasks and charts this week, the month so far and every week on Home. |
| Built-in browser | The desktop app has its own browser (Browser in the sidebar). It opens on the right, beside Home, Applications or any other page; drag it wider or let it fill the window. It has tabs, and its sign-ins stay on this computer. The assistant panel next to it shows where the job stands in Dayjob, with one click to add it to Dayjob or mark it applied. |
| Autofill / auto-submit | Fill in your name, email, phone, links and common answers once under Resume & AI → Application profile (it can read them from your resume). On an application form, click **Autofill** and Dayjob fills each empty box by its question, then lists the required fields still yours to fill in. With **Auto-submit** on, it submits as soon as every required field is filled (for this session of Dayjob only). |
| Claude MCP | Claude Code and Claude Desktop can read jobs and your resume, write back their own analysis, update applications, use the Dayjob browser (autofill included), find a company's job board from its name or its own careers page and follow it, read or set monthly goals and read the Home statistics, with 36 tools. |
| Assistant | A pixel gramophone with a place of its own in the sidebar, opened as a small chat at the right of the window or as a full page. Ask it in a sentence to look up jobs and applications, save a job, record an application, change a search or start one; every change can be undone in one click. Give it a company name or the careers page on the company's own site and it finds that company's board on Greenhouse, Lever or Ashby and puts it on the daily search. It can also apply for you in the Dayjob browser: open the application page, have the vault sign in, fill in the form, attach the resume that fits and write the cover letter. It asks before sending unless you switch it to full takeover beside the chat box. It answers radio buttons and checkboxes, and answers that are the same every time ("Protected veteran: I am not one") go into **what the assistant keeps in mind**, so it stops asking. Once an application is sent, Dayjob records it under Applications by itself. Passwords and resume files never go to the model. A long conversation is compacted by itself, as in Claude Code, and `/compact` does it on request. Conversations are not saved unless you keep or archive one. It runs on your local Claude Code or on the Claude API. See [Assistant](#assistant). |
| User guide | The first time Dayjob opens, once the opening has played, the assistant's gramophone steps out of the sidebar, says what it can do, and then shows you around: what each page is for and where its settings are. It uses no AI allowance and no network. Skip it at any time; **User guide** at the top right of Settings plays it again. Settings also has **Explain settings**, which lights the page one group at a time and says what each setting controls. On the first launch the guide and the interface speak the system's language. See “User guide” below. |
| Automatic updates | The installed app checks GitHub Releases for a new version once a day (you can turn this off in Settings), and "Check for updates" in the sidebar checks any time. When one is out it turns into a round download button; once downloaded, click "Restart to update". |
| Day / night | Follows the clock by default (day at 07:00, night at 19:00; change the hours under Settings → Appearance). When the theme changes, the new colours sweep down the page at nightfall and up at daybreak. Next to the time at the top of every page is a day / night switch: click it and the sun rolls over into a moon, the clouds sink and the stars come out one by one. In clock mode a theme picked this way holds until the next change on the clock, then the clock takes over again. Dropdowns, calendars and time pickers follow the theme too. |
| Opening | When Dayjob opens it plays a pixel opening of about two and a half seconds. There are three, one is picked at random each time, and never the one that played last. Gramophone: the assistant's pixel gramophone is cranked up and plays, notes fly from its horn, and "dayjob" is typed out letter by letter. Wave: sheets fly in from every side and stand up as a row of bars that pulse on the beat. Briefcase: four sheets fly into the briefcase, the meter bars and the record player appear, and it becomes Dayjob's icon. Each has day and night colours. At the end the picture breaks up a pixel at a time from the corners inwards and the page shows through; if the data is slow it holds for whole beats. Click or press any key to skip; it does not play when the window comes back from the tray. Turn it off under Settings → Appearance; it never plays when Windows asks for reduced motion. |
| 中文 / English | The first launch follows the system's language: 中文 on a Chinese system, English on any other. After that, switch with the EN / 中 button at the top left or under Settings → Language; what you pick is kept. Notifications and the tray menu follow; the AI analysis language is set separately under Resume & AI. |

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

A resume is stored as two things: its extracted text (for scoring and matching) and the file itself (to attach to application forms), both in the local database only. The file is never sent to Claude or any AI; it only goes into the application form you are filling in. Resumes uploaded before 0.28 have only their text: click **Add the file** under Resume & AI to add it, and their scores stay as they are. API keys are entered under **Settings → API key**. You can keep several: add one with the plus button, and each service (Claude API, OpenAI API) uses the one marked "In use". Keys are stored in plain text in the local database. They stay hidden, and are never part of the settings data or handed to Claude through MCP; a key is shown only when you click the eye in Settings. You can also store none and use the `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` environment variable.

## First steps

The first time Dayjob opens, the assistant shows you around every page (see “[User guide](#user-guide)”). After that, start with these steps:

1. **Resume & AI**: upload your resume (up to 3), then click **Read from my resume** under **Application profile** below and fill in what it missed; autofill uses it. To score with Claude Code, install it, run `claude` in a terminal and type `/login`. If it is not signed in, the Resume & AI page says so; click "Check again" after signing in.
2. **Searches**: click **Ask the AI** and add the searches and companies you like from its suggestions, or add a search yourself, for example keywords `data scientist, machine learning engineer`, location `San Francisco Bay Area`, sources LinkedIn and Indeed, posted in the past 3 days. To follow a company, paste its careers link (`boards.greenhouse.io/…`, `jobs.lever.co/…`, `jobs.ashbyhq.com/…`); every open job there that matches a search's keywords and location is kept, however long ago it was posted. Without a link, tell the [assistant](#finding-a-companys-job-board) the company's name and it finds the board.
3. Click **Search now** at the bottom left. By default jobs are scored when the search finishes; to save Claude allowance, switch Resume & AI to score only the jobs you save, or only when you ask.
4. Browse **Today**, save jobs or mark them not interested. To apply, click "Company apply page" in a job's details; it opens in the browser on the right, where **Autofill** fills in the application form. After applying, click **I applied** (or **Mark applied** in the browser's assistant panel); everything after that happens in **Applications**.
5. Come back to **Home** for the overall picture: how much you have applied, what needs a follow-up and which strong matches are still waiting.

## AI scoring

| Option | Notes |
| --- | --- |
| Claude Code on this computer (default) | Runs `claude -p` on your Claude plan; no API key. If `claude` is not found, enter its full path under Resume & AI. A score runs with no tools and starts none of the MCP servers set up in Claude Code. |
| Claude API | Your own Anthropic API key, default model `claude-opus-5-5`, billed by usage. Server-side fallback is on for models that have it, such as Opus, Fable and Sonnet 5.5: if the chosen model declines a request, Anthropic retries it once with a fallback model. |
| Codex on this computer (ChatGPT) | Runs `codex exec` on the Codex allowance of your ChatGPT plan; no API key. Install Codex, run `codex` in a terminal and choose Sign in with ChatGPT. Codex runs in a read-only sandbox from an empty folder, without your Codex config or MCP servers. |
| OpenAI API | Your own OpenAI API key (Responses API), default model `gpt-6.1-sol`, billed by usage; requests are not stored by OpenAI. |
| Claude through MCP | Ask Claude Code or Claude Desktop to "analyse this job against my resume"; Claude reads both and saves the result with `dayjob_save_analysis`. |

Anthropic keys come in two kinds. A key made for one workspace works as soon as it is entered under **Settings → API key**. A personal or service account key that works in every workspace must send a workspace ID with each request: when you save such a key, Dayjob asks the Claude API about it (at no cost), fills in the workspace when there is only one and lets you choose when there are several; if it cannot find them, enter the `wrkspc_…` ID from the ID column of the Workspaces page in the Console under the key. Every Claude key has a **Check** button that asks again whether the key can be used.

### Model and reasoning effort

Once you pick a provider under **AI scoring** in Resume & AI, the **Model** list shows that provider's models, and **Reasoning effort** lists only the levels the chosen model accepts:

| Provider | Models |
| --- | --- |
| Claude Code / Claude API | Claude Opus 5.5 (recommended), Fable 5.2 (most capable), Sonnet 5.5, Haiku 5.5 (fast, cheap), and older Fable 5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8 / 4.7 / 4.6, Sonnet 4.6 and Haiku 4.5. Claude Code also offers "Claude Code's own setting" (the default). |
| Codex | GPT-6.1 Sol (recommended), GPT-6 Astra (most capable), GPT-6 Sol, GPT-6 Luna (fast, cheap), or "Codex's own setting". On ChatGPT Free and Go, Codex offers GPT-6 Luna only. |
| OpenAI API | The four GPT-6 models above, plus GPT-5.6 Sol / Terra / Luna, GPT-5.5 and GPT-5 mini. |

For a model not in the list, choose "Other (type a model id)". Reasoning effort runs Low / Medium / High / Extra high / Max and starts at "Model default". Higher looks closer at each job, but is slower and uses more; Haiku 4.5 has no such setting. Switching models resets a level the new model lacks to "Model default". Upgrading changes nothing about how jobs are scored: Claude Code stays on its own model and effort, and the Claude API keeps its model and level.

Each scored job is one AI call and uses your Claude Code or Codex allowance (or API credit). Pick when it happens under **When to score** in Resume & AI:

| Option | When jobs are scored |
| --- | --- |
| After every search (default) | Each run scores up to 40 jobs (adjustable): new jobs first, then older unscored ones. |
| Only jobs I save | A job is scored when you save it; searches only catch up on saved jobs that are still unscored. |
| Only when I ask | Click **Score with AI** on a job, or tick a few in Today and click **Score N picked jobs** at the top right. |

If you had turned off "Score after each search" in 0.2.0 or earlier, you get "Only when I ask" after updating.

**Usage** under Resume & AI lists how many jobs were scored today and in the last 30 days, the input and output tokens they used, and the numbers for the latest score. The counts are what the AI reports (Claude Code, the Claude API, the OpenAI API; Codex reports none, so only its calls are counted) and are recorded from 0.22.0 on. The assistant's replies are listed on a line of their own.

### API spending and what is left

**Settings → API spending** turns every call made with an API key into US dollars at the services' list prices: what today, this month and the last 30 days cost, one bar a day for those 30 days, and what each key spent this month. The services show no balance to an ordinary key (Anthropic's usage and cost endpoints need an organization's Admin key, and report spending, not a balance), so for a "percent left" you first give the key an allowance and Dayjob counts down from it:

| Allowance | How it counts |
| --- | --- |
| Prepaid balance | Enter the balance the console shows for the key right now. It counts down from that moment; enter it again after a top-up. |
| Monthly budget | Enter the most the key should spend in a month. It starts again on the 1st, and what the month has already cost counts. |

One notification says when 15% is left and another when it is used up. Claude Code and Codex on this computer run on a subscription and cost no API money; what the same usage would cost at API prices is shown beside the sums for reference. The figures are Dayjob's own count: only calls made in Dayjob (not the same key's use elsewhere), at the standard prices of 2026-11-13 (5-minute cache writes, OpenAI's standard tier, the higher rates for a call over the long-context threshold), without volume discounts or tax. The service's bill is what counts. Calls recorded since 0.22.0 are priced too; a model that is not in the price list is left out, and the card says how many calls that was.

While scoring runs, the bottom left shows "AI is scoring 3/12" and a **Pause scoring** button. Pausing stops the job being scored at once (the Claude Code or Codex process ends too, so it uses no more allowance) and keeps the rest waiting; new jobs from searches and scores you ask for wait as well. **Resume scoring** carries on, skipping jobs you have since marked not interested or applied to. Dayjob stays paused after a restart.

**Remove jobs under 60** at the top right of **Today** moves every new job scoring under 60 to Not interested in one go. Saved, applied and unscored jobs stay. Click **Undo** right after to bring them back.

With several resumes, Dayjob first compares each job's keywords with each resume on your computer (title words count more; words every posting has, such as "experience", "team" and equal-opportunity text, are ignored) and sends the best-matching resume to the AI. A job's details show which resume was used, the shared keywords and every resume's overlap. After you add or delete a resume, jobs pick their resume again, and a job whose resume changed is scored again.

## Search and company suggestions

On **Searches**, click **Ask the AI** (optionally with preferences such as "Bay Area or remote only, needs H-1B sponsorship"). The AI runs with the provider and model chosen under Resume & AI (Claude Code or Codex on this computer uses your allowance; it takes about a minute) and, after reading all your resumes, suggests:

- up to 6 searches: job-title keywords, location, level words to exclude (Senior and Staff for a new-grad resume, for example) and which resume each fits;
- up to 10 companies, only ones that hire through Greenhouse, Lever or Ashby. Dayjob requests each board, drops those that do not exist and shows how many jobs are open.

Nothing is added until you click **Add** or **Follow**; you can also edit a search before adding it. When you are done, click **Done, close the suggestions** at the bottom (or the ✕ at the top) to put them away. The latest suggestions are kept: click **Show them again** to bring them back, and new suggestions open on their own.

## Home

Dayjob opens on **Home**, which puts applications, tracking and goals on one page:

![Home: application statistics, monthly goals, the trend and the funnel](docs/media/home-en.webp)

| Part | What it shows |
| --- | --- |
| Numbers at the top | Applied this week (and last week), this month (and the same point last month), active applications, reply rate and the typical days to a reply, the share that reached an OA or interview and the offers, and new jobs to look at. |
| Monthly goals | This week's tasks, the month so far and every week; see the next section. |
| Last 12 weeks | Applications each week (green) and OAs / interviews reached (orange); the dashed boxes are the weekly application goal. Hover a week for its numbers, or switch to a table at the top right. |
| Funnel | The furthest stage each application reached: applied → assessment → interview → offer, with each step's conversion. An application rejected later still counts at the stage it reached. |
| Daily applications | How many you sent each day over 12 weeks (darker is more), and your current streak. |
| Where they stand | How many applications are active or closed, and in which status. |
| By job board | How many you applied to through LinkedIn, Indeed, company boards and so on, how many reached an OA or interview, and the offers. Applications added by hand get their own row. |
| Needs a follow-up / Recent changes / Best matches | Click a row to open that application or job. |

## Monthly goals

**Home** shows this month's goals. Click **Set goals** and fill in how many you want this month:

| Goal | How it is counted |
| --- | --- |
| Applications | Automatically, by applied date, when you mark a job applied or add an application by hand. |
| Interviews / OAs | Automatically, when an application moves to Assessment or Interviewing; an application's assessment and interview count once each. |
| Custom (practice problems, coffee chats…) | By you: click **+1** under This week, or **−1** to take a mistake back. |

Weeks run Monday to Sunday; the partial weeks at the start and end of the month count by their days. Each week's task is the monthly target times that week's share of the month's days, rounded so the weeks add up to the target exactly. For 40 applications in October 2026, the weekly tasks are 5 · 9 · 9 · 9 · 8.

- **This week**: how many each goal has this week, and how many are left.
- **This month**: done against the target; the orange line is where you would be today at an even pace. When you are behind it says about how many a week catch up.
- **By week**: bars are what you did each week, dashed boxes are the weekly tasks.

The arrows show the previous month or let you set next month's goals early. A new month starts with last month's goals (progress starts at 0); change or clear them as you like. Hide the panel with the arrow at its top right.

## Assistant

The assistant has a place of its own in the sidebar, above Notifications: beside the gramophone is its name, replaced while it is busy by what it is doing just now (thinking, working, which step of an application it is on, waiting for you), and the two buttons below are the two ways to open it.

- **Side chat** opens at the right of the window, beside Home, Applications or the browser.
- **Full page** gives it the whole page, with the kept conversations in a column at the left. While the browser is open the two stand side by side; when the browser fills the window, or the window is narrow, the assistant folds into the side chat by itself.

Press the lit button again to close it. In a window that is not tall, its place in the sidebar gets more compact.

It is a pixel gramophone: still when nothing is happening; its record turns while it thinks; the crank at its side is wound while it looks something up or makes a change; and while it answers, the horn pulls in and pushes out notes, more of them the faster the words come, each drifting off and fading a few pixels at a time. Say what you need in a sentence:

| Day | Night |
| --- | --- |
| ![The assistant by day: the full page beside the browser, the form filled in and a card asking before it is sent](docs/media/assistant-en.webp) | ![The assistant at night: the side chat after an application sent under full takeover](docs/media/assistant-dark-en.webp) |

> The replies in these screenshots come from a stand-in model made for the demo, not from Claude; the jobs, the resume and the careers site are made-up demo data.

- **Look things up**: today's best-scoring new jobs, the fit analysis of one job, which applications need a follow-up, how far you are from this week's goal, what your resume says.
- **Make changes**: save a job or mark it not interested, record an application (when you say you applied, or after it sent one for you), update an application's status and notes, create or change a search, find a company's job board and follow it (see [Finding a company's job board](#finding-a-companys-job-board)), start a search, keep an answer you just gave in the application profile, or bring a page or a single job in front of you.
- **Apply**: send an application for you in the Dayjob browser; see [Applying for you](#applying-for-you) below.

Each thing it does leaves a small line in the reply saying what it was. A line for a change carries **Undo**, which puts things back in one click. If you have changed the same item yourself since, the undo is refused so your own edit is never overwritten. A note also flies from the gramophone's horn to that page's key in the sidebar.

A few things it cannot do, on purpose: it cannot see a password, and never types a password, a card number or a one-time code itself (the vault signs in on this computer); it never gets a resume file; it cannot delete jobs, applications, searches or followed companies, change settings, or change a resume (it can read one and suggest wording). What it does on a web page (a click, a field, a submit) has no undo.

### Finding a company's job board

Say "Put Stripe's job board on my daily search", or "Find a few companies hiring data analysts and follow them", and the assistant:

1. **Finds it**: from a company name alone it tries the addresses such a company usually has on Greenhouse, Lever and Ashby; from a link to the careers page on the company's own site (or to one of its jobs) it reads that page and sees whose board the company uses. It tells you how many jobs are open and how many of them match the searches you already have.
2. **Follows it**: the board joins the companies under Searches, and every daily run reads it from then on. The line in the conversation carries **Undo**. A board you already follow is not added twice, and one you paused is switched back on.
3. If you like, it then fetches that one company right away, so its jobs are in Today.

Asked for a kind of job, it first makes sure a saved search covers it (and creates one if not), then looks for companies; in the desktop app it can also search the web for public boards in the Dayjob browser.

Things to know:

- Only companies that hire through Greenhouse, Lever or Ashby can be followed. For one on Workday, SmartRecruiters, iCIMS or a system of its own, the assistant offers a saved search with the company's name instead, which finds its jobs on LinkedIn and Indeed.
- A search by name guesses the address, so now and then it lands on another company of the same name. The assistant tells you the company name and a few jobs it found; say so if they look wrong, or give it the careers link.
- Of a followed company's jobs, only those that match one of your enabled searches (keywords, location) are kept.
- It reads public web pages only: an address on this computer or the local network is refused.

Pasting a board link under **Searches** works as before, and Claude outside Dayjob can do the same through MCP (`dayjob_find_company_board`, `dayjob_follow_company`).

### Applying for you

Say "Apply to the Data Analyst job at Northwind Labs for me" and the assistant works through it in the Dayjob browser while you watch. A strip above the conversation shows how far it is: **Open → Sign in → Fill → Resume → Answer → Confirm → Record**.

1. **Open**: it opens the job's application page. A job already tracked as applied is not applied to again.
2. **Sign in**: when the page asks, it has Dayjob sign in with the account saved in Dayjob's password vault (**Settings → Passwords**). Dayjob fills the password in on this computer; the assistant learns only whether it worked, never the user name or the password. One try per site.
3. **Fill**: the form is filled in from your application profile.
4. **Resume**: the original file of the resume that fits this job best is attached (how it is chosen: the Resume row under [Built-in browser](#built-in-browser)). The assistant learns only the file's name.
5. **Answer**: questions with choices (radio buttons, checkboxes, dropdowns) it answers from your application profile and from [what it keeps in mind](#what-the-assistant-keeps-in-mind), and checks that the option is really chosen. Free-text answers and the cover letter it writes from what your resume and the posting say, inventing nothing. The cover letter is attached as a PDF to the form's cover letter upload, or typed into its box when there is no upload; **Read** on its line in the chat shows the whole letter. What only you know (expected pay, work authorization, start date and the like) it stops and asks, and it keeps the answer (in the application profile when there is a field for it, in its memory otherwise) so it need not ask again.
6. **Confirm**: see the switch below.
7. **Record**: once the page confirms the application, Dayjob records it under Applications by itself (see [Recording an application by itself](#recording-an-application-by-itself)); the assistant has nothing more to do.

A switch above the chat box decides who presses the last button:

| | What happens |
| --- | --- |
| **Ask me first** (default) | The assistant writes out what it filled in, which resume is attached and what it answered for you, and a **Send this application?** card appears in the chat. Hold its **Hold to send** button for about half a second and it goes out; **Not yet** sends nothing and leaves the form in the browser. With no answer in 10 minutes, nothing is sent. |
| **Full takeover** | The assistant clicks submit itself and tells you afterwards. It asks once more when you first switch. |

The same switch is under **Settings → Assistant**. It is for the assistant only: when a Claude outside Dayjob uses the browser over MCP, a submit always waits for you (unless you turned on Auto-submit in the browser).

In both modes the assistant is told to stop and hand over to you at a captcha or another proof of being human, a code sent by text or email, a payment or bank detail, an identity document, an assessment, a recording, a sign-in that did not work, or a page it is not sure is this job; and text on a web page is content to it, never instructions. Those are rules given to the model, not hard blocks, so full takeover suits sites where you have already watched it apply a few times. Three things Dayjob itself enforces: the assistant cannot type into password, card-number or one-time-code fields (only real ones: an ordinary text box that a site happens to label as a code or a new password can be filled in); signing in goes through the vault only; and under Ask me first nothing is submitted until you hold the button.

Applying for you exists in the desktop app only (it needs the Dayjob browser). As with its other conversations, the text of the page, your application profile and the text of your resume are sent to Claude; passwords and resume files are not.

### What the assistant keeps in mind

Some answers are the same every time and have no field in the application profile: protected veteran status, disability, gender and ethnicity, where you heard about the job, whether you agree to a background check. Write them under **Settings → Assistant → What the assistant keeps in mind**, one to a line, for example:

- Protected veteran status: choose "I am not a protected veteran"
- Gender and ethnicity questions: decline to answer
- How did you hear about us: LinkedIn

The assistant follows them when it fills in a form and stops asking each time; it asks only when no option on the form fits a note. Where Autofill already chose something else (the default "decline to answer", say) and a note gives the more exact answer, it changes the answer to the note's.

- Say "remember: …" in the chat, or answer a question that will come up again, and it adds a note itself. That line in the chat has **Undo**, and **All notes** opens the list in Settings.
- Every note in the list can be reworded or removed; the ones the assistant added are marked. Up to 60 notes of 400 characters each.
- The notes stay in Dayjob's database on this computer and go to the model at the start of a conversation, so do not write passwords: Dayjob refuses a note like "the password is …", and passwords belong in the vault. A Claude outside Dayjob (MCP) can neither read nor change them.

**Conversations are not saved by default**: one is gone when you start a new one or quit Dayjob. To keep one, click **Keep** above it. It is then stored in the local database, and you can continue it from the clock button in the assistant's header.

Every conversation can be archived or deleted. The buttons are at the right of the strip above the conversation, and on each row of the clock button's list:

- **Archive** (the box icon) puts a conversation away under "Archived" at the bottom of the list, out of the kept ones. Archiving a conversation that was not kept yet also saves it. From "Archived" you can open it and carry on, or take it back out into the list.
- **Delete** (the bin icon) asks once more with a "Delete" button. A conversation that was not kept is forgotten on the spot; a kept or archived one is also removed from the database. A deleted conversation cannot be brought back.

**Stop keeping** or a delete overwrites it in the database. Dayjob holds the only copy: Claude Code runs without saving a session, and the Claude API keeps no conversation. As with AI scoring, what you say and what it looks up (jobs, applications, resume text) is sent to Claude.

**A long conversation is compacted**, the way Claude Code does it: the model writes a summary of what has been said, and the conversation goes on from that summary plus what comes after it. A long conversation then neither fills the model's context nor pays for all of its old turns again with every message.

- **By itself**: once the context reaches about 167,000 tokens (107,000 with Claude Haiku 4.5) it is compacted, either before your next message joins it or between two steps of a longer piece of work, which then carries on. With the Claude Code engine this is Claude Code's own auto-compaction, which Dayjob runs with a 200,000-token compaction window (yours, if you have set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` yourself). When a very long kept conversation is opened again, its older part is summarised first instead of being left out.
- **On request**: press the compact button in the assistant's header, or type `/compact` in the chat box. Words after it say what the summary should pay attention to, for example `/compact keep my salary requirements`.
- A line saying **Conversation compacted** marks the place, and **Read summary** shows what the model wrote. Nothing disappears from the screen; only what the model sees from then on is the summary. A kept conversation stores its summaries with it.
- Once the context is half way to that size, a line above the chat box says how full it is, with **Compact now** beside it.
- Writing the summary is one more model call and counts toward your usage. What tools returned at the time is not in the summary, so the assistant looks things up again when it needs them; its memory and the apply mode (Ask me first / Full takeover) are told to it again after a compaction.

Choose the engine under **Settings → Assistant**. You can switch at any time and the open conversation carries on:

| Engine | Notes |
| --- | --- |
| Claude Code (default) | Uses the Claude Code signed in on this computer: no API key, and it draws on your subscription. Each conversation starts one `claude -p` process with every built-in tool switched off and only Dayjob's own tools connected. It does not load the other MCP servers you set up in Claude Code and leaves no session behind there. |
| Claude API | Uses your own Anthropic API key (entered under **Settings → API key**), billed by use. The default model is Claude Opus 5.5 and can be changed in the same place. The prompt and what has already been said go through prompt caching, so a running conversation costs less. |

The assistant is not the "Browser assistant" panel inside the browser, which handles autofill and passwords (when it applies for you, it uses the autofill and the vault behind that panel). It is also separate from "Connect Claude (MCP)" below: that lets a Claude Code or Claude Desktop outside Dayjob use it, while the assistant lives in the Dayjob window and needs no setup.

## User guide

The first time Dayjob opens on this computer, as soon as the opening has played, the assistant's gramophone steps out of its place in the sidebar and stands in the middle of the window:

1. **It says who it is** and what it can do for you (look up jobs, record applications and update their status, change searches and find company job boards, apply for you in the Dayjob browser, keep your preferences in mind, with every change undoable). **Show me around** starts the tour; **Not now** puts it away.
2. **It goes page by page**, in 12 steps: Home, Today, Saved, Applications, Browser, Searches & companies, Resume & AI, Settings, then the record player and Notifications at the bottom of the sidebar, look and sound at the top left, and last the assistant's own place. At each step it brings that page forward, lights what it is talking about, says what it is for, and under **Where to change it** names where the settings are (for example “Settings → Daily search” or “Resume & AI → Application profile”).

Use **Next** / **Back** or the → / ← keys; Esc or the cross at the top right ends it at any time. The words come out a sentence at a time; a click on the text shows all of it. The rest of the window cannot be clicked meanwhile, and when the guide ends you are back on the page you were on. At the last step **Say hello** opens the side chat; if the assistant cannot answer yet (no Claude Code, or no API key) it says so and offers **Open Settings**.

- The guide is written out in the app and calls no model: it uses no Claude allowance, needs no API key and no network.
- It comes by itself once. After **Show me around** or **Not now** it does not come again by itself; an installation updated from an earlier version also sees it once, the first time it opens after the update.
- To see it again: **User guide** at the top right of **Settings**, or **Show me around Dayjob** in the assistant's empty conversation.
- When Dayjob starts hidden in the tray, the guide waits until you first open the window. When Windows asks for less motion, the gramophone does not hop and the words do not come out one by one; the content is the same.
- The web version (opened in a browser after `npm start`) has no built-in browser, so the guide leaves out the browser and applying for you.
- **Language**: the guide speaks the interface's language. On the first launch, before any language has been picked, both follow the system's language (中文 on a Chinese system, English on any other) and keep it as your choice; the greeting has the **EN / 中** button at its top right in case that guess is wrong. From then on the language you pick in Dayjob is the one used.

### Explain settings

Settings has many items, and some of their names say little. **Explain settings** at the top right of **Settings** keeps the assistant's card at the right of the window and goes down the page one group at a time: it lights the group, says in a sentence or two what the group is for, and then explains the items in it that are hard to guess (for example “Keep jobs (days)”, “By each search / By number / By share”, “No-reply flag (days)”, “Strong-match score”, “Workspace ID”, “Set allowance”, “Engine”, “Follow music”).

- 16 groups: Daily search, Results per source, Application tracking, Notifications, JobSpy, API key, API spending, Connect Claude (MCP), Assistant, What the assistant keeps in mind, Passwords, Dayjob browser, Closing the window, Updates, Sound and music, and Language, look and data.
- For one group only: click the **question mark** at the right of its title, and the explanation starts there.
- **Next** / **Back** or the → / ← keys turn the page, which scrolls by itself to the group being explained; the wheel still scrolls it too. Esc or the cross ends it, and the page stays where you were reading.
- It only explains; it changes no setting. Like the guide, it calls no model and uses no network.

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
| `dayjob_list_searches` / `dayjob_save_search` / `dayjob_run_search` | Manage searches, search now (all of them, or only the given searches or companies) |
| `dayjob_find_company_board` / `dayjob_follow_company` | Find a company's board on Greenhouse, Lever or Ashby from its name, a board link or the careers page on its own site (how many jobs are open, how many match the saved searches); follow it, so every daily run reads it |
| `dayjob_list_notifications` | Recent reminders |
| `dayjob_get_goals` / `dayjob_set_goal` / `dayjob_log_goal_progress` | Read monthly goals and weekly tasks, set a goal, log a custom goal |
| `dayjob_get_dashboard` | Read the Home statistics (weekly applications, the funnel, reply rate, results by board, applications that need a follow-up…), handy for a weekly review with Claude |
| `dayjob_browser_open` / `dayjob_browser_read` / `dayjob_browser_screenshot` | Open a page in the Dayjob browser, read its text and the elements to act on, take a screenshot |
| `dayjob_browser_click` / `dayjob_browser_type` / `dayjob_browser_select` / `dayjob_browser_press_key` | Click, type, pick a dropdown option, press a key |
| `dayjob_browser_scroll` / `dayjob_browser_navigate` / `dayjob_browser_tabs` | Scroll, go back, forward or reload, switch and close tabs |
| `dayjob_browser_autofill` | Fill the open application form from the application profile (same as Autofill in the assistant panel), attach the resume that fits the job when the form has a resume field, and tell Claude what was filled, which resume was attached and which required fields are still empty; never submits |
| `dayjob_browser_upload_resume` | Attach a resume's file to the resume field of the open application form (the one that fits the job by default, or a given one); Claude gets the file's name, never the file; never submits |

Changes made through MCP show as "Claude" on the timeline.

## Built-in browser

**Browser** in the desktop app's sidebar is Dayjob's own browser, separate from Chrome and Edge. It opens on the right side of the window and the page you were on stays on the left, so you can read a job and keep notes at the same time:

![The browser on the right: Home on the left, an application form and the assistant panel on the right](docs/media/browser-en.webp)

- Drag the divider between the two to change the width (double-click resets it; the left and right arrow keys work too). The buttons at the top right switch between **Fill the window** and **Show beside the current page**, and × hides the browser while keeping its tabs. In a narrow window it always fills the window.
- Sign in to LinkedIn, Indeed, Handshake or company career sites there. Sign-ins and cookies stay in Dayjob's data on this computer (**Settings → Dayjob browser** clears them).
- "Open on LinkedIn" and "Company apply page" in a job's details open there; **Open in your browser** at the bottom of the assistant panel opens the page in Chrome or Edge.

The **Browser assistant** panel (not the gramophone [Assistant](#assistant) at the right of the window) sits to the right of the page (`»` folds it into a thin strip):

| Part | What it does |
| --- | --- |
| This page | When the page is already in Dayjob, it shows the title, company and status, with **View in Dayjob** and **Mark applied**. Otherwise click **Add to Dayjob**: it reads the page's standard job data (schema.org JobPosting, which most job sites publish) or its text, and after you check it, saves the job, or **Save and mark applied** in one go. **Record applications by itself**, in this part of the panel, is on by default: when a page says an application was received, Dayjob records it and starts tracking, see [below](#recording-an-application-by-itself). With it off, click **Mark applied** yourself after sending. |
| Autofill | Reads each question on the form and fills the empty boxes from your **Application profile**: name, email, phone, address, LinkedIn / GitHub / website, school and work, work authorization, sponsorship, relocation, desired salary, earliest start date, where you heard about the job and more, including dropdowns and radio buttons. Boxes that already have an answer are left alone. Afterwards it lists what it filled and the required fields still yours to fill in. Forms embedded from another site, like a Greenhouse form on a company's own page, work too. |
| Resume | When the form has a resume field (also one hidden behind an "Attach" button), Autofill attaches your resume's file as well. By default it is **The one that fits the job**: for a page of a job that is in Dayjob, the resume that job is matched to; otherwise the one that shares the most keywords with the job text on the page. You can pick one resume in the dropdown instead, or **Do not attach one**. **Attach the resume only** does just this step. Upload fields for a cover letter, a transcript and the like are left alone, and a resume field that already has a file is not given another. |
| Auto-submit | Off by default; while it is off, nothing is submitted unless you click it or allow it. Turning it on asks once more. While it is on, Autofill clicks Submit as soon as every required field is filled and checks that the page says the application was received, and Claude's clicks on Submit no longer ask first. It turns off again every time Dayjob starts. |
| Claude | Untick **Let Claude use it** and Claude can no longer open or use the browser. |

Autofill never touches passwords, one-time codes, signatures, references or emergency contacts. Voluntary self-identification questions (gender, race, veteran, disability) are answered "decline to answer" by default; untick that in the application profile and they are left for you. The profile stays on this computer.

With Claude connected, try:

> Open this job's application page in the Dayjob browser, autofill it, answer the remaining questions from my resume, and show me before you submit.

What Claude can and cannot do there:

- It can open pages, read them, take screenshots, click, type, pick dropdown options and switch tabs, and fill in your profile first with `dayjob_browser_autofill`. You see it happen in the Dayjob window ("Claude is working").
- Clicking a button such as Submit, Send, Confirm or Delete, or pressing Enter in a multi-field form, first asks you in Dayjob. Nothing happens until you click **Allow**, and the request is dropped after 2 minutes. Only while you have **Auto-submit** on does it go ahead straight away, and Claude is told so.
- It never types passwords, card numbers or one-time codes. The resume is attached by Dayjob (`dayjob_browser_autofill` does it along the way, or `dayjob_browser_upload_resume` on its own): Dayjob picks the resume and puts its file into the form, and Claude learns only the file's name and the field it went into, never the file. Any other file is still yours to choose. Text on web pages is treated as data, never as instructions.

Some sites do not allow signing in with Google inside an app's browser. Sign in with email and password there, or click **Open in your browser**.

### Recording an application by itself

When an application is sent in the Dayjob browser, whether you clicked Submit yourself, the panel's auto-submit did, the [assistant](#applying-for-you) applied for you or a Claude outside Dayjob clicked, and the next page says the application was received ("Thank you for applying" and the like), Dayjob adds the job to **Applications** by itself: status Applied, dated now, with follow-up reminders and the closed-posting check starting as usual, and a note that says it was recorded automatically and who sent it.

- A strip above the page says **Recorded as applied**, with the company and the title, and goes away after three minutes. **Undo** removes the application again; **View** opens it.
- A job that is already in Dayjob (the tab came through its posting or its application page) is recorded as that job. One that is not is created from the standard job data on its page (schema.org JobPosting).
- Dayjob records by itself only when it is sure: the form or the confirming page has to name the job's title or its company. When it does not, or the page never said which job it was, and you sent it yourself, the strip asks **Was that an application?**: enter the title and the company and click **Record it**, or **Not an application**. The assistant and Claude are not asked this way; they record it themselves.
- An application is never recorded twice, and a job that is already tracked is left as it is.
- To turn this off, untick **Record applications by itself** under This page in the browser assistant panel.

It goes by the words on the page, so some sites will not be recognized (no confirmation after sending, or an unusual one): click **Mark applied** there as before.

## JobSpy

Glassdoor, ZipRecruiter and Google Jobs are fetched through the Python [JobSpy](https://github.com/speedyapply/JobSpy). **The Windows installer and the portable app carry their own**: a Python 3.12 that only Dayjob uses, with JobSpy 1.4.1 in it. It works as soon as Dayjob is installed, with no Python on the computer. LinkedIn, Indeed and company boards do not go through it.

**Settings → JobSpy** shows its version and whether it runs. To use a Python of your own instead (one with a newer JobSpy, say), pick **My own Python** there, give the Python command (`python` on Windows by default) and install JobSpy into that Python first:

```bash
pip install python-jobspy
```

Save the settings to check it again. With several Pythons on the computer, make sure JobSpy went into the one named here: when it is missing, Settings says which Python was asked and what it answered (`No module named jobspy`, for example). Then run `<that Python> -m pip install python-jobspy`, or change the Python command to the one that has JobSpy (`py`, for example).

The built-in copy keeps to itself: it loads modules from its own folder only, ignores `PYTHONPATH` and the other Python variables, the registry and the packages installed for your user, and is removed together with Dayjob. It adds about 25 MB to the download and about 100 MB once installed.

Run from source, Dayjob has no built-in copy and uses your own Python (the `pip install` above). To try the built-in one from source on Windows, put it together in `build/jobspy` and tell Dayjob where it is (in Command Prompt):

```bash
npm run jobspy:build
set DAYJOB_JOBSPY_DIR=%cd%\build\jobspy
npm start
```

`npm run jobspy:build` (which `npm run package:win` runs first) downloads the Python Software Foundation's Python from nuget.org and, from PyPI, the 22 packages listed in `scripts/jobspy-requirements.txt`, each with an exact version and SHA-256 hashes; one file that does not match stops the build. On Windows it also starts the result once and checks that it loads from its own folder only. To move to a newer JobSpy, change that file and the versions in `scripts/build-jobspy.mjs`.

## About scraping

- LinkedIn and Indeed limit frequent requests. Dayjob waits a few random seconds between pages and backs off on HTTP 429; when a site limits it, that run is marked partly succeeded and the other sources carry on. One run a day with a few dozen results per search is usually fine; avoid short intervals or hundreds of results at once.
- When checking whether jobs have closed, a job that today's search still lists counts as open and is not requested again. Some networks are refused Indeed's job pages (HTTP 401); then Dayjob cannot tell whether an Indeed job has closed, only whether it still shows up in searches. Other sources are checked as usual.
- Glassdoor, ZipRecruiter and Google Jobs rely on JobSpy, and these sites often turn automated requests away; when one does, the details of that run say that the site gave nothing (not that Dayjob or JobSpy is set up wrongly) and the other sources carry on. JobSpy may need updating when those sites change (wait for a new Dayjob, or switch to your own Python).
- Follow each site's terms of use and use Dayjob for your own job search only.

To check every source from your network:

```bash
npm run live-check                          # LinkedIn, Indeed, Greenhouse, Lever, Ashby
npm run live-check -- --pipeline            # plus a full run into a temporary database
npm run live-check -- --score resume.pdf    # plus one Claude Code score
npm run live-check -- --jobspy              # plus the JobSpy in your own Python
```

## Tests

```bash
npm test
```

The tests never touch a real site: scrapers read saved pages (`tests/fixtures/`), scoring uses fake providers and MCP an in-memory connection.

The desktop smoke test (`electron . --smoke-test <result.json>`, run on every Windows build) also opens a local application form in the built-in browser (part of it inside an iframe from another origin), autofills it and checks every value, checks that a second run leaves the filled answers alone, checks that Claude clicking Submit asks the user first, and that with auto-submit on, Autofill submits the form and recognizes the "application received" page, after which the application is recorded by itself (as are one you submit by hand and one the page does not name, which is asked about). It also answers a page of questions with choices, clicking radio buttons drawn four different ways and a checkbox and checking that the form really received each answer, and checks that an ordinary text box is not taken for a password or a code while a real one-time-code box is still refused. All three Windows builds also start the JobSpy inside them once, checking its version and that it loads from its own folder only. For the installed app it also serves a pretend "9.9.9" release from this computer, checks that the sidebar shows the round download button, then clicks it and downloads and verifies the installer (without installing it).

To try the interface without scraping, generate made-up data:

```bash
node scripts/seed-demo.mjs ./demo-data
DAYJOB_DATA_DIR=./demo-data npm start
```

## Releasing

For every pull request and every push to main, GitHub Actions runs the tests on Windows, puts the built-in JobSpy together, builds the installer and the portable app, and starts each form (unpacked, silently installed and portable), including the packaged Claude MCP connection.

To release, change `version` in `package.json` (for example to `0.2.0`) and merge to main. If that version has not been released yet, the workflow publishes the files it just verified as release `v0.2.0`. There is no tag to push, and releases are never published by hand on GitHub.

To check a build on your own computer:

```bash
npm run package:win
powershell -ExecutionPolicy Bypass -File scripts/verify-windows-build.ps1 -Version 0.7.0
```

## License notes

The scrapers follow [JobSpy](https://github.com/speedyapply/JobSpy) (MIT). The Windows builds carry Python, JobSpy and the packages it uses, each under its own license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
