import { describe, expect, it } from 'vitest';

import { detectFramework, type RepoSignals } from './dockerfileGen.js';

/** Baseline signals: empty repo, nothing detected. Override per test. */
function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    rootEntries: [],
    hasPackageLock: false,
    hasPyproject: false,
    hasPipfile: false,
    hasManagePy: false,
    ...overrides,
  };
}

describe('detectFramework — Node', () => {
  it('detects Next.js as a server on port 3000', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { next: '14.0.0', react: '18' } },
      }),
    );
    expect(d?.framework).toBe('Next.js');
    expect(d?.port).toBe(3000);
    expect(d?.dockerfile).toContain('npm run build');
    expect(d?.dockerfile).toContain('CMD ["npm", "run", "start"]');
    expect(d?.dockerfile).toContain('ENV PORT=3000');
  });

  it('detects a Vite SPA as a static nginx site on port 80 (serves dist/)', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { devDependencies: { vite: '5.0.0' } },
      }),
    );
    expect(d?.framework).toBe('Vite (static SPA)');
    expect(d?.port).toBe(80);
    expect(d?.dockerfile).toContain('FROM nginx:alpine');
    expect(d?.dockerfile).toContain('COPY --from=build /app/dist /usr/share/nginx/html');
    expect(d?.dockerfile).toContain('try_files');
  });

  it('detects Create React App as a static site serving build/', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { 'react-scripts': '5.0.0' } },
      }),
    );
    expect(d?.framework).toBe('Create React App (static SPA)');
    expect(d?.dockerfile).toContain('COPY --from=build /app/build /usr/share/nginx/html');
  });

  it('detects an Express server (port 3000, npm start)', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { express: '4' }, scripts: { start: 'node index.js' } },
      }),
    );
    expect(d?.framework).toBe('Node.js (Express)');
    expect(d?.port).toBe(3000);
    expect(d?.dockerfile).toContain('CMD ["npm", "start"]');
  });

  it('falls back to a generic Node server when no framework dep matches', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { scripts: { start: 'node server.js' } },
      }),
    );
    expect(d?.framework).toBe('Node.js');
    expect(d?.port).toBe(3000);
  });

  it('uses npm ci when a lockfile is present, npm install otherwise', () => {
    const withLock = detectFramework(
      signals({
        rootEntries: ['package.json', 'package-lock.json'],
        hasPackageLock: true,
        packageJson: { dependencies: { express: '4' } },
      }),
    );
    const withoutLock = detectFramework(
      signals({ rootEntries: ['package.json'], packageJson: { dependencies: { express: '4' } } }),
    );
    expect(withLock?.dockerfile).toContain('RUN npm ci');
    expect(withoutLock?.dockerfile).toContain('RUN npm install');
  });
});

describe('detectFramework — Go', () => {
  it('detects Go via go.mod (multi-stage, port 8080)', () => {
    const d = detectFramework(signals({ rootEntries: ['go.mod', 'main.go'] }));
    expect(d?.framework).toBe('Go');
    expect(d?.port).toBe(8080);
    expect(d?.dockerfile).toContain('go build');
    expect(d?.dockerfile).toContain('COPY --from=build /app/server /app/server');
  });
});

