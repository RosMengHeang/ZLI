import { describe, expect, it } from "vitest";

import { createToolFilter, HIDDEN_TOOL_CODE, parseHiddenTools } from "./toolFilter.js";

const tools = [{ name: "search" }, { name: "delete_repo" }, { name: "read" }];

describe("createToolFilter", () => {
  it("removes hidden tools from the results of tools/list requests only", () => {
    const filter = createToolFilter("github", ["delete_repo"]);
    expect(filter.fromClient({ jsonrpc: "2.0", id: 4, method: "tools/list" })).toEqual({
      forward: { jsonrpc: "2.0", id: 4, method: "tools/list" },
      reply: undefined,
    });
    expect(filter.fromServer({ jsonrpc: "2.0", id: 5, result: { tools } })).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { tools },
    });
    expect(filter.fromServer({ jsonrpc: "2.0", id: 4, result: { tools, nextCursor: "c" } })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { tools: [{ name: "search" }, { name: "read" }], nextCursor: "c" },
    });
    // The id is done once answered, so a later reply with the same id passes untouched.
    expect(filter.fromServer({ jsonrpc: "2.0", id: 4, result: { tools } })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { tools },
    });
  });

  it("keeps string and number ids apart", () => {
    const filter = createToolFilter("github", ["read"]);
    filter.fromClient({ jsonrpc: "2.0", id: "1", method: "tools/list" });
    expect(filter.fromServer({ jsonrpc: "2.0", id: 1, result: { tools } })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools },
    });
    expect(filter.fromServer({ jsonrpc: "2.0", id: "1", result: { tools } })).toMatchObject({
      result: { tools: [{ name: "search" }, { name: "delete_repo" }] },
    });
  });

  it("answers calls to hidden tools without forwarding them", () => {
    const filter = createToolFilter("github", ["delete_repo"]);
    const call = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_repo", arguments: {} } };
    expect(filter.fromClient(call)).toEqual({
      forward: undefined,
      reply: {
        jsonrpc: "2.0",
        id: 9,
        error: { code: HIDDEN_TOOL_CODE, message: "delete_repo is turned off for github in ZLI." },
      },
    });
    const allowed = { ...call, params: { name: "search" } };
    expect(filter.fromClient(allowed)).toEqual({ forward: allowed, reply: undefined });
  });

  it("splits batches into what to forward and what to answer", () => {
    const filter = createToolFilter("github", ["delete_repo"]);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const hidden = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_repo" } };
    const result = filter.fromClient([list, hidden]);
    expect(result.forward).toEqual([list]);
    expect(result.reply).toEqual([expect.objectContaining({ id: 2 })]);
    expect(filter.fromClient([hidden]).forward).toBeUndefined();
    expect(filter.fromServer([{ jsonrpc: "2.0", id: 1, result: { tools } }])).toEqual([
      { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "search" }, { name: "read" }] } },
    ]);
  });

  it("passes everything through when nothing is hidden", () => {
    const filter = createToolFilter("github", []);
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_repo" } };
    expect(filter.fromClient(call)).toEqual({ forward: call, reply: undefined });
  });
});

describe("parseHiddenTools", () => {
  it("reads a JSON array of names", () => {
    expect(parseHiddenTools('["a", 3, "", "b"]')).toEqual(["a", "b"]);
    expect(() => parseHiddenTools('{"a":1}')).toThrow("not a JSON array");
  });
});
