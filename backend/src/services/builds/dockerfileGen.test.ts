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
