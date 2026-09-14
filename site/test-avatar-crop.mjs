// Real, pixel-level verification of the avatar crop tool: builds a real four-color
// test image, drives the actual openAvatarCropDialog() implementation through a real
// pointer drag + zoom + save, then decodes the exported PNG and checks which colors
// actually ended up where -- proving the pan/zoom/clamp math produces the crop a
// user would actually see, not just that some blob comes out the other end.
//
// jsdom itself does not decode <img> pixel data at all, so window.Image is swapped
// for node-canvas's real decoding Image for the duration of this test only -- this
// is a test-environment gap, not something the shipped widget-settings.js needs
// (real browsers decode images natively).
import { JSDOM } from "jsdom";
import { createCanvas, Image as NodeImage, loadImage } from "canvas";
import { build } from "esbuild";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

const BUNDLE_PATH = new URL("./imageCrop.test-bundle.tmp.js", import.meta.url);
await build({
  entryPoints: ["src/imageCrop.ts"],
  bundle: true,
  format: "iife",
  globalName: "ImageCropTest",
  platform: "browser",
  outfile: BUNDLE_PATH.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
});
// esbuild's IIFE output starts with "use strict"; a strict-mode indirect eval gets
// its own variable environment, so the bundle's top-level `var ImageCropTest = ...`
// would never actually reach window.ImageCropTest (only matters for this eval-based
// harness -- a real <script> tag runs as a normal global script).
const bundleSrc = readFileSync(BUNDLE_PATH, "utf8").replace('"use strict";', "");

function quadrantTestImage() {
  // 400x400: red top-left, green top-right, blue bottom-left, yellow bottom-right --
  // four unambiguous, evenly-sized regions to check which one a given pan/zoom
  // brings to the center of the crop circle.
  const c = createCanvas(400, 400);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = "#00ff00"; ctx.fillRect(200, 0, 200, 200);
  ctx.fillStyle = "#0000ff"; ctx.fillRect(0, 200, 200, 200);
  ctx.fillStyle = "#ffff00"; ctx.fillRect(200, 200, 200, 200);
  return c.toBuffer("image/png");
}

