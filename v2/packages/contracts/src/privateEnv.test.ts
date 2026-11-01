import { describe, expect, it } from "vitest";

import { withoutPrivateEnv, ZLI_AGENT_CONTROL_ENV } from "./privateEnv.js";

describe("withoutPrivateEnv", () => {
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
    expect(withoutPrivateEnv(env)).toEqual({ PATH: "/usr/bin", ANDROID_HOME: "/sdk" });
    expect(env.ZLI_RUNTIME_TOKEN).toBe("secret");
  });

  it("keeps a private variable named in keep, in any case", () => {
    const env = { ZLI_RUNTIME_TOKEN: "secret", zli_browser_control_file: "/tmp/control.json" };
    expect(withoutPrivateEnv(env, { keep: [ZLI_AGENT_CONTROL_ENV] })).toEqual({
      zli_browser_control_file: "/tmp/control.json",
    });
  });
});
