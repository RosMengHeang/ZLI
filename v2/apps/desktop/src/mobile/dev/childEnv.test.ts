import { describe, expect, it } from "vitest";

import { mobileChildEnv } from "./childEnv.js";

describe("mobile child environment", () => {
  it("drops ZLI's private variables, in any case, and keeps the rest", () => {
    const env = {
      PATH: "/usr/bin",
      ANDROID_HOME: "/sdk",
      ZLI_RUNTIME_TOKEN: "secret",
      ZLI_DAEMON_TOKEN: "secret",
      ZLI_DAEMON_ENDPOINT_PATH: "/tmp/daemon.json",
      ZLI_BROWSER_CONTROL_FILE: "/tmp/control.json",
      zli_runtime_token: "secret",
    };
    expect(mobileChildEnv(env)).toEqual({ PATH: "/usr/bin", ANDROID_HOME: "/sdk" });
    expect(env.ZLI_RUNTIME_TOKEN).toBe("secret");
  });
});
