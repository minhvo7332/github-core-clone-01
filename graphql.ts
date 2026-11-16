// GraphQL v4: the 18 documents gh and github-mcp-server actually send.
// A small recursive-descent parser for the subset those documents use
// (operation names, variables, aliases, inline fragments, inline enum lists
// and input objects, batched arrays), plus a type-driven executor over the
// same store the REST surface uses.
//
// Rules the checks pin down:
//   - viewer.login is the token owner (adaiversen, hardcoded).
//   - repository(owner:, name:) is null (with no errors) when unknown.
//   - __type fields/enumValues answer under gh's aliases (Issue:, PullRequest:,
//     Repository:, SearchType:) with the fields gh feature-detects.
//   - issues(first, states, orderBy, after): CREATED_AT DESC, ties by number
//     DESC; cursors round-trip; a page holds exactly `first` nodes.
//   - An unknown field is HTTP 200 with an errors array naming the field.
//   - Unauthenticated is 401 (handled by app.ts before this runs).
//   - Global ids are opaque (base64url payloads) and stable across reads.

import { VIEWER_ID, VIEWER_LOGIN, commentGlobalId, decodeGlobalId, issueGlobalId, parseCommit, pullGlobalId, repoGlobalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { squashMerge } from './rest.ts';

// ---------------------------------------------------------------------------------------------------------
// Tokenizer + parser (the GraphQL subset the suite sends).
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      tokens.push({ kind: 'int', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface SelectionNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
  fragmentType: string | null;
}

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return tok.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value as string;
    }
    const variables: OperationNode['variables'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        let typeName = '';
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '[') {
          this.next();
          typeName = `[${this.expectName()}]`;
          this.expectPunct(']');
        } else {
          typeName = this.expectName();
        }
        let required = false;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') {
          this.next();
          required = true;
        }
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          this.parseValue();
        }
        variables.push({ name: varName, type: typeName, required });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '...') {
      this.next();
      const nextTok = this.peek();
      if (nextTok?.kind === 'name' && nextTok.value === 'on') {
        this.next();
        const typeName = this.expectName();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '', args: [], selections, fragmentType: typeName };
      }
      // A named fragment spread: not used by the suite; skip its selections.
      this.expectName();
      return { alias: null, name: '', args: [], selections: [], fragmentType: '__skip__' };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: SelectionNode['args'] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'];

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo, __store: store };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pr: PullRequest): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr };
}