describe('detectFramework — Python', () => {
  it('detects Django with a discovered wsgi module → gunicorn', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['manage.py', 'requirements.txt'],
        requirementsTxt: 'Django==5.0\ngunicorn',
        hasManagePy: true,
        djangoWsgiModule: 'myproj.wsgi',
      }),
    );
    expect(d?.framework).toBe('Django');
    expect(d?.port).toBe(8000);
    expect(d?.dockerfile).toContain('gunicorn myproj.wsgi:application');
  });

  it('detects Django without a wsgi module → manage.py runserver', () => {
    const d = detectFramework(
      signals({ rootEntries: ['manage.py'], hasManagePy: true }),
    );
    expect(d?.framework).toBe('Django');
    expect(d?.dockerfile).toContain('python manage.py runserver');
  });

  it('detects FastAPI → uvicorn main:app', () => {
    const d = detectFramework(
      signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: 'fastapi\nuvicorn' }),
    );
    expect(d?.framework).toBe('FastAPI');
    expect(d?.dockerfile).toContain('uvicorn main:app');
  });

  it('detects Flask → gunicorn app:app', () => {
    const d = detectFramework(
      signals({ rootEntries: ['requirements.txt', 'app.py'], requirementsTxt: 'Flask==3.0' }),
    );
    expect(d?.framework).toBe('Flask');
    expect(d?.dockerfile).toContain('gunicorn app:app');
  });

  it('detects a generic Python entrypoint (main.py)', () => {
    const d = detectFramework(
      signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: 'requests' }),
    );
    expect(d?.framework).toBe('Python');
    expect(d?.dockerfile).toContain('CMD ["python", "main.py"]');
  });

  it('detects an app.py entrypoint when there is no main.py', () => {
    const d = detectFramework(
      signals({ rootEntries: ['requirements.txt', 'app.py'], requirementsTxt: 'requests' }),
    );
    expect(d?.framework).toBe('Python');
    expect(d?.dockerfile).toContain('CMD ["python", "app.py"]');
  });

  it('returns null for a Python project with no recognizable entrypoint (no crashing app.py guess)', () => {
    // A pyproject/Pipfile project with no main.py/app.py and no web framework
    // must NOT build an image that crashes at runtime with `can't open 'app.py'`;
    // it falls through to the friendly "add a Dockerfile" error instead.
    expect(
      detectFramework(signals({ rootEntries: ['pyproject.toml', 'lib'], hasPyproject: true })),
    ).toBeNull();
    expect(
      detectFramework(signals({ rootEntries: ['Pipfile', 'src'], hasPipfile: true })),
    ).toBeNull();
  });

  it('installs Pipenv deps for a Pipfile-only project (no silent zero-install image)', () => {
    const d = detectFramework(
      signals({ rootEntries: ['Pipfile', 'main.py'], hasPipfile: true }),
    );
    expect(d?.framework).toBe('Python');
    expect(d?.dockerfile).toContain('COPY Pipfile* ./');
    expect(d?.dockerfile).toContain('pip install --no-cache-dir pipenv');
    expect(d?.dockerfile).toContain('pipenv install --system');
    // No lock → resolve at build time (no --deploy), and manifest copied before source.
    expect(d?.dockerfile).not.toContain('--deploy');
    const df = d?.dockerfile ?? '';
    expect(df.indexOf('COPY Pipfile* ./')).toBeLessThan(df.indexOf('COPY . .'));
  });

  it('uses a reproducible Pipenv install when a Pipfile.lock is present', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['Pipfile', 'Pipfile.lock', 'main.py'],
        hasPipfile: true,
        hasPipfileLock: true,
      }),
    );
    expect(d?.dockerfile).toContain('pipenv install --system --deploy --ignore-pipfile');
  });

  it('lets a Django manage.py win over a frontend-tooling package.json', () => {
    // A Django repo commonly ships a package.json for Tailwind/esbuild. manage.py
    // is the unambiguous Python-app marker, so Python must win — otherwise we'd
    // build the Node tooling and never run the Django server.
    const d = detectFramework(
      signals({
        rootEntries: ['manage.py', 'package.json', 'requirements.txt'],
        hasManagePy: true,
        requirementsTxt: 'Django==5.0',
        packageJson: { devDependencies: { tailwindcss: '3' }, scripts: { build: 'tailwind' } },
      }),
    );
    expect(d?.framework).toBe('Django');
    expect(d?.dockerfile).toContain('manage.py runserver');
  });

  it('rejects a hostile djangoWsgiModule even inside the pure module (defense-in-depth)', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['manage.py'],
        hasManagePy: true,
        djangoWsgiModule: 'evil:application"]\nRUN echo pwned\n#',
      }),
    );
    expect(d?.framework).toBe('Django');
    expect(d?.dockerfile).not.toContain('RUN echo pwned');
    expect(d?.dockerfile).toContain('manage.py runserver');
  });
});

