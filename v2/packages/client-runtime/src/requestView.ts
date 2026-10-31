/** Turns a provider's raw approval or input request into what the person needs to decide. */

export type RequestField = { label: string; value: string; mono?: boolean };

export type RequestChoice = {
  key: string;
  label: string;
  decision: unknown;
  tone: "primary" | "secondary" | "danger";
};

export type ApprovalView = { title: string; fields: RequestField[]; choices: RequestChoice[] };

export type InputQuestion = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string | undefined }[];
  /** A free-text answer is allowed next to, or instead of, the options. */
  allowOther: boolean;
  secret: boolean;
};

const FIELD_LIMIT = 600;

const CODEX_DECISIONS: Record<string, { label: string; tone: RequestChoice["tone"] }> = {
  accept: { label: "Approve", tone: "primary" },
  acceptForSession: { label: "Approve for this chat", tone: "secondary" },
  decline: { label: "Decline", tone: "secondary" },
  cancel: { label: "Decline and stop", tone: "danger" },
};

export function describeApproval(provider: string, payload: Record<string, unknown>): ApprovalView {
  if (provider === "codex") return codexApproval(payload);
  if (Array.isArray(payload.options)) return acpApproval(payload);
  if (typeof payload.toolName === "string") return toolApproval(payload.toolName, record(payload.input) ?? {});
  const command = text(payload.command);
  return {
    title: text(payload.title) ?? (command ? "Run a command" : "Approve this action"),
    fields: command ? [{ label: "Command", value: clip(command), mono: true }] : [],
    choices: approveReject(),
  };
}

function codexApproval(payload: Record<string, unknown>): ApprovalView {
  const command = commandText(payload.command);
  const server = text(payload.serverName);
  const fields: RequestField[] = [];
  if (server) fields.push({ label: "Server", value: server, mono: true });
  const message = text(payload.message);
  if (message) fields.push({ label: "Request", value: clip(message) });
  if (command) fields.push({ label: "Command", value: clip(command), mono: true });
  const cwd = text(payload.cwd);
  if (cwd) fields.push({ label: "In", value: cwd, mono: true });
  const root = text(payload.grantRoot);
  if (root) fields.push({ label: "Write access to", value: root, mono: true });
  const reason = text(payload.reason);
  if (reason) fields.push({ label: "Reason", value: clip(reason) });
  const offered = Array.isArray(payload.availableDecisions)
    ? payload.availableDecisions.filter(
        (value): value is string => typeof value === "string" && value in CODEX_DECISIONS,
      )
    : ["accept", "acceptForSession", "decline"];
  const choices = (offered.length > 0 ? offered : ["accept", "decline"]).map((decision) => {
    const known = CODEX_DECISIONS[decision] ?? { label: decision, tone: "secondary" as const };
    return { key: decision, label: known.label, tone: known.tone, decision: { decision } };
  });
  return { title: codexTitle(payload, command, server), fields, choices };
}

function codexTitle(payload: Record<string, unknown>, command: string | undefined, server: string | undefined): string {
  if (server)
    return record(payload._meta)?.codex_approval_kind === "mcp_tool_call" ? "Use an MCP tool" : "Answer an MCP server";
  if (record(payload.permissions)) return "Allow more access";
  return command ? "Run a command" : "Change files";
}

function acpApproval(payload: Record<string, unknown>): ApprovalView {
  const title = text(payload.toolName) ?? "Use a tool";
  const fields = inputFields(record(payload.input) ?? {});
  const options = (payload.options as unknown[]).map(record).filter((option) => text(option?.optionId));
  const choices: RequestChoice[] = options.map((option) => {
    const optionId = text(option?.optionId) ?? "";
    const kind = text(option?.kind) ?? "";
    const allow = kind.startsWith("allow");
    return {
      key: optionId,
      label: text(option?.name) ?? ACP_KIND_LABELS[kind] ?? optionId,
      tone: kind === "allow_once" ? "primary" : "secondary",
      decision: { optionId, approved: allow },
    };
  });
  return { title, fields, choices: choices.length > 0 ? choices : approveReject() };
}

