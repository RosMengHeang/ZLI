import type {
  IssueDetail,
  IssueSource,
  IssueSummary,
  LinearStatusResult,
  ProjectProjection,
  RuntimeProjection,
} from "@zli-v2/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Markdown } from "../chat/Markdown.js";
import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { ISSUE_SOURCE_NAMES, updatedLabel } from "./issueStart.js";
import { getIssue, linearStatus, listIssues } from "./issuesClient.js";
import "./issues.css";

const SEARCH_DELAY_MS = 300;

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

export function IssuesDialog({
  projection,
  initialProject,
  onClose,
  onStart,
  onConnectLinear,
}: {
  projection: RuntimeProjection;
  initialProject: ProjectProjection | undefined;
  onClose(): void;
  onStart(project: ProjectProjection, issue: IssueDetail): void;
  onConnectLinear(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const ids = useId();
  const [projectId, setProjectId] = useState(initialProject?.projectId ?? projection.projects[0]?.projectId);
  const project = projection.projects.find((candidate) => candidate.projectId === projectId);
  const [source, setSource] = useState<IssueSource>("github");
  const [linear, setLinear] = useState<LinearStatusResult>();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [mine, setMine] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<Loaded<IssueSummary[]>>({ status: "loading" });
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Loaded<IssueDetail>>();
  const [openError, setOpenError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    linearStatus(dispatch)
      .then((status) => {
        if (!cancelled) setLinear(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setList({ status: "loading" });
    listIssues(dispatch, projectId, source, {
      ...(search ? { query: search } : {}),
      state: openOnly ? "open" : "all",
      ...(mine ? { assignee: "me" as const } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        setList({ status: "ready", value: result.issues });
        setSelected((current) =>
          current && result.issues.some((issue) => issue.key === current) ? current : result.issues[0]?.key,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setList({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, projectId, source, search, openOnly, mine, attempt]);

  useEffect(() => {
    if (!projectId || !selected) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    getIssue(dispatch, projectId, source, selected)
      .then((result) => {
        if (!cancelled) setDetail({ status: "ready", value: result.issue });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetail({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, projectId, source, selected]);

  const chooseSource = (next: IssueSource) => {
    setSource(next);
    setSelected(undefined);
  };

  const issues = list.status === "ready" ? list.value : [];
  const ready = detail?.status === "ready" ? detail.value : undefined;
  const linearConnected = linear?.connected === true && !linear.problem;
  const sourceName = ISSUE_SOURCE_NAMES[source];

  return (
    <Dialog
      label="Issues"
      title="Start from an issue"
      subtitle={projection.projects.length > 1 ? undefined : project?.name}
      size="lg"
      className="issues-dialog"
      scrimLabel="Close issues"
      initialFocusRef={searchRef}
      onClose={onClose}
    >
      <div className="issues-toolbar">
        {projection.projects.length > 1 ? (
          <Select<string>
            id={`${ids}-project`}
            label="Project"
            className="issues-project"
            value={projectId ?? ""}
            options={projection.projects.map((candidate) => ({
              value: candidate.projectId,
              label: candidate.name,
              icon: <Icon name="folder" size={15} />,
            }))}
            onChange={(next) => {
              setProjectId(next as typeof projectId);
              setSelected(undefined);
            }}
          />
        ) : null}
        {linearConnected ? (
          <Segmented<IssueSource>
            label="Source"
            value={source}
            options={[
              { value: "github", label: "GitHub" },
              { value: "linear", label: "Linear" },
            ]}
            onChange={chooseSource}
          />
        ) : null}
        <div className="issues-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            aria-label="Search issues"
            placeholder={source === "github" ? "Search, or #123" : "Search, or ENG-123"}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <fieldset className="issues-filters" aria-label="Filters">
          <Button size="sm" variant="ghost" aria-pressed={openOnly} onClick={() => setOpenOnly((value) => !value)}>
            Open
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={mine} onClick={() => setMine((value) => !value)}>
            Assigned to me
          </Button>
        </fieldset>
      </div>
      <div className="issues-layout">
        <div className="issues-list-region">
          {list.status === "loading" ? (
            <p className="loading-line issues-state" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading {sourceName} issues
            </p>
          ) : list.status === "error" ? (
            <div className="issues-state">
              <p className="inline-error" role="alert">
                <Icon name="alert" size={13} />
                <span>{list.message}</span>
              </p>
              <Button size="sm" icon="reload" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </Button>
            </div>
          ) : issues.length === 0 ? (
            <p className="issues-state issues-empty">
              {search
                ? `No ${openOnly ? "open " : ""}issues match "${search}".`
                : `No ${openOnly ? "open " : ""}issues.`}
            </p>
          ) : (
            <ul className="issues-list" aria-label={`${sourceName} issues`}>
              {issues.map((issue) => (
                <li key={issue.key}>
                  <button
                    type="button"
                    className={`issue-row${issue.key === selected ? " is-selected" : ""}`}
                    aria-current={issue.key === selected ? "true" : undefined}
                    onClick={() => setSelected(issue.key)}
                  >
                    <span className="issue-row-top">
                      <span className="issue-ref">{issue.reference}</span>
                      <span className="issue-title">{issue.title}</span>
                      <span className="issue-updated" title={issue.updatedAt}>
                        {updatedLabel(issue.updatedAt)}
                      </span>
                    </span>
                    {issue.labels.length > 0 || issue.state === "closed" ? (
                      <span className="issue-labels">
                        {issue.state === "closed" ? <span className="issue-label is-closed">Closed</span> : null}
                        {issue.labels.slice(0, 4).map((label) => (
                          <span key={label.name} className="issue-label">
                            {label.name}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <section className="issue-detail" aria-label="Issue details">
          {!detail ? (
            <p className="issues-state issues-empty">Select an issue to see it here.</p>
          ) : detail.status === "loading" ? (
            <p className="loading-line issues-state" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading the issue
            </p>
          ) : detail.status === "error" ? (
            <p className="inline-error issues-state" role="alert">
              <Icon name="alert" size={13} />
              <span>{detail.message}</span>
            </p>
          ) : (
            <IssueDetailView
              issue={detail.value}
              onOpen={() => void openExternalLink(bridge, detail.value.url).then(setOpenError)}
            />
          )}
          {openError ? (
            <p className="field-hint is-warning" role="alert">
              {openError}
            </p>
          ) : null}
        </section>
      </div>
      <div className="dialog-footer">
        <span className="dialog-footer-note">
          {linearConnected ? (
            `Linear: ${linear?.viewer?.name ?? "connected"}`
          ) : linear?.problem && linear.connected ? (
            linear.problem
          ) : (
            <button className="form-link" type="button" onClick={onConnectLinear}>
              Connect Linear
            </button>
          )}
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="play"
          disabled={!ready || !project}
          onClick={() => {
            if (ready && project) onStart(project, ready);
          }}
        >
          Start agent
        </Button>
      </div>
    </Dialog>
  );
}

function IssueDetailView({ issue, onOpen }: { issue: IssueDetail; onOpen(): void }) {
  const comments = issue.comments.slice(-10);
  return (
    <article className="issue-detail-body">
      <header className="issue-detail-header">
        <h3 className="issue-detail-title">
          <span className="issue-ref">{issue.reference}</span> {issue.title}
        </h3>
        <p className="issue-detail-meta">
          <span>{issue.stateName ?? (issue.state === "open" ? "Open" : "Closed")}</span>
          {issue.author ? <span>by {issue.author}</span> : null}
          {issue.assignees.length > 0 ? <span>assigned to {issue.assignees.join(", ")}</span> : null}
          <button className="form-link" type="button" onClick={onOpen}>
            Open in {ISSUE_SOURCE_NAMES[issue.source]}
          </button>
        </p>
        {issue.labels.length > 0 ? (
          <span className="issue-labels">
            {issue.labels.map((label) => (
              <span key={label.name} className="issue-label">
                {label.name}
              </span>
            ))}
          </span>
        ) : null}
      </header>
      {issue.body.trim() ? <Markdown text={issue.body} /> : <p className="issues-empty">No description.</p>}
      {comments.length > 0 ? (
        <section className="issue-comments" aria-label="Comments">
          <p className="issue-comments-title">
            {issue.comments.length > comments.length
              ? `Latest ${comments.length} of ${issue.comments.length} comments`
              : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
          </p>
          {comments.map((comment, index) => (
            <div key={`${comment.createdAt ?? ""}-${index.toString()}`} className="issue-comment">
              <p className="issue-comment-head">
                {comment.author ?? "Someone"}
                {comment.createdAt ? <span> {comment.createdAt.slice(0, 10)}</span> : null}
              </p>
              <Markdown text={comment.body} />
            </div>
          ))}
        </section>
      ) : null}
    </article>
  );
}
