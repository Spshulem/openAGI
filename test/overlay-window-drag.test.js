import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Mac Quick Ask exposes draggable pill and header surfaces", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const controller = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/OverlayController.swift"), "utf8");
  const overlay = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/OverlayView.swift"), "utf8");
  const dragHandle = fs.readFileSync(path.join(root, "mac/Sources/OpenAGI/Overlay/WindowDragHandle.swift"), "utf8");

  assert.match(overlay, /private var pill:[\s\S]{0,1200}WindowDragHandle\(onClick:/);
  assert.match(overlay, /Text\("Ask OpenAGI"\)[\s\S]{0,250}WindowDragHandle\(\)/);
  assert.match(dragHandle, /override var mouseDownCanMoveWindow: Bool \{ true \}/);
  assert.match(dragHandle, /func performClick\(\) \{ onClick\?\(\) \}/);
  assert.match(controller, /override func sendEvent[\s\S]{0,1300}nextEvent\(matching: \[\.leftMouseDragged, \.leftMouseUp\]\)/);
  assert.match(controller, /if didDrag \{ OverlayController\.shared\.persistPosition\(\) \}/);
  assert.match(controller, /private func dragTarget[\s\S]{0,500}view as\? DragHandleView/);
  assert.match(controller, /p\.isMovable = true[\s\S]{0,100}p\.isMovableByWindowBackground = true/);
  assert.match(controller, /host\.sizingOptions = \[\]/);
  assert.doesNotMatch(controller, /p\.animator\(\)\.setFrame/);
});
