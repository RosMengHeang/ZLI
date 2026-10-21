import { describe, expect, it } from "vitest";

import { DevServerLineScanner, detectDevServerUrls } from "./devServerDetector.js";

describe("detectDevServerUrls", () => {
  it.each([
    [
      "Vite with colors",
      "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m",
      "http://localhost:5173/",
    ],
    ["Next.js", "   - Local:        http://localhost:3000", "http://localhost:3000/"],
    ["older Next.js", "ready - started server on 0.0.0.0:3000, url: http://localhost:3000", "http://localhost:3000/"],
    ["Python http.server", "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...", "http://localhost:8000/"],
    ["Rails", "* Listening on http://127.0.0.1:3000", "http://127.0.0.1:3000/"],
    ["Django", "Starting development server at http://127.0.0.1:8000/", "http://127.0.0.1:8000/"],
    ["Flask", " * Running on http://127.0.0.1:5000", "http://127.0.0.1:5000/"],
    [
      "Angular",
      "** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **",
      "http://localhost:4200/",
    ],
    ["Astro base path", " ┃ Local    http://localhost:4321/docs/", "http://localhost:4321/docs/"],
    [
      "an OSC 8 link",
      "Server ready at \u001b]8;;http://localhost:8080/\u001b\\http://localhost:8080/\u001b]8;;\u001b\\.",
      "http://localhost:8080/",
    ],
  ])("finds the address in %s output", (_name, line, url) => {
    expect(detectDevServerUrls(line)).toEqual([url]);
  });

  it.each([
    ["a typed curl command", "$ curl http://localhost:3000/server"],
    ["a LAN address", "  ➜  Network: http://192.168.1.20:5173/"],
    ["a remote server", "Server running at https://example.com:443/"],
    ["an address without a port", "Server running at http://localhost/"],
    ["a line without an address", "Server ready in 412 ms"],
  ])("ignores %s", (_name, line) => {
    expect(detectDevServerUrls(line)).toEqual([]);
  });
});

describe("DevServerLineScanner", () => {
  it("waits for the end of a line split across chunks and tracks terminals separately", () => {
    const scanner = new DevServerLineScanner();
    expect(scanner.push("a", "  Local:   http://local")).toEqual([]);
    expect(scanner.push("b", "Listening on http://127.0.0.1:9000\r\n")).toEqual(["http://127.0.0.1:9000/"]);
    expect(scanner.push("a", "host:5173/\r\n  Network: use --host\r\n")).toEqual(["http://localhost:5173/"]);
  });

  it("drops an unfinished line that grows past the limit", () => {
    const scanner = new DevServerLineScanner();
    scanner.push("a", "Local: http://localhost:3000/");
    scanner.push("a", "x".repeat(5_000));
    expect(scanner.push("a", "\n")).toEqual([]);
  });
});
