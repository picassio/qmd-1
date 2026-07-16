import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const packageJson = JSON.parse(read("package.json"));
const npmLock = JSON.parse(read("package-lock.json"));
const pnpmLock = YAML.parse(read("pnpm-lock.yaml"));
const bunLock = read("bun.lock");
const bunRoot = JSON.parse(bunLock.replace(/,\s*([}\]])/g, "$1")).workspaces[""];

const RELEASE_VERSION = "2.6.0";
const RELEASE_IDENTITY = `qmd-engine@${RELEASE_VERSION}`;

function directSpecifiers(group: Record<string, { specifier: string }> | undefined) {
  return Object.fromEntries(
    Object.entries(group ?? {}).map(([name, value]) => [name, value.specifier]),
  );
}

describe("npm artifact release contract", () => {
  it("uses the qmd-engine 2.6.0 identity in every tracked lock root", () => {
    expect(`${packageJson.name}@${packageJson.version}`).toBe(RELEASE_IDENTITY);
    expect(`${npmLock.name}@${npmLock.version}`).toBe(RELEASE_IDENTITY);
    expect(`${npmLock.packages[""].name}@${npmLock.packages[""].version}`).toBe(RELEASE_IDENTITY);

    expect(pnpmLock.importers["."].name).toBe("qmd-engine");
    expect(pnpmLock.importers["."].version).toBe(RELEASE_VERSION);

    expect(`${bunRoot.name}@${bunRoot.version}`).toBe(RELEASE_IDENTITY);
  });

  it("keeps all direct dependency declarations synchronized with every lock", () => {
    const npmRoot = npmLock.packages[""];
    expect(npmRoot.dependencies).toEqual(packageJson.dependencies);
    expect(npmRoot.devDependencies).toEqual(packageJson.devDependencies);
    expect(npmRoot.optionalDependencies).toEqual(packageJson.optionalDependencies);
    expect(npmRoot.peerDependencies).toEqual(packageJson.peerDependencies);
    expect(npmRoot.peerDependenciesMeta).toEqual(packageJson.peerDependenciesMeta);

    const pnpmRoot = pnpmLock.importers["."];
    expect(read(".npmrc")).toContain("auto-install-peers=false");
    expect(pnpmLock.settings.autoInstallPeers).toBe(false);
    expect(directSpecifiers(pnpmRoot.dependencies)).toEqual(packageJson.dependencies);
    expect(directSpecifiers(pnpmRoot.devDependencies)).toEqual(packageJson.devDependencies);
    expect(directSpecifiers(pnpmRoot.optionalDependencies)).toEqual(packageJson.optionalDependencies);

    expect(bunRoot.dependencies).toEqual(packageJson.dependencies);
    expect(bunRoot.devDependencies).toEqual(packageJson.devDependencies);
    expect(bunRoot.optionalDependencies).toEqual(packageJson.optionalDependencies);
    expect(bunRoot.peerDependencies).toEqual(packageJson.peerDependencies);
  });

  it("keeps node-llama-cpp development-only and an optional peer", () => {
    expect(packageJson.dependencies["node-llama-cpp"]).toBeUndefined();
    expect(packageJson.optionalDependencies["node-llama-cpp"]).toBeUndefined();
    expect(packageJson.devDependencies["node-llama-cpp"]).toBe("3.18.1");
    expect(packageJson.peerDependencies["node-llama-cpp"]).toBe("^3.18.1");
    expect(packageJson.peerDependenciesMeta["node-llama-cpp"]).toEqual({ optional: true });

    expect(pnpmLock.importers["."].dependencies["node-llama-cpp"]).toBeUndefined();
    expect(pnpmLock.importers["."].devDependencies["node-llama-cpp"].specifier).toBe("3.18.1");
  });

  it("ships only the explicit package allowlist and has a mandatory artifact gate", () => {
    expect(packageJson.files).toEqual(["bin/", "dist/", "LICENSE", "CHANGELOG.md"]);
    expect(packageJson.scripts.prepublishOnly).toBe("npm run build");
    expect(packageJson.scripts["test:package"]).toBe("bash test/package-artifact.test.sh");
    expect(statSync(resolve(root, "test/package-artifact.test.sh")).mode & 0o111).not.toBe(0);
  });

  it("documents the published package and fork release tag namespace", () => {
    const readme = read("README.md");
    expect(readme).toContain("npm install -g qmd-engine");
    expect(readme).toContain("QMD_COMPAT_MODE=agent-board");
    expect(readme).toContain("qmd vsearch \"how to login\" --no-expand");
    expect(readme).not.toContain("@tobilu/qmd");
    expect(readme).not.toContain("@picassio/qmd");

    const hook = read("scripts/pre-push");
    expect(hook).toContain("refs/tags/engine-v*");
    expect(hook).toContain('VERSION="${TAG#engine-v}"');
    expect(hook).not.toContain("refs/tags/v*");

    const release = read("scripts/release.sh");
    expect(release).toContain('TAG="engine-v$NEW"');
    expect(release).not.toContain('git tag -a "v$NEW"');

    const publish = read(".github/workflows/publish.yml");
    expect(publish).toContain('tags: ["engine-v*"]');
    expect(publish).toContain("npm run test:package");
  });
});
