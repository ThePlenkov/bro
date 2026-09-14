/**
 * Build @nx-devkit/skill and @nx-devkit/skillspector from the vendored nx.ts submodule.
 *
 * Applies local patches to the submodule source (see patch-nx-submodule.ts),
 * runs `bun install` in vendor/nx.ts (if needed) then `bun run build` in each
 * package so that executors.json → ./dist/... paths resolve at runtime.
 * After building, syncs dist/ into node_modules/@nx-devkit/<pkg>/dist/ because
 * bun's `file:` protocol hardlinks files that existed at install time but does
 * not pick up newly created files (like dist output).
 *
 * Not invoked from postinstall — call explicitly after `git submodule update --init`.
 * Safe to re-run.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SUBMODULE = resolve(REPO_ROOT, "vendor/nx.ts");
const PACKAGES = [
  { src: "packages/skill", nm: "@nx-devkit/skill" },
  { src: "packages/skillspector", nm: "@nx-devkit/skillspector" },
  { src: "packages/tsdown", nm: "@nx-devkit/tsdown" },
] as const;

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`> ${cmd} ${args.join(" ")}  (cwd: ${cwd})`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  if (!existsSync(SUBMODULE)) {
    console.error(`vendor/nx.ts not found at ${SUBMODULE} — run: git submodule update --init`);
    process.exit(1);
  }

  // Apply local patches to submodule source before building.
  console.log("Applying submodule patches...");
  run("bun", [resolve(REPO_ROOT, "scripts/patch-nx-submodule.ts")], REPO_ROOT);

  // Install submodule deps if tsdown is missing.
  const tsdownBin = resolve(SUBMODULE, "node_modules/.bin/tsdown");
  if (!existsSync(tsdownBin)) {
    console.log("Installing vendored nx.ts dependencies...");
    run("bun", ["install", "--frozen-lockfile"], SUBMODULE);
  }

  for (const pkg of PACKAGES) {
    const pkgDir = resolve(SUBMODULE, pkg.src);
    if (!existsSync(pkgDir)) {
      console.error(`Package directory not found: ${pkgDir}`);
      process.exit(1);
    }
    console.log(`Building ${pkg.src}...`);
    run("bun", ["run", "build"], pkgDir);

    // Sync dist/ into node_modules so Nx can resolve executors.json → ./dist/...
    const distSrc = resolve(pkgDir, "dist");
    const distDst = resolve(REPO_ROOT, "node_modules", pkg.nm, "dist");
    if (existsSync(distSrc)) {
      // With npm's file: protocol, node_modules/@nx-devkit/<pkg> is a symlink
      // to vendor/nx.ts/packages/<pkg>, so distDst resolves back to distSrc.
      // cpSync throws ERR_FS_CP_EINVAL when source and destination are the
      // same path — skip the copy in that case (the build already wrote dist
      // in-place).
      let samePath = false;
      try {
        samePath = realpathSync(distSrc) === realpathSync(distDst);
      } catch {
        // distDst doesn't exist yet — not the same path, proceed with copy.
      }
      if (!samePath) {
        mkdirSync(resolve(distDst, ".."), { recursive: true });
        cpSync(distSrc, distDst, { recursive: true });
        console.log(`Synced dist/ → node_modules/${pkg.nm}/dist/`);
      } else {
        console.log(`dist/ already in-place (symlink resolves to source) — skip sync`);
      }
    }
  }

  console.log("Vendored nx plugins built successfully.");
}

main();