function setupDom(sourceBytes) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <dialog id="avatar-crop-dialog">
        <canvas id="avatar-crop-canvas" width="280" height="280"></canvas>
        <input type="range" id="avatar-crop-zoom" min="1" max="4" step="0.01" value="1" />
        <button type="button" id="avatar-crop-cancel">Cancel</button>
        <button type="button" id="avatar-crop-save">Save</button>
      </dialog>
    </body></html>`,
    { url: "https://example.test/", runScripts: "outside-only", resources: "usable" },
  );
  const { window } = dom;
  window.Image = NodeImage; // see file header -- jsdom itself never decodes real pixels

  // jsdom doesn't implement URL.createObjectURL/revokeObjectURL at all. Real browsers
  // hand back an opaque blob: URL that an <img src> can load directly; here we just
  // return a data: URL built from the same bytes the test already has on hand (the
  // real code only ever treats this as an opaque src string, so this substitution is
  // invisible to it) -- this is a test-environment gap, not a real code path.
  const dataUrl = `data:image/png;base64,${Buffer.from(sourceBytes).toString("base64")}`;
  window.URL.createObjectURL = () => dataUrl;
  window.URL.revokeObjectURL = () => {};

  // jsdom doesn't implement <dialog>.showModal()/.close() or pointer capture; these
  // are inert no-ops for the purposes of this test (the code only needs them to not
  // throw -- it doesn't depend on their actual capture/modal semantics).
  const dialog = window.document.getElementById("avatar-crop-dialog");
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };
  const canvas = window.document.getElementById("avatar-crop-canvas");
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};

  window.eval(bundleSrc);
  return { window, openAvatarCropDialog: window.ImageCropTest.openAvatarCropDialog };
}

function dragCanvas(window, canvas, fromX, fromY, toX, toY) {
  canvas.dispatchEvent(new window.PointerEvent("pointerdown", { clientX: fromX, clientY: fromY, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new window.PointerEvent("pointermove", { clientX: toX, clientY: toY, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new window.PointerEvent("pointerup", { clientX: toX, clientY: toY, pointerId: 1, bubbles: true }));
}

async function decodeImage(blob) {
  const buffer = Buffer.from(await blob.arrayBuffer());
  const img = await loadImage(buffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { img, ctx };
}

async function decodeCenterColor(blob) {
  const { img, ctx } = await decodeImage(blob);
  const [r, g, b] = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
  return { r, g, b };
}

function classify({ r, g, b }) {
  if (r > 200 && g < 80 && b < 80) return "red";
  if (r < 80 && g > 200 && b < 80) return "green";
  if (r < 80 && g < 80 && b > 200) return "blue";
  if (r > 200 && g > 200 && b < 80) return "yellow";
  return `unknown(${r},${g},${b})`;
}

async function main() {
  const pngBytes = quadrantTestImage();

  console.log("--- default crop (no pan/zoom) centers on the image's true center ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50)); // let the Image decode + onload fire
    window.document.getElementById("avatar-crop-save").dispatchEvent(new window.Event("click", { bubbles: true }));
    const blob = await resultPromise;
    assert(blob !== null, "save produced a real blob");
    const color = classify(await decodeCenterColor(blob));
    // The exact center of a 2x2 grid sits right on all four quadrants' shared corner --
    // whichever quadrant wins by a hair is implementation detail, so just confirm it's
    // one of the four real colors, not blank/black/some unrelated value.
    assert(["red", "green", "blue", "yellow"].includes(color), `center pixel is one of the four real quadrant colors (got ${color})`);

    const { img, ctx } = await decodeImage(blob);
    const [, , , cornerAlpha] = ctx.getImageData(1, 1, 1, 1).data;
    assert(cornerAlpha === 0, `output is a real circular crop -- corner pixel is transparent, not square (alpha=${cornerAlpha})`);
    assert(img.width === img.height, `output is square (${img.width}x${img.height})`);
  }

  // The test image is exactly square and matches the crop viewport's aspect ratio,
  // so at zoom=1 ("cover" fit) there is zero slack to pan in either dimension -- the
  // clamp correctly holds the offset at (0,0), since any pan would reveal empty
  // space. That's correct behavior, not a gap: real panning only becomes meaningful
  // once zoomed in, so these tests zoom first, same as a real user would.
  console.log("--- after zooming in, panning left+up brings the yellow (bottom-right) quadrant to center ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50));
    const zoomInput = window.document.getElementById("avatar-crop-zoom");
    zoomInput.value = "2";
    zoomInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    const canvas = window.document.getElementById("avatar-crop-canvas");
    // Dragging the pointer up-and-left shifts the image up-and-left too, moving the
    // bottom-right (yellow) region into the center of the circle.
    dragCanvas(window, canvas, 200, 200, 80, 80);
    window.document.getElementById("avatar-crop-save").dispatchEvent(new window.Event("click", { bubbles: true }));
    const blob = await resultPromise;
    const color = classify(await decodeCenterColor(blob));
    assert(color === "yellow", `dragging up-left brings yellow (bottom-right quadrant) to center (got ${color})`);
  }

  console.log("--- after zooming in, panning right+down brings the red (top-left) quadrant to center ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50));
    const zoomInput = window.document.getElementById("avatar-crop-zoom");
    zoomInput.value = "2";
    zoomInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    const canvas = window.document.getElementById("avatar-crop-canvas");
    dragCanvas(window, canvas, 80, 80, 200, 200);
    window.document.getElementById("avatar-crop-save").dispatchEvent(new window.Event("click", { bubbles: true }));
    const blob = await resultPromise;
    const color = classify(await decodeCenterColor(blob));
    assert(color === "red", `dragging down-right brings red (top-left quadrant) to center (got ${color})`);
  }

  console.log("--- zooming in stays centered (still ambiguous corner) but pan still works after zoom ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50));
    const zoomInput = window.document.getElementById("avatar-crop-zoom");
    zoomInput.value = "3";
    zoomInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    const canvas = window.document.getElementById("avatar-crop-canvas");
    dragCanvas(window, canvas, 200, 200, 260, 260); // small drag, but zoomed-in so still lands solidly in one quadrant
    window.document.getElementById("avatar-crop-save").dispatchEvent(new window.Event("click", { bubbles: true }));
    const blob = await resultPromise;
    const color = classify(await decodeCenterColor(blob));
    assert(color === "red", `after zooming in, a small drag toward top-left lands solidly on red (got ${color})`);
  }

  console.log("--- cancel resolves null, not a blob ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50));
    window.document.getElementById("avatar-crop-cancel").dispatchEvent(new window.Event("click", { bubbles: true }));
    const result = await resultPromise;
    assert(result === null, "cancel resolves null instead of uploading anything");
  }

  console.log("--- dragging cannot pull empty space into view (offset stays clamped) ---");
  {
    const { window, openAvatarCropDialog } = setupDom(pngBytes);
    const file = new window.File([pngBytes], "avatar.png", { type: "image/png" });
    const resultPromise = openAvatarCropDialog(file);
    await new Promise((r) => setTimeout(r, 50));
    const zoomInput = window.document.getElementById("avatar-crop-zoom");
    zoomInput.value = "2";
    zoomInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    const canvas = window.document.getElementById("avatar-crop-canvas");
    // A wildly oversized drag, far beyond the image's own bounds -- if clamping
    // works, this still can't drag the image away from covering the whole circle.
    dragCanvas(window, canvas, 140, 140, 140 - 5000, 140 - 5000);
    window.document.getElementById("avatar-crop-save").dispatchEvent(new window.Event("click", { bubbles: true }));
    const blob = await resultPromise;
    const color = classify(await decodeCenterColor(blob));
    // The specific quadrant isn't the point here (the two tests above already pin
    // down pan direction) -- this is checking that an absurdly oversized drag still
    // gets clamped to *some* real, fully-covering position instead of exposing blank
    // space at the image's edge.
    assert(["red", "green", "blue", "yellow"].includes(color), `an oversized drag still lands on a real quadrant, not blank space (got ${color})`);
  }

  unlinkSync(BUNDLE_PATH);
  console.log("\nALL AVATAR CROP CHECKS PASSED");
}

main().catch((err) => {
  try { unlinkSync(BUNDLE_PATH); } catch {}
  console.error("FAILED:", err);
  process.exit(1);
});