const ACP_KIND_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Reject",
  reject_always: "Always reject",
};

function toolApproval(toolName: string, input: Record<string, unknown>): ApprovalView {
  const fields = inputFields(input);
  const command = text(input.command);
  const file = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  const title = command ? "Run a command" : file && /write|edit/iu.test(toolName) ? "Change a file" : `Use ${toolName}`;
  return {
    title,
    fields,
    choices: [
      { key: "approve", label: "Approve", tone: "primary", decision: { approved: true } },
      {
        key: "session",
        label: `Allow ${toolName} for this chat`,
        tone: "secondary",
        decision: { approved: true, scope: "session" },
      },
      { key: "reject", label: "Reject", tone: "secondary", decision: { approved: false } },
    ],
  };
}

const INPUT_FIELDS: readonly { key: string; label: string; mono: boolean }[] = [
  { key: "command", label: "Command", mono: true },
  { key: "file_path", label: "File", mono: true },
  { key: "notebook_path", label: "Notebook", mono: true },
  { key: "path", label: "Path", mono: true },
  { key: "url", label: "URL", mono: true },
  { key: "pattern", label: "Pattern", mono: true },
  { key: "query", label: "Query", mono: false },
  { key: "description", label: "Description", mono: false },
  { key: "plan", label: "Plan", mono: false },
];

function inputFields(input: Record<string, unknown>): RequestField[] {
  const fields: RequestField[] = [];
  for (const { key, label, mono } of INPUT_FIELDS) {
    const value = key === "command" ? commandText(input[key]) : text(input[key]);
    if (value) fields.push({ label, value: clip(value), mono });
  }
  const oldText = text(input.old_string);
  const newText = typeof input.new_string === "string" ? input.new_string : undefined;
  if (oldText !== undefined && newText !== undefined) {
    fields.push({ label: "Replace", value: clip(oldText), mono: true });
    fields.push({ label: "With", value: clip(newText) || "(nothing)", mono: true });
  } else if (typeof input.content === "string") {
    fields.push({ label: "Content", value: clip(input.content) || "(empty file)", mono: true });
  }
  return fields;
}

function approveReject(): RequestChoice[] {
  return [
    { key: "approve", label: "Approve", tone: "primary", decision: { approved: true } },
    { key: "reject", label: "Reject", tone: "secondary", decision: { approved: false } },
  ];
}

/** Codex sends structured questions; other providers name the fields they want or send nothing usable. */
export function describeQuestions(payload: Record<string, unknown>): InputQuestion[] {
  if (Array.isArray(payload.questions)) {
    const questions = payload.questions
      .map(record)
      .filter((question): question is Record<string, unknown> => Boolean(text(question?.id)))
      .map((question) => {
        const options = (Array.isArray(question.options) ? question.options : [])
          .map(record)
          .filter((option): option is Record<string, unknown> => Boolean(text(option?.label)))
          .map((option) => ({
            label: text(option.label) ?? "",
            ...(text(option.description) ? { description: text(option.description) } : {}),
          }));
        const header = text(question.header);
        return {
          id: text(question.id) ?? "",
          ...(header ? { header } : {}),
          question: text(question.question) ?? header ?? "Answer",
          options,
          allowOther: options.length === 0 || question.isOther === true,
          secret: question.isSecret === true,
        };
      });
    if (questions.length > 0) return questions;
  }
  const fields = Array.isArray(payload.fields)
    ? payload.fields.filter((field): field is string => typeof field === "string" && field.length > 0)
    : [];
  const prompt = text(payload.title) ?? text(payload.prompt) ?? text(payload.question);
  if (fields.length > 0) {
    return fields.map((field) => ({
      id: field,
      question: fields.length === 1 && prompt ? prompt : field,
      options: [],
      allowOther: true,
      secret: false,
    }));
  }
  return [
    { id: "answer", question: prompt ?? "The agent needs an answer", options: [], allowOther: true, secret: false },
  ];
}

function commandText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.filter((part): part is string => typeof part === "string").join(" ");
    return joined.trim() ? joined : undefined;
  }
  return text(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function clip(value: string): string {
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT)}…` : value;
}
