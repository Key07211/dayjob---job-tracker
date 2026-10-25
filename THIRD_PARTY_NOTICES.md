# Third-party notices

## JobSpy

Dayjob's LinkedIn and Indeed scrapers (`server/jobs/scrapers/linkedin.mjs`,
`server/jobs/scrapers/indeed.mjs`) follow the request formats, headers and
parsing approach of JobSpy, rewritten in JavaScript. The optional Glassdoor,
ZipRecruiter and Google Jobs sources run the user's own installed copy of
JobSpy (`pip install python-jobspy`); it is not bundled.

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