describe('detectFramework — Vite SSR meta-frameworks (not static SPAs)', () => {
  // These all carry `vite` in their dep tree but are server-rendered — they must
  // NOT be served as a static dist/ SPA (the dist/ either doesn't exist or holds
  // only the client half). They get a long-lived Node server instead.
  it('detects Nuxt as a Node server, not a static SPA', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { nuxt: '3', vite: '5' } },
      }),
    );
    expect(d?.framework).toBe('Nuxt');
    expect(d?.port).toBe(3000);
    expect(d?.dockerfile).toContain('.output/server/index.mjs');
    expect(d?.dockerfile).not.toContain('/usr/share/nginx/html');
  });

  it('detects SvelteKit as a Node server, not a static SPA', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { devDependencies: { '@sveltejs/kit': '2', vite: '5' } },
      }),
    );
    expect(d?.framework).toBe('SvelteKit');
    expect(d?.dockerfile).toContain('CMD ["node", "build"]');
    expect(d?.dockerfile).not.toContain('/usr/share/nginx/html');
  });

  it('detects Astro SSR only when the node adapter is present', () => {
    const ssr = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { astro: '4', '@astrojs/node': '8', vite: '5' } },
      }),
    );
    expect(ssr?.framework).toBe('Astro (SSR)');
    expect(ssr?.dockerfile).toContain('./dist/server/entry.mjs');
  });

  it('detects Remix as a Node server', () => {
    const d = detectFramework(
      signals({
        rootEntries: ['package.json'],
        packageJson: { dependencies: { '@remix-run/node': '2', vite: '5' } },
      }),
    );
    expect(d?.framework).toBe('Remix');
    expect(d?.dockerfile).toContain('CMD ["npm", "start"]');
  });

  it('still treats a plain Vite app as a static SPA (no regression)', () => {
    const d = detectFramework(
      signals({ rootEntries: ['package.json'], packageJson: { devDependencies: { vite: '5' } } }),
    );
    expect(d?.framework).toBe('Vite (static SPA)');
    expect(d?.dockerfile).toContain('/usr/share/nginx/html');
  });
});

describe('detectFramework — static + no match', () => {
  it('detects a plain static site (index.html, no manifest)', () => {
    const d = detectFramework(signals({ rootEntries: ['index.html', 'style.css'] }));
    expect(d?.framework).toBe('Static site');
    expect(d?.port).toBe(80);
    expect(d?.dockerfile).toContain('COPY . /usr/share/nginx/html');
  });

  it('returns null when nothing is recognized', () => {
    expect(detectFramework(signals({ rootEntries: ['README.md', 'LICENSE'] }))).toBeNull();
  });
});

