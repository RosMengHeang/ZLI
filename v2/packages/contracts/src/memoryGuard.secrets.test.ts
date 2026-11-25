import { describe, expect, it } from "vitest";
import { screenNote } from "./memoryGuard.js";

describe("screenNote with real secret formats", () => {
  it("refuses keys and passwords a person might paste into chat", () => {
    for (const secret of [
      "My Anthropic key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
      "OpenAI key sk-proj-abcdEFGH1234ijklMNOP5678",
      "token github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "Google key AIzaSyA1234567890abcdefghijklmnopqrstu",
      "My password is hunter2",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ])
      expect(screenNote(secret).ok, secret).toBe(false);
  });

  it("keeps facts that only mention where a password lives", () => {
    for (const fact of [
      "Their name is Heang and they like tea",
      "The password is stored in 1Password",
      "The staging password is kept in the team vault",
    ])
      expect(screenNote(fact).ok, fact).toBe(true);
  });
});
