import { describe, expect, it } from "vitest";

import { takeLaunchOptions } from "./main.js";

describe("takeLaunchOptions", () => {
  it("passes the runtime token to the server and deletes it from the environment children inherit", () => {
    const env: NodeJS.ProcessEnv = {
      ZLI_DATABASE_PATH: "/tmp/zli/runtime.sqlite",
      ZLI_RUNTIME_TOKEN: "runtime-token",
      ZLI_BROWSER_USER_SETTINGS: "0",
    };

    expect(takeLaunchOptions(env)).toEqual({
      databasePath: "/tmp/zli/runtime.sqlite",
      token: "runtime-token",
      cleanUpUserSettings: false,
    });
    expect(env).not.toHaveProperty("ZLI_RUNTIME_TOKEN");
    expect(env.ZLI_DATABASE_PATH).toBe("/tmp/zli/runtime.sqlite");
  });

  it("removes the token from process.env itself", () => {
    const previous = process.env.ZLI_RUNTIME_TOKEN;
    process.env.ZLI_RUNTIME_TOKEN = "process-token";
    try {
      expect(takeLaunchOptions(process.env).token).toBe("process-token");
      expect(process.env).not.toHaveProperty("ZLI_RUNTIME_TOKEN");
    } finally {
      if (previous === undefined) delete process.env.ZLI_RUNTIME_TOKEN;
      else process.env.ZLI_RUNTIME_TOKEN = previous;
    }
  });

  it("leaves the token out when the server was started without one", () => {
    expect(takeLaunchOptions({})).not.toHaveProperty("token");
  });
});
