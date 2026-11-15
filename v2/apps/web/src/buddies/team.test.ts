import { describe, expect, it } from "vitest";

import { guessProject } from "./team.js";

const projects = [
  { projectId: "p-shop", name: "shop-web", path: "D:/code/shop-web" },
  { projectId: "p-tax", name: "Taxzy CLI", path: "D:/Taxzy_CLI" },
];
const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("guessProject", () => {
  it("takes the project a message names, by its name or its folder", () => {
    expect(guessProject("fix the cart total in shop web", projects, [], "b1", "p-tax")).toEqual({
      projectId: "p-shop",
      why: "named",
    });
    expect(guessProject("taxzy_cli: the login is broken", projects, [], "b1", "p-shop")?.projectId).toBe("p-tax");
  });

  it("learns which words go with which project from past jobs", () => {
    const tasks = [
      { buddyId: "b2", projectId: "p-shop", goal: "Add a checkout coupon field", createdAt: at(1) },
      { buddyId: "b2", projectId: "p-tax", goal: "Speed up the receipt parser", createdAt: at(2) },
    ];
    expect(guessProject("The coupon is applied twice at checkout", projects, tasks, "b1", "p-tax")).toEqual({
      projectId: "p-shop",
      why: "learned",
    });
  });

  it("falls back to where this buddy worked last, then the project on screen", () => {
    const tasks = [{ buddyId: "b1", projectId: "p-tax", goal: "Something", createdAt: at(3) }];
    expect(guessProject("make it faster", projects, tasks, "b1", "p-shop")).toEqual({
      projectId: "p-tax",
      why: "habit",
    });
    expect(guessProject("make it faster", projects, [], "b1", "p-shop")).toEqual({ projectId: "p-shop", why: "focus" });
  });
});
