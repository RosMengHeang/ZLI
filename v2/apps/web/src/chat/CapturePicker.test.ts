import { describe, expect, it } from "vitest";

import { captureFile } from "./CapturePicker.js";

describe("captureFile", () => {
  it("names the picture after the window and keeps its bytes", async () => {
    const file = captureFile("Visual Studio Code \u2014 main.ts", btoa("png-bytes"));
    expect(file.name).toBe("visual-studio-code-main-ts.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("png-bytes");
    expect(captureFile("***", btoa("x")).name).toBe("window.png");
  });
});
