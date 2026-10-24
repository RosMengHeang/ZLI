import { describe, expect, it } from "vitest";

import { formatSkillMarkdown, parseSkillMarkdown, yamlScalar } from "./skillMarkdown.js";

describe("SKILL.md frontmatter", () => {
  it("reads plain, quoted, and block descriptions", () => {
    expect(parseSkillMarkdown("---\nname: pdf\ndescription: Fill PDF forms. # note\n---\n\n# PDF\n")).toMatchObject({
      hasFrontmatter: true,
      name: "pdf",
      description: "Fill PDF forms.",
      body: "# PDF\n",
    });
    expect(
      parseSkillMarkdown('\uFEFF---\r\nname: "a-b"\r\ndescription: "Say \\"hi\\": now"\r\n---\r\nBody').description,
    ).toBe('Say "hi": now');
    expect(parseSkillMarkdown("---\nname: x\ndescription: 'It''s here'\n---\n").description).toBe("It's here");
    expect(
      parseSkillMarkdown("---\nname: x\ndescription: >\n  One line\n  continues.\n\n  Second.\nlicense: MIT\n---\n")
        .description,
    ).toBe("One line continues.\nSecond.");
    expect(parseSkillMarkdown("---\nname: x\ndescription: |\n  Keep\n  lines\n---\n").description).toBe("Keep\nlines");
    expect(parseSkillMarkdown("---\nname: x\ndescription: Wraps\n  onto two lines\n---\n").description).toBe(
      "Wraps onto two lines",
    );
    expect(parseSkillMarkdown("# No frontmatter")).toMatchObject({ hasFrontmatter: false, name: undefined });
    expect(parseSkillMarkdown("---\nname: x\nno end")).toMatchObject({ hasFrontmatter: false });
  });

  it("writes name and description and keeps other keys as written", () => {
    const previous = parseSkillMarkdown(
      "---\nlicense: Apache-2.0\nname: old\ndescription: >\n  Old text\nmetadata:\n  author: me\n---\n\nOld body\n",
    );
    const text = formatSkillMarkdown(
      { name: "new-name", description: "Use it: when needed", instructions: "Do it.\r\n\n" },
      previous,
    );
    expect(text).toBe(
      '---\nlicense: Apache-2.0\nname: new-name\ndescription: "Use it: when needed"\nmetadata:\n  author: me\n---\n\nDo it.\n',
    );
    const parsed = parseSkillMarkdown(text);
    expect(parsed).toMatchObject({ name: "new-name", description: "Use it: when needed", body: "Do it.\n" });
    expect(formatSkillMarkdown({ name: "a", description: "b", instructions: "" })).toBe(
      "---\nname: a\ndescription: b\n---\n",
    );
  });

  it("quotes values YAML would read differently", () => {
    expect(yamlScalar("Plain words, fine.")).toBe("Plain words, fine.");
    for (const value of ["yes", "123", "- item", "a: b", "#tag", " padded", "two\nlines", "'quoted'", "x #y"]) {
      expect(yamlScalar(value)).toBe(JSON.stringify(value));
      expect(parseSkillMarkdown(`---\nname: x\ndescription: ${yamlScalar(value)}\n---\n`).description).toBe(value);
    }
  });
});
