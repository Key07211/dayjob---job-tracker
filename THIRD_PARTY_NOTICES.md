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

npm dependencies keep their own licenses in `node_modules/<package>/LICENSE`.
