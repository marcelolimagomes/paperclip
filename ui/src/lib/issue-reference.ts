type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const ISSUE_SCHEME_RE = /^issue:\/\/:?([^?#\s]+)(?:[?#].*)?$/i;
const ISSUE_REFERENCE_TOKEN_RE = /issue:\/\/:?[^\s<>()]+|https?:\/\/[^\s<>()]+|\/(?:[^\s<>()/]+\/)*issues\/[A-Z][A-Z0-9]*-\d+(?=$|[\s<>)\],.;!?:])|\b[A-Z][A-Z0-9]*-\d+\b/gi;

// Prefixo do token solto (`ADR-019` -> `ADR`). So a forma SOLTA e' filtrada
// pelos prefixos conhecidos; `issue://`, caminho `/…/issues/X-1` e URL completa
// continuam valendo, porque ali a intencao do autor e' inequivoca.
const BARE_TOKEN_PREFIX_RE = /^([A-Z][A-Z0-9]*)-\d+$/i;

/**
 * Um token `LETRAS-NUMERO` so e' referencia de issue se o prefixo pertencer a
 * um projeto existente.
 *
 * Sem esse filtro, qualquer `ADR-019`, `RFC-8693` ou marcador de lista `L-01`
 * num corpo de issue virava link, e cada link busca a issue para exibir titulo
 * e status -- 404 por token, repetido a cada evento de WebSocket, porque o
 * `invalidateQueries` refaz todas as queries. Havia 27 tokens assim nos corpos
 * desta instancia; `ADR-002` sozinho aparecia 28 vezes.
 *
 * Conjunto vazio significa "ainda nao sei" (as empresas nao carregaram), e ai
 * o token NAO vira link: um link que aparece tarde e' melhor que uma rajada de
 * requisicoes para issues que nao existem.
 */
function isKnownIssuePrefix(core: string, knownPrefixes: ReadonlySet<string> | null): boolean {
  const bare = core.match(BARE_TOKEN_PREFIX_RE);
  if (!bare) return true;
  if (!knownPrefixes || knownPrefixes.size === 0) return false;
  return knownPrefixes.has((bare[1] ?? "").toUpperCase());
}

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  const pathname = pathOrUrl.trim();
  if (!pathname) return null;
  if (/^https?:\/\//i.test(pathname)) return null;

  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  const issuePathId = decodeURIComponent(segments[issueIndex + 1] ?? "");
  if (!issuePathId || issuePathId.startsWith(":")) return null;
  return BARE_ISSUE_IDENTIFIER_RE.test(issuePathId) ? issuePathId.toUpperCase() : issuePathId;
}

export function parseIssueReferenceFromHref(href: string | null | undefined) {
  if (!href) return null;
  const trimmed = href.trim();
  const issueSchemeMatch = trimmed.match(ISSUE_SCHEME_RE);
  if (issueSchemeMatch?.[1]) {
    const issuePathId = decodeURIComponent(issueSchemeMatch[1]);
    return {
      issuePathId,
      href: `/issues/${encodeURIComponent(issuePathId)}`,
    };
  }

  const pathId = parseIssuePathIdFromPath(href);
  if (pathId) {
    return {
      issuePathId: pathId,
      href: `/issues/${encodeURIComponent(pathId)}`,
    };
  }

  if (!BARE_ISSUE_IDENTIFIER_RE.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  return {
    issuePathId: normalized,
    href: `/issues/${encodeURIComponent(normalized)}`,
  };
}

function splitTrailingPunctuation(token: string) {
  let core = token;
  let trailing = "";

  while (core.length > 0) {
    const lastChar = core.at(-1);
    if (!lastChar || !/[),.;!?:\]]/.test(lastChar)) break;
    if (lastChar === ")") {
      const openCount = (core.match(/\(/g) ?? []).length;
      const closeCount = (core.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    if (lastChar === "]") {
      const openCount = (core.match(/\[/g) ?? []).length;
      const closeCount = (core.match(/\]/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    trailing = `${lastChar}${trailing}`;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function createIssueLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function linkifyIssueReferencesInText(
  value: string,
  knownPrefixes: ReadonlySet<string> | null,
): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(ISSUE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    if (!isKnownIssuePrefix(core, knownPrefixes)) continue;
    const issueRef = parseIssueReferenceFromHref(core);
    if (!issueRef) continue;

    matched = true;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createIssueLinkNode(core, issueRef.href));
    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode, knownPrefixes: ReadonlySet<string> | null) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value, knownPrefixes);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child, knownPrefixes);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkIssueReferences(options?: {
  /** Prefixos de issue existentes (ex.: TAS, JIM). Ver isKnownIssuePrefix. */
  knownPrefixes?: Iterable<string> | null;
}) {
  const knownPrefixes = options?.knownPrefixes
    ? new Set([...options.knownPrefixes].map((p) => p.toUpperCase()))
    : null;
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, knownPrefixes);
  };
}
