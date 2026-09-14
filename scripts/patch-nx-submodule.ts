#!/usr/bin/env bun
/**
 * Apply local patches to the vendored nx.ts submodule.
 *
 * The submodule is pinned to a specific SHA of nx-devkit/nx.ts. Three fixes
 * are needed for Nx to load the plugins correctly but are not yet committed
 * upstream. This script applies them idempotently after `git submodule update
 * --init` so that `build:nx-plugins` builds patched source.
 *
 * Patches:
 * 1. package.json exports: point `default` at dist/*.mjs (Node can't strip
 *    types from src/*.ts under node_modules)
 * 2. shouldSkipPath: skip `vendor/` so plugins don't scan SKILL.md inside
 *    the submodule itself
 * 3. createNodesV2: use projectRoot as the key in the projects map (Nx
 *    expects project root, not injective project name)
 *
 * Once these are upstreamed and the submodule pointer is updated, this
 * script can be deleted.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SUBMODULE = resolve(REPO_ROOT, "vendor/nx.ts");

const PKGS = [
  { dir: "packages/skill", name: "@nx-devkit/skill" },
  { dir: "packages/skillspector", name: "@nx-devkit/skillspector" },
  { dir: "packages/tsdown", name: "@nx-devkit/tsdown" },
] as const;

function patchFile(path: string, check: (content: string) => boolean, apply: (content: string) => string): void {
  if (!existsSync(path)) {
    console.warn(`  ! not found: ${path}`);
    return;
  }
  const original = readFileSync(path, "utf8");
  if (check(original)) {
    console.log(`  ✓ already patched: ${path}`);
    return;
  }
  const patched = apply(original);
  writeFileSync(path, patched, "utf8");
  console.log(`  ✓ patched: ${path}`);
}

function main(): void {
  if (!existsSync(SUBMODULE)) {
    console.error(`vendor/nx.ts not found — run: git submodule update --init`);
    process.exit(1);
  }

  console.log("Applying submodule patches...");

  for (const pkg of PKGS) {
    const pkgDir = resolve(SUBMODULE, pkg.dir);

    // Patch 1: package.json exports — dist instead of src for default.
    // JSON transform: upstream formatting may vary (single- or multi-line).
    const pkgJsonPath = resolve(pkgDir, "package.json");
    patchFile(
      pkgJsonPath,
      (c) => c.includes('"./dist/index.mjs"') && c.includes('"./package.json"'),
      (c) => {
        const pkg = JSON.parse(c) as {
          main?: string;
          module?: string;
          types?: string;
          exports?: Record<string, unknown>;
          [k: string]: unknown;
        };
        pkg.main = "./dist/index.mjs";
        pkg.module = "./dist/index.mjs";
        pkg.types = "./dist/index.d.mts";
        pkg.exports = {
          ".": {
            "@nx/nx-source": "./src/index.ts",
            types: "./dist/index.d.mts",
            default: "./dist/index.mjs",
          },
          "./plugin": {
            "@nx/nx-source": "./src/plugin.ts",
            types: "./dist/plugin.d.mts",
            default: "./dist/plugin.mjs",
          },
          "./package.json": "./package.json",
        };
        return `${JSON.stringify(pkg, null, 2)}\n`;
      },
    );

    // Patch 2 & 3: plugin.ts — vendor skip + project root key.
    // tsdown already keys projects by projectRoot and has no executors.json.
    if (pkg.name === "@nx-devkit/tsdown") {
      continue;
    }
    const pluginPath = resolve(pkgDir, "src/plugin.ts");
    if (pkg.name === "@nx-devkit/skill") {
      patchFile(
        pluginPath,
        (c) => c.includes("rel.startsWith('vendor/')"),
        (c) => {
          // Patch 2: add vendor/ to shouldSkipPath (after node_modules check)
          if (!c.includes("rel.startsWith('vendor/')")) {
            c = c.replace(
              "if (rel.includes('node_modules')) {\n    return true\n  }",
              "if (rel.includes('node_modules')) {\n    return true\n  }\n\n  if (rel.startsWith('vendor/')) {\n    return true\n  }",
            );
          }
          // Patch 3: use projectRoot as key, add name field
          c = c.replace(
            /projects:\s*\{\s*\n\s*\[projectName\]:\s*\{\s*\n\s*targets,/,
            "projects: {\n              [projectRoot]: {\n                name: projectName,\n                root: projectRoot,\n                targets,",
          );
          return c;
        },
      );

      // Patch 4: build executor — use --project/--out-dir to match local compiler CLI
      const executorPath = resolve(pkgDir, "src/executors/build/executor.ts");
      patchFile(
        executorPath,
        (c) => c.includes("'--project'"),
        (c) =>
          c
            .replace("'--out',", "'--out-dir',")
            .replace("'--skill',", "'--project',"),
      );

      // Patch 5: executors.json — add .mjs extension for ESM resolution
      const executorsJsonPath = resolve(pkgDir, "executors.json");
      patchFile(
        executorsJsonPath,
        (c) => c.includes('"./dist/executors/build/executor.mjs"'),
        (c) => c.replace('"./dist/executors/build/executor"', '"./dist/executors/build/executor.mjs"'),
      );
    } else {
      patchFile(
        pluginPath,
        (c) => c.includes("projectRoot.startsWith('vendor/')"),
        (c) => {
          // Patch 2: add vendor/ to shouldSkipPath
          if (!c.includes("projectRoot.startsWith('vendor/')")) {
            c = c.replace(
              "if (projectRoot.split('/').includes('..')) return true",
              "if (projectRoot.startsWith('vendor/')) return true\n  if (projectRoot.split('/').includes('..')) return true",
            );
          }
          // Patch 3: use projectRoot as key, add name field
          c = c.replace(
            /const project:\s*ProjectConfiguration\s*=\s*\{\s*\n\s*root:/,
            "const project: ProjectConfiguration = {\n        name: projectName,\n        root:",
          );
          c = c.replace(
            "[projectName]: project,",
            "[projectRoot]: project,",
          );
          return c;
        },
      );

      // Patch 5: executors.json — add .mjs extension for ESM resolution
      const executorsJsonPath = resolve(pkgDir, "executors.json");
      patchFile(
        executorsJsonPath,
        (c) => c.includes('"./dist/executors/scan/executor.mjs"'),
        (c) => c.replace('"./dist/executors/scan/executor"', '"./dist/executors/scan/executor.mjs"'),
      );
    }
  }

  console.log("Submodule patches applied.");
}

main();
