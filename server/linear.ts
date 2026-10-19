import { berlinDayRangeUnix } from "../shared/days.ts";
import {
  buildWindows,
  collectSessions,
  commentMinutes,
  type IssueActivity,
  type WorkflowState,
} from "../shared/import.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;
/** How many recently touched issues the day import looks at. */
const ISSUE_LIMIT = 50;
const COMMENT_LIMIT = 100;
/** State changes read per issue. Truncation is flagged, never swallowed. */
const HISTORY_LIMIT = 250;

export class LinearError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "LinearError";
    this.status = status;
  }
}

export type { WorkflowState };

export type LinearClient = {
  workflowStates(): Promise<WorkflowState[]>;
  /** The issues the viewer touched that day, with their own notes. */
  dayActivity(ymd: string): Promise<{ activities: IssueActivity[]; issuesChecked: number; capped: boolean }>;
};

const VIEWER_QUERY = "query PortalViewer { viewer { id } }";

const STATES_QUERY = `query PortalWorkflowStates {
  workflowStates(first: 200) { nodes { name type } }
}`;

const ACTIVITY_QUERY = `query PortalDayActivity($userId: ID!, $since: DateTimeOrDuration!, $until: DateTimeOrDuration!, $limit: Int!) {
  issues(
    first: $limit
    orderBy: updatedAt
    filter: { assignee: { id: { eq: $userId } }, updatedAt: { gte: $since } }
  ) {
    nodes {
      identifier
      title
      url
      project { name }
      team { name }
      history(first: ${HISTORY_LIMIT}) {
        nodes { createdAt fromState { name } toState { name } }
        pageInfo { hasNextPage }
      }
      comments(first: ${COMMENT_LIMIT}, filter: { createdAt: { gte: $since, lte: $until } }) {
        nodes { createdAt body user { id } }
      }
    }
  }
}`;

type IssueNode = {
  identifier: string;
  title: string;
  url?: string;
  project?: { name?: string } | null;
  team?: { name?: string } | null;
  history: {
    nodes: { createdAt: string; fromState?: { name?: string } | null; toState?: { name?: string } | null }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: { nodes: { createdAt: string; body: string; user?: { id?: string } | null }[] };
};

export function createLinearClient(opts: { apiKey: string; fetch?: typeof fetch }): LinearClient {
  const doFetch = opts.fetch ?? fetch;
  let viewerId: string | null = null;

  async function query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: opts.apiKey },
        body: JSON.stringify({ query: document, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && /abort|timeout/i.test(error.name + error.message);
      throw new LinearError(
        timedOut ? "Linear hat zu lange gebraucht" : "Linear ist nicht erreichbar",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new LinearError("Linear lehnt den API-Key ab — LINEAR_API_KEY prüfen", 502);
    }
    const body = (await response.json().catch(() => null)) as
      | { data?: T; errors?: { message?: string }[] }
      | null;
    if (!response.ok || !body) throw new LinearError(`Linear antwortete mit ${response.status}`);
    if (body.errors?.length) throw new LinearError(body.errors[0]?.message || "Linear meldet einen Fehler");
    if (!body.data) throw new LinearError("Linear lieferte keine Daten");
    return body.data;
  }

  async function viewer(): Promise<string> {
    if (viewerId) return viewerId;
    const data = await query<{ viewer: { id: string } }>(VIEWER_QUERY);
    viewerId = data.viewer.id;
    return viewerId;
  }

  return {
    async workflowStates() {
      const data = await query<{ workflowStates: { nodes: WorkflowState[] } }>(STATES_QUERY);
      const seen = new Set<string>();
      return data.workflowStates.nodes.filter((s) => !seen.has(s.name) && seen.add(s.name));
    },
    async dayActivity(ymd) {
      const userId = await viewer();
      const range = berlinDayRangeUnix(ymd);
      const data = await query<{ issues: { nodes: IssueNode[] } }>(ACTIVITY_QUERY, {
        userId,
        since: new Date(range.from * 1000).toISOString(),
        until: new Date(range.to * 1000).toISOString(),
        limit: ISSUE_LIMIT,
      });
      const nodes = data.issues.nodes;
      const activities: IssueActivity[] = [];
      for (const issue of nodes) {
        const windows = buildWindows(issue.history.nodes, range.from);
        if (windows.length === 0) continue;
        // Linear already filtered by date; this keeps other people's comments
        // out, which the query cannot express.
        const comments = issue.comments.nodes.filter((c) => {
          if (c.user?.id !== userId) return false;
          const at = Math.floor(Date.parse(c.createdAt) / 1000);
          return Number.isFinite(at) && at >= range.from && at <= range.to;
        });
        activities.push({
          issue: issue.identifier,
          title: issue.title,
          project: issue.project?.name || issue.team?.name || "Ohne Projekt",
          url: issue.url ?? "",
          windows,
          commentMinutes: commentMinutes(comments),
          summary: comments.map((c) => c.body.trim()).filter(Boolean).join("\n"),
          historyTruncated: issue.history.pageInfo?.hasNextPage === true,
          sessions: collectSessions(comments, range.from),
        });
      }
      return {
        activities,
        issuesChecked: nodes.length,
        // Say it when the cap bit, instead of pretending the day was complete.
        capped: nodes.length >= ISSUE_LIMIT,
      };
    },
  };
}
