import type { McpTestResult } from "@zli-v2/contracts";
import { useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { toolCountText } from "./mcpServers.js";

/**
 * The tools a test listed. For the person's own servers each tool has a switch; plugin servers
 * pass no `onChange` and the list is read-only.
 */
export function McpToolsPanel({
  test,
  disabledTools = [],
  saving = false,
  onChange,
  onClose,
}: {
  test: McpTestResult;
  disabledTools?: readonly string[];
  saving?: boolean;
  onChange?(disabledTools: string[]): Promise<boolean>;
  onClose(): void;
}) {
  const [changed, setChanged] = useState(false);
  const editable = onChange !== undefined;
  const off = new Set(disabledTools);
  const onCount = test.tools.filter((tool) => !off.has(tool.name)).length;
  const save = async (next: string[]) => {
    if (onChange && (await onChange(next))) setChanged(true);
  };

  return (
    <section className="mcp-tools" aria-label={`Tools in ${test.name}`}>
      <div className="mcp-tools-head">
        <span className="mcp-tools-count">
          {test.tools.length === 0
            ? test.ok
              ? "No tools"
              : "Test failed"
            : editable
              ? `${onCount} of ${toolCountText(test.tools.length)} on`
              : toolCountText(test.tools.length)}
        </span>
        {editable && onCount < test.tools.length ? (
          <Button size="xs" variant="ghost" disabled={saving} onClick={() => void save([])}>
            Turn all on
          </Button>
        ) : null}
        <span className="connector-spacer" />
        <IconButton label={`Hide tools in ${test.name}`} icon="x" size="xs" iconSize={12} onClick={onClose} />
      </div>
      {!test.ok ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {test.problem ?? "The server did not answer."}
        </p>
      ) : null}
      {test.ok && test.tools.length === 0 ? <p className="settings-empty">This server offers no tools.</p> : null}
      {test.tools.length > 0 ? (
        <ul className="mcp-tools-list">
          {test.tools.map((tool) => (
            <li className={`mcp-tool${off.has(tool.name) ? " is-off" : ""}`} key={tool.name}>
              <span className="mcp-tool-copy">
                <span className="mcp-tool-name">{tool.name}</span>
                {tool.description ? (
                  <span className="mcp-tool-desc" title={tool.description}>
                    {tool.description}
                  </span>
                ) : null}
              </span>
              {editable ? (
                <input
                  className="switch"
                  type="checkbox"
                  role="switch"
                  checked={!off.has(tool.name)}
                  aria-checked={!off.has(tool.name)}
                  aria-label={`Let agents use ${tool.name}`}
                  disabled={saving}
                  onChange={(event) =>
                    void save(
                      event.target.checked
                        ? disabledTools.filter((name) => name !== tool.name)
                        : [...disabledTools, tool.name],
                    )
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!editable ? (
        <p className="settings-footnote">Plugin servers use every tool.</p>
      ) : changed ? (
        <p className="settings-footnote">Changes apply to agents started after you save.</p>
      ) : null}
    </section>
  );
}
