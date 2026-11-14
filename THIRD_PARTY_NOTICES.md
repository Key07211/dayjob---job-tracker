# Third-party notices

## JobSpy

Dayjob's LinkedIn and Indeed scrapers (`server/jobs/scrapers/linkedin.mjs`,
`server/jobs/scrapers/indeed.mjs`) follow the request formats, headers and
parsing approach of JobSpy, rewritten in JavaScript. The Glassdoor,
ZipRecruiter and Google Jobs sources run JobSpy itself: the unmodified copy
inside the Windows app (see the next section), or the user's own installed
copy (`pip install python-jobspy`).

https://github.com/speedyapply/JobSpy

```
MIT License

Copyright (c) 2023 Cullen Watson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Python and the packages inside the Windows app

The Windows installer and the portable app carry a private Python runtime with
JobSpy in `resources/jobspy`, put together by `scripts/build-jobspy.mjs` from
unmodified upstream files: the Python Software Foundation's `python` package on
nuget.org and the wheels on PyPI listed, with their SHA-256 hashes, in
`scripts/jobspy-requirements.txt`. Test suites, type stubs, caches and
developer tools (headers, import libraries, IDLE, Tk, pip, venv) are left out;
no file is changed.

Each license ships with the app: Python's in `resources/jobspy/LICENSE.txt`,
and each package's in its own
`resources/jobspy/Lib/site-packages/<name>-<version>.dist-info` folder.

| Component | Version | License |
| --- | --- | --- |
| Python (CPython), https://www.python.org | 3.12.10 | PSF License Agreement (PSF-2.0); see `LICENSE.txt` for the licenses of the parts it includes |
| python-jobspy | 1.4.1 | MIT |
| annotated-types | 0.8.0 | MIT |
| beautifulsoup4 | 4.15.0 | MIT |
| certifi | 2026.10.23 | MPL-2.0 |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.2 | MIT |
| curl-cffi (includes curl-impersonate) | 0.17.0 | MIT |
| idna | 3.20 | BSD-3-Clause |
| markdownify | 1.2.3 | MIT |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pandas | 3.1.1 | BSD-3-Clause |
| pycparser | 3.12 | BSD-3-Clause |
| pydantic | 2.14.3 | MIT |
| pydantic-core | 2.50.4 | MIT |
| python-dateutil | 4.0.0 | BSD-3-Clause |
| requests | 2.34.2 | Apache-2.0 |
| six | 1.17.0 | MIT |
| soupsieve | 4.1 | MIT |
| typing-extensions | 4.16.0 | PSF-2.0 |
| typing-inspection | 0.4.5 | MIT |
| tzdata | 2026.6 | Apache-2.0 |
| urllib3 | 2.8.0 | MIT |

certifi is under the Mozilla Public License 2.0; its source is at
https://github.com/certifi/python-certifi.

## Fonts

The interface bundles two fonts under the SIL Open Font License 1.1
(https://openfontlicense.org; the full text is in `src/dayjob/fonts/OFL.txt`):

- LXGW 975 Yuan SC (霞鹜975圆体): Copyright 2021-2026 LXGW (https://github.com/lxgw/LxgwWenKai);
  Copyright 2020 The Klee Project Authors (https://github.com/fontworks-fonts/Klee).
  Taken from the `@free-fonts/lxgw-975-yuan` package and cut down to GB2312 plus the
  characters the app itself uses, in `src/dayjob/fonts`.
- Nunito: Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito),
  from the Fontsource package `@fontsource-variable/nunito`.

## Melodies

The sound cues play short phrases from public-domain music: Beethoven's
Symphony No. 9 ("Ode to Joy"), Moonlight Sonata and Für Elise, and Grieg's
"Morning Mood".

npm dependencies keep their own licenses in `node_modules/<package>/LICENSE`.