class GraphQLError extends Error {}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(document: string, variables: Variables): { data: unknown; errors?: Array<{ message: string }> } {
    this.errors = [];
    let ops: OperationNode[];
    try {
      ops = new Parser(tokenize(document)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    if (ops.length === 0) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
    const op = ops[0];
    const root: GqlObject = op.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
    try {
      const data = this.executeSelections(root, op.selections, variables);
      if (this.errors.length > 0) return { data: null, errors: this.errors };
      return { data };
    } catch (err) {
      if (err instanceof GraphQLError) {
        return { data: null, errors: this.errors.length > 0 ? this.errors : [{ message: 'field error' }] };
      }
      throw err;
    }
  }

  private fieldError(typeName: string, field: string): never {
    this.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
    throw new GraphQLError(`unknown field ${field}`);
  }

  private executeSelections(parent: GqlObject, selections: SelectionNode[], variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.fragmentType === '__skip__') continue;
      if (sel.fragmentType !== null) {
        if (sel.fragmentType !== parent.__typename) continue;
        Object.assign(out, this.executeSelections(parent, sel.selections, variables));
        continue;
      }
      const key = sel.alias ?? sel.name;
      try {
        out[key] = this.resolveField(parent, sel, variables);
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        this.errors.push({ message: err instanceof Error ? err.message : String(err) });
        throw new GraphQLError('field error');
      }
    }
    return out;
  }

  private argMap(sel: SelectionNode, variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of sel.args) out[arg.name] = resolveValue(arg.value, variables);
    return out;
  }

  private sub(parentValue: unknown, sel: SelectionNode, variables: Variables): unknown {
    if (parentValue === null || parentValue === undefined) return null;
    if (Array.isArray(parentValue)) {
      return parentValue.map((entry) => this.sub(entry, sel, variables));
    }
    if (typeof parentValue === 'object' && '__typename' in (parentValue as Record<string, unknown>)) {
      return this.executeSelections(parentValue as GqlObject, sel.selections, variables);
    }
    return parentValue;
  }

  private resolveField(parent: GqlObject, sel: SelectionNode, variables: Variables): unknown {
    const typeName = parent.__typename;
    const args = this.argMap(sel, variables);
    const select = (value: unknown): unknown => (sel.selections.length === 0 ? value : this.sub(value, sel, variables));

    if (typeName === 'Query') {
      if (sel.name === 'viewer') return select({ __typename: 'User', __login: VIEWER_LOGIN });
      if (sel.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === VIEWER_LOGIN ? this.store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return select(repoObject(this.store, repo));
      }
      if (sel.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null || decoded.kind !== 'R') return null;
        const repo = this.store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        return select(repoObject(this.store, repo));
      }
      if (sel.name === '__type') {
        const name = String(args.name ?? '');
        return select({ __typename: '__Type', __typeName: name });
      }
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'User') {
      if (sel.name === 'login') return parent.__login ?? VIEWER_LOGIN;
      if (sel.name === 'id') return VIEWER_ID;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'Repository') {
      const repo = parent.__repo as Repo;
      switch (sel.name) {
        case 'id':
          return repoGlobalId(repo.owner, repo.name);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return select({ __typename: 'User', __login: repo.owner });
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return select({ __typename: 'Ref', __name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'WRITE';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          if (issue === undefined) return null;
          return select(issueObject(repo, issue));
        }
        case 'issues':
          return select(this.issueConnection(repo, args));
        case 'pullRequests':
          return select(this.pullConnection(repo, args));
        case 'pullRequest': {
          const pr = repo.pulls.get(Number(args.number));
          if (pr === undefined) return null;
          return select(pullObject(repo, pr));
        }
        default:
          return this.fieldError(typeName, sel.name);
      }
    }

    if (typeName === 'Ref') {
      if (sel.name === 'name') return parent.__name;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'Issue') {
      const issue = parent.__issue as Issue;
      switch (sel.name) {
        case 'id':
          return issue.globalId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          return this.fieldError(typeName, sel.name);
      }
    }

    if (typeName === 'IssueConnection') {
      if (sel.name === 'nodes') return select(parent.__nodes as GqlObject[]);
      if (sel.name === 'pageInfo') return select(parent.__pageInfo as GqlObject);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'PageInfo') {
      if (sel.name === 'hasNextPage') return parent.__hasNextPage;
      if (sel.name === 'endCursor') return parent.__endCursor;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'PullRequest') {
      const pr = parent.__pr as PullRequest;
      const repo = parent.__repo as Repo;
      switch (sel.name) {
        case 'id':
          return pr.globalId;
        case 'number':
          return pr.number;
        case 'state':
          return pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pr.merged;
        case 'headRefName':
          return pr.head;
        case 'baseRefName':
          return pr.base;
        case 'mergeable':
          return this.mergeableOf(repo, pr);
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = prFilesOf(this.store, repo, pr).slice(0, first);
          return select({
            __typename: 'PullRequestChangedFileConnection',
            __nodes: files.map((f) => ({ __typename: 'PullRequestChangedFile', __path: f.filename })),
          });
        }
        default:
          return this.fieldError(typeName, sel.name);
      }
    }

    if (typeName === 'PullRequestConnection') {
      if (sel.name === 'nodes') return select(parent.__nodes as GqlObject[]);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'PullRequestChangedFileConnection') {
      if (sel.name === 'nodes') return select(parent.__nodes as GqlObject[]);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'PullRequestChangedFile') {
      if (sel.name === 'path') return parent.__path;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === '__Type') {
      const name = String(parent.__typeName ?? '');
      if (sel.name === 'fields') {
        const list = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_REQUEST_FIELDS : name === 'Repository' ? REPOSITORY_FIELDS : [];
        return select(list.map((entry) => ({ __typename: '__Field', __name: entry })));
      }
      if (sel.name === 'enumValues') {
        const list = name === 'SearchType' ? SEARCH_TYPE_VALUES : [];
        return select(list.map((entry) => ({ __typename: '__EnumValue', __name: entry })));
      }
      if (sel.name === 'name') return name;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === '__Field' || typeName === '__EnumValue') {
      if (sel.name === 'name') return parent.__name;
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'Mutation') {
      switch (sel.name) {
        case 'createIssue':
          return select(this.createIssue(args));
        case 'closeIssue':
          return select(this.closeIssue(args));
        case 'createPullRequest':
          return select(this.createPullRequest(args));
        case 'mergePullRequest':
          return select(this.mergePullRequest(args));
        case 'addComment':
          return select(this.addComment(args));
        default:
          return this.fieldError(typeName, sel.name);
      }
    }

    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
      if (sel.name === 'issue') return select(parent.__issue as GqlObject);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
      if (sel.name === 'pullRequest') return select(parent.__pr as GqlObject);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'AddCommentPayload') {
      if (sel.name === 'commentEdge') return select(parent.__edge as GqlObject);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'IssueCommentEdge') {
      if (sel.name === 'node') return select(parent.__node as GqlObject);
      return this.fieldError(typeName, sel.name);
    }

    if (typeName === 'IssueComment') {
      if (sel.name === 'id') return parent.__id;
      if (sel.name === 'body') return parent.__body;
      return this.fieldError(typeName, sel.name);
    }

    return this.fieldError(typeName, sel.name);
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let list = [...repo.issues.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'DESC');
    list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
    const first = typeof args.first === 'number' ? args.first : list.length;
    let start = 0;
    if (typeof args.after === 'string' && args.after !== '') {
      const decoded = decodeCursor(args.after);
      if (decoded !== null) {
        const index = list.findIndex((issue) => issue.seq === decoded);
        if (index >= 0) start = index + 1;
      }
    }
    const page = list.slice(start, start + first);
    const hasNextPage = start + page.length < list.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].seq) : null;
    return {
      __typename: 'IssueConnection',
      __nodes: page.map((issue) => issueObject(repo, issue)),
      __pageInfo: { __typename: 'PageInfo', __hasNextPage: hasNextPage, __endCursor: endCursor },
    };
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let list = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
    list.sort((a, b) => b.seq - a.seq || b.number - a.number);
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      __nodes: page.map((pr) => pullObject(repo, pr)),
    };
  }

  private mergeableOf(repo: Repo, pr: PullRequest): string {
    if (pr.state === 'closed') return 'UNKNOWN';
    return wouldConflict(this.store, repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
  }

  private createIssue(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'R') throw new Error('createIssue: unknown repository');
    const repo = this.store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) throw new Error('createIssue: unknown repository');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.store.nowIso();
    const issue: Issue = {
      number,
      globalId: issueGlobalId(repo.owner, repo.name, number),
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      seq: this.store.issueSeq++,
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return { __typename: 'CreateIssuePayload', __issue: issueObject(repo, issue) };
  }

  private closeIssue(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (decoded === null || decoded.kind !== 'I') throw new Error('closeIssue: unknown issue');
    const repo = this.store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.get(decoded.number);
    if (issue === undefined) throw new Error('closeIssue: unknown issue');
    issue.state = 'closed';
    issue.updatedAt = this.store.nowIso();
    return { __typename: 'CloseIssuePayload', __issue: issueObject(repo, issue) };
  }

  private createPullRequest(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'R') throw new Error('createPullRequest: unknown repository');
    const repo = this.store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) throw new Error('createPullRequest: unknown repository');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) throw new Error('createPullRequest: unknown branch');
    for (const existing of repo.pulls.values()) {
      if (existing.head === head && existing.base === base && existing.state === 'open') {
        throw new Error('createPullRequest: a pull request already exists for this head and base');
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.store.nowIso();
    const pr: PullRequest = {
      number,
      globalId: pullGlobalId(repo.owner, repo.name, number),
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.store.issueSeq++,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pr);
    return { __typename: 'CreatePullRequestPayload', __pr: pullObject(repo, pr) };
  }

  private mergePullRequest(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.kind !== 'PR') throw new Error('mergePullRequest: unknown pull request');
    const repo = this.store.getRepo(decoded.owner, decoded.name);
    const pr = repo?.pulls.get(decoded.number);
    if (pr === undefined || repo === undefined) throw new Error('mergePullRequest: unknown pull request');
    if (pr.state === 'closed') throw new Error('mergePullRequest: pull request is already closed');
    const merged = squashMerge(this.store, repo, pr);
    if (merged.conflict) throw new Error('mergePullRequest: merge conflict');
    if (merged.sha === undefined) throw new Error('mergePullRequest: cannot merge');
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = this.store.nowIso();
    pr.mergeCommitSha = merged.sha;
    pr.baseSha = merged.sha;
    pr.updatedAt = this.store.nowIso();
    return { __typename: 'MergePullRequestPayload', __pr: pullObject(repo, pr) };
  }

  private addComment(args: Record<string, unknown>): GqlObject {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.kind !== 'I') throw new Error('addComment: unknown subject');
    const repo = this.store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.get(decoded.number);
    if (issue === undefined || repo === undefined) throw new Error('addComment: unknown issue');
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment = {
      id,
      globalId: commentGlobalId(repo.owner, repo.name, issue.number, id),
      body: String(input.body ?? ''),
      createdAt: this.store.nowIso(),
    };
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      __edge: { __typename: 'IssueCommentEdge', __node: { __typename: 'IssueComment', __id: comment.globalId, __body: comment.body } },
    };
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** The three-way conflict check without mutating anything (shared with REST merges). */
export function wouldConflict(store: Store, repo: Repo, pr: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseObj = store.getObject(baseTip);
  const headObj = store.getObject(headTip);
  if (baseObj === undefined || headObj === undefined) return false;
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(parseCommit(store.getObject(mergeBase)!.data).tree);
  const headTree = store.flattenTree(parseCommit(headObj.data).tree);
  const targetTree = store.flattenTree(parseCommit(baseObj.data).tree);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const baseOid = baseTree.get(path)?.oid ?? null;
    const headOid = headTree.get(path)?.oid ?? null;
    const targetOid = targetTree.get(path)?.oid ?? null;
    if (headOid === baseOid) continue;
    if (targetOid === baseOid) continue;
    if (headOid === targetOid) continue;
    return true;
  }
  return false;
}

function prFilesOf(store: Store, repo: Repo, pr: PullRequest): Array<{ filename: string }> {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const mergeBase = store.mergeBase(baseTip, headTip);
  const baseTree = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(parseCommit(store.getObject(mergeBase)!.data).tree);
  const headTree = store.flattenTree(parseCommit(store.getObject(headTip)!.data).tree);
  const out: Array<{ filename: string }> = [];
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    if (baseTree.get(path)?.oid === headTree.get(path)?.oid) continue;
    out.push({ filename: path });
  }
  return out;
}

/** Execute one GraphQL request body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; payload: unknown } {
  const executor = new Executor(store);
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
      const op = entry as Record<string, unknown>;
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'missing query' }] };
      return executor.execute(op.query, (op.variables ?? {}) as Variables);
    });
    return { status: 200, payload: results };
  }
  if (body === null || typeof body !== 'object') return { status: 400, payload: { errors: [{ message: 'invalid GraphQL body' }] } };
  const op = body as Record<string, unknown>;
  if (typeof op.query !== 'string') return { status: 400, payload: { errors: [{ message: 'missing query' }] } };
  return { status: 200, payload: executor.execute(op.query, (op.variables ?? {}) as Variables) };
}
