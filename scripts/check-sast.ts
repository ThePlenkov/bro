/**
 * Run the local, diff-scoped static-analysis parity sweep before pushing.
 *
 *   node scripts/check-sast.ts [base-ref]
 *
 * The sweep deliberately uses the same rule families that the remote SAST
 * checks use, while keeping the input to the PR's changed files. Uncommitted
 * tracked and untracked files are included so this is useful before a push.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { ESLint } from 'eslint';
import security from 'eslint-plugin-security';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function changedFiles(base: string): string[] {
  const committed = run('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]);
  const working = run('git', ['diff', '--name-only', '--diff-filter=ACMR', base]);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${committed}\n${working}\n${untracked}`.split('\n').filter(Boolean))].map(
    file => resolve(root, file)
  );
}

function defaultBase(): string {
  try {
    return run('git', ['merge-base', 'origin/main', 'HEAD']).trim();
  } catch {
    return 'origin/main';
  }
}

async function lintTypeScript(files: string[]): Promise<boolean> {
  if (files.length === 0) return true;
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          projectService: { allowDefaultProject: ['scripts/*.ts'] },
          tsconfigRootDir: root,
        },
      },
      plugins: { security, '@typescript-eslint': tseslint },
      rules: {
        ...Object.fromEntries(
          Object.keys(security.configs.recommended.rules).map(rule => [rule, 'error'])
        ),
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/no-unnecessary-condition': 'error',
      },
    },
  });
  const results = await eslint.lintFiles(files);
  const output = await eslint.loadFormatter('stylish').then(formatter => formatter.format(results));
  if (output) process.stdout.write(output);
  return results.every(result => result.errorCount === 0);
}

function runCli(name: string, files: string[], args: string[]): boolean {
  if (files.length === 0) return true;
  const binary = join(root, 'node_modules', '.bin', name);
  try {
    process.stdout.write(run(binary, [...args, ...files.map(file => relative(root, file))]));
    return true;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    return false;
  }
}

async function main(): Promise<void> {
  const base = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? defaultBase();
  const files = changedFiles(base);
  const typeScript = files.filter(file => /\.(?:ts|tsx)$/.test(file));
  const markdown = files.filter(file => /\.md$/.test(file));
  const duplicable = files.filter(file => /\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(file));

  console.log(`check-sast: ${files.length} changed file(s) from ${base}`);
  const eslintOk = await lintTypeScript(typeScript);
  const markdownOk = runCli('markdownlint-cli2', markdown, []);
  const duplicationOk = runCli('jscpd', duplicable, ['--silent', '--reporters', 'console']);
  if (!eslintOk || !markdownOk || !duplicationOk) process.exitCode = 1;
}

await main();