describe('detectFramework — build-time-public env vars', () => {
  it('declares NEXT_PUBLIC_* as ARG+ENV before the Next.js build step', () => {
    const d = detectFramework(
      signals({ rootEntries: ['package.json'], packageJson: { dependencies: { next: '14' } } }),
      { buildArgKeys: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] },
    );
    const df = d?.dockerfile ?? '';
    expect(df).toContain('ARG NEXT_PUBLIC_SUPABASE_URL');
    expect(df).toContain('ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL');
    expect(df).toContain('ARG NEXT_PUBLIC_SUPABASE_ANON_KEY');
    // The bundler only inlines vars set before the build runs.
    expect(df.indexOf('ARG NEXT_PUBLIC_SUPABASE_URL')).toBeLessThan(df.indexOf('RUN npm run build'));
  });

  it('declares ARGs in the Vite build stage (before npm run build)', () => {
    const d = detectFramework(
      signals({ rootEntries: ['package.json'], packageJson: { devDependencies: { vite: '5' } } }),
      { buildArgKeys: ['VITE_API_URL'] },
    );
    const df = d?.dockerfile ?? '';
    expect(df).toContain('ARG VITE_API_URL');
    expect(df).toContain('ENV VITE_API_URL=$VITE_API_URL');
    expect(df.indexOf('ARG VITE_API_URL')).toBeLessThan(df.indexOf('RUN npm run build'));
    // Still kaniko-safe with ARGs added.
    expect(df).not.toContain('--mount=');
    expect(df).not.toContain('<<');
  });

  it('emits no ARG lines when there are no build-time-public vars', () => {
    const d = detectFramework(
      signals({ rootEntries: ['package.json'], packageJson: { dependencies: { next: '14' } } }),
    );
    expect(d?.dockerfile).not.toContain('ARG ');
  });

  it('ignores buildArgKeys for non-Node frameworks (no JS bundler)', () => {
    const go = detectFramework(signals({ rootEntries: ['go.mod'] }), {
      buildArgKeys: ['NEXT_PUBLIC_X'],
    });
    expect(go?.dockerfile).not.toContain('ARG NEXT_PUBLIC_X');
  });
});

describe('generated Dockerfiles are kaniko-safe (classic syntax only)', () => {
  // Kaniko is archived and rejects BuildKit-only syntax. Every recipe must avoid
  // cache/secret/bind mounts, heredocs, and the syntax frontend directive.
  const recipes: RepoSignals[] = [
    signals({ rootEntries: ['package.json'], packageJson: { dependencies: { next: '14' } } }),
    signals({ rootEntries: ['package.json'], packageJson: { devDependencies: { vite: '5' } } }),
    signals({ rootEntries: ['package.json'], packageJson: { dependencies: { 'react-scripts': '5' } } }),
    signals({ rootEntries: ['package.json'], packageJson: { dependencies: { express: '4' } } }),
    signals({ rootEntries: ['go.mod'] }),
    signals({ rootEntries: ['manage.py'], hasManagePy: true, djangoWsgiModule: 'p.wsgi' }),
    signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: 'fastapi' }),
    signals({ rootEntries: ['index.html'] }),
  ];

  it.each(recipes)('recipe #%# uses no BuildKit-only features', (s) => {
    const df = detectFramework(s)?.dockerfile ?? '';
    expect(df).not.toContain('--mount=');
    expect(df).not.toContain('<<EOF');
    expect(df).not.toContain('# syntax=');
    expect(df).not.toContain('--link');
    // sanity: every recipe produces a FROM line
    expect(df).toMatch(/^FROM /m);
  });
});

