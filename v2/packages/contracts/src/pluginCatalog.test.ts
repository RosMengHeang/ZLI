import { describe, expect, it } from "vitest";

import { PLUGIN_CATALOG, PLUGIN_CATALOG_CATEGORIES } from "./pluginCatalog.js";
import { skillNameProblem } from "./skills.js";

describe("plugin catalog", () => {
  it("has unique, valid ids and plain one-sentence descriptions", () => {
    const ids = PLUGIN_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PLUGIN_CATALOG.length).toBeGreaterThanOrEqual(12);
    expect(PLUGIN_CATALOG.length).toBeLessThanOrEqual(20);
    const categories = new Set(PLUGIN_CATALOG_CATEGORIES.map((category) => category.id));
    for (const entry of PLUGIN_CATALOG) {
      expect(skillNameProblem(entry.id), entry.id).toBeUndefined();
      expect(categories.has(entry.category), entry.id).toBe(true);
      expect(entry.description, entry.id).toMatch(/^[A-Z].*\.$/u);
      expect(entry.description, entry.id).not.toMatch(/[.!?]\s/u);
      expect(`${entry.title} ${entry.description}`, entry.id).not.toMatch(/[\u2013\u2014]/u);
      expect(entry.homepage, entry.id).toMatch(/^https:\/\//u);
    }
  });

  it("points every entry at a pinned GitHub folder", () => {
    for (const entry of PLUGIN_CATALOG) {
      expect(entry.source, entry.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[\w.-]+(\/[\w.-]+)*$/u);
    }
  });
});
