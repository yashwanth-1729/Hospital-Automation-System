// Renders review frames: node stills.mjs 150 330 ...
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";

const frames = process.argv.slice(2).map(Number);
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "Pitch" });
for (const frame of frames) {
  await renderStill({ composition, serveUrl, output: `out/s-${frame}.png`, frame, scale: 0.5 });
  console.log("frame", frame);
}
