// Lets the user pan/zoom a chosen image within a circular viewport before it's
// uploaded as an avatar, matching exactly how it's displayed everywhere else
// (both the settings preview and the widget's own chat bubbles render avatars as a
// circle via CSS -- see .avatar-preview/.sender-avatar). Exports a fixed-size square
// PNG of just the visible circle's bounding box; existing border-radius: 50% CSS
// clips it the rest of the way, exactly matching the crop preview shown here.
const VIEWPORT_SIZE = 280; // on-screen canvas size, in CSS pixels (matches the <canvas> width/height attrs)
const OUTPUT_SIZE = 480; // exported square -- comfortably larger than any on-screen use, downscaled by CSS
const MIN_ZOOM = 1; // 1x = "cover" fit: the smallest zoom that still fills the circle with no empty edges
const MAX_ZOOM = 4;

export function openAvatarCropDialog(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const dialog = document.querySelector<HTMLDialogElement>("#avatar-crop-dialog")!;
    const canvas = document.querySelector<HTMLCanvasElement>("#avatar-crop-canvas")!;
    const zoomInput = document.querySelector<HTMLInputElement>("#avatar-crop-zoom")!;
    const saveButton = document.querySelector<HTMLButtonElement>("#avatar-crop-save")!;
    const cancelButton = document.querySelector<HTMLButtonElement>("#avatar-crop-cancel")!;
    const ctx = canvas.getContext("2d")!;

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    let baseScale = 1; // image-pixels -> viewport-pixels at zoom 1 (the "cover" scale)
    let zoom = 1;
    // Pan offset in viewport pixels: how far the image is shifted from centered.
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartOffsetX = 0;
    let dragStartOffsetY = 0;
    let settled = false;

    function clampOffset() {
      const scale = baseScale * zoom;
      const scaledW = img.naturalWidth * scale;
      const scaledH = img.naturalHeight * scale;
      // The image must always fully cover the circle -- offset can't reveal empty
      // space at any edge, so it's bounded by how much bigger than the viewport the
      // scaled image currently is (zero once a dimension no longer exceeds it).
      const maxOffsetX = Math.max(0, (scaledW - VIEWPORT_SIZE) / 2);
      const maxOffsetY = Math.max(0, (scaledH - VIEWPORT_SIZE) / 2);
      offsetX = Math.min(maxOffsetX, Math.max(-maxOffsetX, offsetX));
      offsetY = Math.min(maxOffsetY, Math.max(-maxOffsetY, offsetY));
    }

    function draw() {
      const scale = baseScale * zoom;
      const scaledW = img.naturalWidth * scale;
      const scaledH = img.naturalHeight * scale;
      ctx.clearRect(0, 0, VIEWPORT_SIZE, VIEWPORT_SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(VIEWPORT_SIZE / 2, VIEWPORT_SIZE / 2, VIEWPORT_SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, VIEWPORT_SIZE / 2 - scaledW / 2 - offsetX, VIEWPORT_SIZE / 2 - scaledH / 2 - offsetY, scaledW, scaledH);
      ctx.restore();
    }

    function pointFromEvent(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      // getBoundingClientRect gives CSS pixels, which is exactly VIEWPORT_SIZE since
      // the canvas isn't styled to a different display size -- no ratio conversion needed.
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function onPointerDown(event: PointerEvent) {
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      const p = pointFromEvent(event);
      dragStartX = p.x;
      dragStartY = p.y;
      dragStartOffsetX = offsetX;
      dragStartOffsetY = offsetY;
    }
    function onPointerMove(event: PointerEvent) {
      if (!dragging) return;
      const p = pointFromEvent(event);
      offsetX = dragStartOffsetX - (p.x - dragStartX);
      offsetY = dragStartOffsetY - (p.y - dragStartY);
      clampOffset();
      draw();
    }
    function onPointerUp(event: PointerEvent) {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    }

    function onZoomInput() {
      zoom = Number(zoomInput.value);
      clampOffset();
      draw();
    }

    function cleanup() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      zoomInput.removeEventListener("input", onZoomInput);
      saveButton.removeEventListener("click", onSave);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      URL.revokeObjectURL(objectUrl);
      if (dialog.open) dialog.close();
    }

    function settle(result: Blob | null) {
      if (settled) return; // dialog's own "cancel" event can otherwise double-fire alongside onCancel
      settled = true;
      cleanup();
      resolve(result);
    }

    function onSave() {
      const outputRatio = OUTPUT_SIZE / VIEWPORT_SIZE;
      const scale = baseScale * zoom * outputRatio;
      const scaledW = img.naturalWidth * scale;
      const scaledH = img.naturalHeight * scale;
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = OUTPUT_SIZE;
      outputCanvas.height = OUTPUT_SIZE;
      const outCtx = outputCanvas.getContext("2d")!;
      // Clipped to a circle in the exported file itself, not just in this preview --
      // the saved avatar_url is what it looks like, rather than relying on every
      // future place it's displayed to separately apply border-radius: 50%.
      outCtx.beginPath();
      outCtx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
      outCtx.clip();
      outCtx.drawImage(
        img,
        OUTPUT_SIZE / 2 - scaledW / 2 - offsetX * outputRatio,
        OUTPUT_SIZE / 2 - scaledH / 2 - offsetY * outputRatio,
        scaledW,
        scaledH,
      );
      outputCanvas.toBlob((blob) => settle(blob), "image/png");
    }

    function onCancel() {
      settle(null);
    }

    img.onload = () => {
      baseScale = Math.max(VIEWPORT_SIZE / img.naturalWidth, VIEWPORT_SIZE / img.naturalHeight);
      zoom = 1;
      offsetX = 0;
      offsetY = 0;
      zoomInput.min = String(MIN_ZOOM);
      zoomInput.max = String(MAX_ZOOM);
      zoomInput.value = String(MIN_ZOOM);
      draw();

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      zoomInput.addEventListener("input", onZoomInput);
      saveButton.addEventListener("click", onSave);
      cancelButton.addEventListener("click", onCancel);
      dialog.addEventListener("cancel", onCancel); // Esc key
      dialog.showModal();
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}
