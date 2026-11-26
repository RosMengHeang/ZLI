import { toBase64Url } from "@zli-v2/remote-protocol";
import { describe, expect, it } from "vitest";

import { clientKey, isWebSocketUpgrade, parseRoute, rateLimitKey, withinRateLimit } from "./routes.js";

const room = toBase64Url(new Uint8Array(16).fill(1));
const session = toBase64Url(new Uint8Array(16).fill(2));

describe("parseRoute", () => {
  it("parses the three socket paths", () => {
    expect(parseRoute(`/v1/phone/${room}`)).toEqual({ role: "phone", room });
    expect(parseRoute(`/v1/host/${room}`)).toEqual({ role: "control", room });
    expect(parseRoute(`/v1/host/${room}/${session}`)).toEqual({ role: "host", room, session });
  });

  it.each([
    ["a trailing slash", `/v1/phone/${room}/`],
    ["a trailing slash on a session", `/v1/host/${room}/${session}/`],
    ["extra segments", `/v1/host/${room}/${session}/more`],
    ["another prefix", `/v2/phone/${room}`],
    ["no prefix", `/phone/${room}`],
    ["an invalid room", "/v1/phone/not-an-id"],
    ["an invalid session", `/v1/host/${room}/../x`],
    ["a phone path with a session", `/v1/phone/${room}/${session}`],
    ["an unknown role", `/v1/admin/${room}`],
    ["the root", "/"],
  ])("refuses %s", (_label, path) => {
    expect(parseRoute(path)).toBeNull();
  });
});

describe("isWebSocketUpgrade", () => {
  it("accepts a GET upgrade in any letter case", () => {
    const request = new Request("http://relay/", { headers: { Upgrade: "WebSocket" } });
    expect(isWebSocketUpgrade(request)).toBe(true);
  });

  it("refuses other methods and plain requests", () => {
    expect(isWebSocketUpgrade(new Request("http://relay/"))).toBe(false);
    const post = new Request("http://relay/", { method: "POST", headers: { Upgrade: "websocket" } });
    expect(isWebSocketUpgrade(post)).toBe(false);
  });
});

describe("clientKey", () => {
  it("is a short hex hash, the same for the same address and different across addresses", async () => {
    const request = (ip: string) => new Request("http://relay/", { headers: { "CF-Connecting-IP": ip } });
    const first = await clientKey(request("203.0.113.7"));
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(await clientKey(request("203.0.113.7"))).toBe(first);
    expect(await clientKey(request("203.0.113.8"))).not.toBe(first);
    expect(first).not.toContain("203");
  });
});

describe("withinRateLimit", () => {
  const request = (ip?: string) =>
    new Request("http://relay/", ip ? { headers: { "CF-Connecting-IP": ip } } : undefined);

  it("allows everything when the binding is absent, as in local runs", async () => {
    expect(await withinRateLimit(undefined, request("203.0.113.7"))).toBe(true);
  });

  it("asks the limiter with the connecting address as the key", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: keys.length < 2 };
      },
    };
    expect(await withinRateLimit(limiter, request("203.0.113.7"))).toBe(true);
    expect(await withinRateLimit(limiter, request())).toBe(false);
    expect(keys).toEqual(["203.0.113.7", "unknown"]);
  });
});

describe("rateLimitKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 by its /64, so one host cannot rotate through its own block", () => {
    const key = rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:0DB8:0001:0002:1::1")).toBe(key);
    expect(rateLimitKey("2001:db8:1:2::")).toBe(key);
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(key);
  });

  it("keys an IPv4-mapped IPv6 address by its IPv4 part", () => {
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("passes through anything it cannot parse", () => {
    expect(rateLimitKey("unknown")).toBe("unknown");
    expect(rateLimitKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });
});
