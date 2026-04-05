import esbuild from "esbuild";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

console.log("Starting Atheon-OpenClaw build...");
try {
  rmSync("dist", { recursive: true, force: true });
  console.log("✔ Cleaned dist/ directory.");
} catch (e) {}

try {
  execSync("tsc --noEmit --project tsconfig.json", { stdio: "inherit" });
  console.log("✔ TypeScript type-check passed.");
} catch (e) {
  console.error("\n❌ TypeScript type-check failed. Aborting build.");
  process.exit(1);
}

const config = {
  entryPoints: ["src/**/*.ts"],
  outdir: "dist",
  outbase: "src",
  sourcemap: true,
  minify: true,
  platform: "node",
  target: "esnext",
  format: "esm",
};

async function build() {
  try {
    // Build ES Module
    await esbuild.build({ ...config });
    console.log("✔ ESM build complete.");

    console.log("\n✅ Build complete!");
  } catch (error) {
    console.error("\n❌ Build failed:", error);
    process.exit(1);
  }
}

build();