describe('generated Dockerfiles are cache-friendly (install before full COPY)', () => {
  // For the registry layer cache (docs/BUILD_CACHE.md) to HIT, the dependency
  // install must come BEFORE the full-source `COPY . .`, so an app-only change
  // reuses the network-heavy install layer. These tests lock that ordering in.

  it('Node server: COPY package*.json + install precede COPY . .', () => {
    const df =
      detectFramework(
        signals({ rootEntries: ['package.json'], packageJson: { dependencies: { express: '4' } } }),
      )?.dockerfile ?? '';
    expect(df.indexOf('COPY package*.json ./')).toBeLessThan(df.indexOf('COPY . .'));
    expect(df.indexOf('RUN npm')).toBeLessThan(df.indexOf('COPY . .'));
  });

  it('Static SPA (Vite): COPY package*.json + install precede COPY . .', () => {
    const df =
      detectFramework(
        signals({ rootEntries: ['package.json'], packageJson: { devDependencies: { vite: '5' } } }),
      )?.dockerfile ?? '';
    expect(df.indexOf('COPY package*.json ./')).toBeLessThan(df.indexOf('COPY . .'));
    expect(df.indexOf('RUN npm')).toBeLessThan(df.indexOf('COPY . .'));
  });

  it('Go: COPY go.* + go mod download precede COPY . .', () => {
    const df = detectFramework(signals({ rootEntries: ['go.mod', 'main.go'] }))?.dockerfile ?? '';
    expect(df.indexOf('COPY go.* ./')).toBeLessThan(df.indexOf('COPY . .'));
    expect(df.indexOf('RUN go mod download')).toBeLessThan(df.indexOf('COPY . .'));
  });

  it('Python with requirements.txt: COPY requirements.txt + pip install precede COPY . .', () => {
    const df =
      detectFramework(
        signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: 'fastapi\nuvicorn' }),
      )?.dockerfile ?? '';
    expect(df).toContain('COPY requirements.txt ./');
    expect(df).toContain('RUN pip install --no-cache-dir -r requirements.txt');
    expect(df.indexOf('COPY requirements.txt ./')).toBeLessThan(df.indexOf('COPY . .'));
    expect(df.indexOf('RUN pip install --no-cache-dir -r requirements.txt')).toBeLessThan(
      df.indexOf('COPY . .'),
    );
  });

  it('Python requirements.txt with `-e .` copies full source BEFORE install (no broken split)', () => {
    // An editable/local install (`-e .`) needs setup.py/pyproject present when
    // pip runs, so the cache-friendly manifest-only split would break the build.
    const df =
      detectFramework(
        signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: '-e .\nfastapi' }),
      )?.dockerfile ?? '';
    expect(df).not.toContain('COPY requirements.txt ./');
    expect(df.indexOf('COPY . .')).toBeLessThan(
      df.indexOf('RUN pip install --no-cache-dir -r requirements.txt'),
    );
  });

  it('Python requirements.txt with `-r base.txt` copies full source BEFORE install', () => {
    // A `-r sibling.txt` reference needs that sibling file on disk at install
    // time → must copy the whole context first, not just requirements.txt.
    const df =
      detectFramework(
        signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: '-r base.txt' }),
      )?.dockerfile ?? '';
    expect(df).not.toContain('COPY requirements.txt ./');
    expect(df.indexOf('COPY . .')).toBeLessThan(
      df.indexOf('RUN pip install --no-cache-dir -r requirements.txt'),
    );
  });

  it('Python requirements.txt with an attached-form `-rbase.txt` copies full source first', () => {
    // Attached-form short options (`-rbase.txt`, no space) are valid pip syntax
    // and still pull in a sibling file → the manifest-only split would break.
    const df =
      detectFramework(
        signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: '-rbase.txt' }),
      )?.dockerfile ?? '';
    expect(df).not.toContain('COPY requirements.txt ./');
    expect(df.indexOf('COPY . .')).toBeLessThan(
      df.indexOf('RUN pip install --no-cache-dir -r requirements.txt'),
    );
  });

  it('Python with an empty requirements.txt installs nothing (no useless pip layer)', () => {
    const df =
      detectFramework(
        signals({ rootEntries: ['requirements.txt', 'main.py'], requirementsTxt: '   \n' }),
      )?.dockerfile ?? '';
    expect(df).toContain('COPY . .');
    expect(df).not.toContain('pip install');
  });

  it('Python with pyproject.toml installs the project from full source (no deps-only split)', () => {
    // `pip install .` builds the project itself, so the source must be present
    // first — there is no clean deps-only layer to cache here, by design.
    const df =
      detectFramework(
        signals({ rootEntries: ['pyproject.toml', 'main.py'], hasPyproject: true }),
      )?.dockerfile ?? '';
    expect(df).toContain('RUN pip install --no-cache-dir .');
    expect(df).not.toContain('COPY requirements.txt');
  });

  it('Python with no declared deps (manage.py, no requirements.txt) installs nothing', () => {
    const df =
      detectFramework(signals({ rootEntries: ['manage.py'], hasManagePy: true }))?.dockerfile ?? '';
    expect(df).toContain('COPY . .');
    expect(df).not.toContain('pip install');
  });
});
