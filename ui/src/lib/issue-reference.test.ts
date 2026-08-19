import { describe, expect, it } from "vitest";
import { parseIssuePathIdFromPath, parseIssueReferenceFromHref, remarkLinkIssueReferences } from "./issue-reference";

describe("issue-reference", () => {
  it("extracts issue ids from company-scoped issue paths", () => {
    expect(parseIssuePathIdFromPath("/PAP/issues/PAP-1271")).toBe("PAP-1271");
    expect(parseIssuePathIdFromPath("/PAP/issues/pap-1272")).toBe("PAP-1272");
    expect(parseIssuePathIdFromPath("/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/PC1A2/issues/pc1a2-7")).toBe("PC1A2-7");
    expect(parseIssuePathIdFromPath("/issues/PAP-1179")).toBe("PAP-1179");
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
  });

  it("does not treat full issue URLs as internal issue paths", () => {
    expect(parseIssuePathIdFromPath("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssuePathIdFromPath("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub issue URLs as internal Paperclip issue links", () => {
    expect(parseIssuePathIdFromPath("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
    expect(parseIssueReferenceFromHref("https://github.com/paperclipai/paperclip/issues/1778")).toBeNull();
  });

  it("ignores placeholder issue paths", () => {
    expect(parseIssuePathIdFromPath("/issues/:id")).toBeNull();
    expect(parseIssuePathIdFromPath("http://localhost:3100/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative issue paths, and issue scheme links into internal links", () => {
    expect(parseIssueReferenceFromHref("pap-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
    expect(parseIssueReferenceFromHref("pc1a2-7")).toEqual({
      issuePathId: "PC1A2-7",
      href: "/issues/PC1A2-7",
    });
    expect(parseIssueReferenceFromHref("/PAP/issues/pap-1180")).toEqual({
      issuePathId: "PAP-1180",
      href: "/issues/PAP-1180",
    });
    expect(parseIssueReferenceFromHref("issue://PAP-1310")).toEqual({
      issuePathId: "PAP-1310",
      href: "/issues/PAP-1310",
    });
    expect(parseIssueReferenceFromHref("issue://:PAP-1311")).toEqual({
      issuePathId: "PAP-1311",
      href: "/issues/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like issue identifiers", () => {
    expect(parseIssueReferenceFromHref("PAP-1271")).toEqual({
      issuePathId: "PAP-1271",
      href: "/issues/PAP-1271",
    });
  });

  it("preserves absolute Paperclip issue URLs so origin, port, and hash are not lost", () => {
    expect(parseIssueReferenceFromHref("http://localhost:3100/PAP/issues/PAP-1179")).toBeNull();
    expect(parseIssueReferenceFromHref("http://remote.example.test:3103/PAPA/issues/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseIssueReferenceFromHref("/issues/:id")).toBeNull();
    expect(parseIssueReferenceFromHref("http://localhost:3100/api/issues/:id")).toBeNull();
  });
});

describe("allowlist de prefixo no token solto", () => {
  const render = (text: string, knownPrefixes: string[] | null) => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
    remarkLinkIssueReferences({ knownPrefixes })(tree as never);
    const collect = (node: { type: string; url?: string; children?: unknown[] }): string[] => [
      ...(node.type === "link" && node.url ? [node.url] : []),
      ...((node.children ?? []) as { type: string; url?: string; children?: unknown[] }[]).flatMap(collect),
    ];
    return collect(tree as never);
  };

  it("nao linka um token cujo prefixo nao e' de nenhum projeto", () => {
    // ADR-019 e' referencia a uma decisao, nao a uma issue. Antes deste filtro
    // virava link e disparava GET /api/issues/ADR-019 -> 404 a cada evento.
    expect(render("ver ADR-019 e RFC-8693", ["TAS", "JIM"])).toEqual([]);
  });

  it("continua linkando um token de prefixo real", () => {
    expect(render("ver TAS-97", ["TAS", "JIM"])).toEqual(["/issues/TAS-97"]);
  });

  it("ignora caixa do prefixo e normaliza o identificador", () => {
    // O resolver ja normalizava para maiusculas; o allowlist tambem compara
    // sem caixa, entao `tas-97` casa o prefixo TAS e vira /issues/TAS-97.
    expect(render("ver tas-97", ["TAS"])).toEqual(["/issues/TAS-97"]);
  });

  it("nao linka marcador de lista", () => {
    // L-01 e R-04 sao numeracao no corpo da especificacao.
    expect(render("L-01 e R-04 pendentes", ["TAS", "JIM"])).toEqual([]);
  });

  it("sem prefixos conhecidos, nao linka token solto", () => {
    // Conjunto vazio = empresas ainda nao carregaram. Linkar aqui reintroduz a
    // rajada de 404; o link aparece quando os prefixos chegarem.
    expect(render("ver TAS-97", null)).toEqual([]);
    expect(render("ver TAS-97", [])).toEqual([]);
  });

  it("forma explicita continua valendo mesmo com prefixo desconhecido", () => {
    // Caminho e esquema sao intencao inequivoca do autor; so a forma SOLTA
    // depende do allowlist.
    expect(render("/TAS/issues/ADR-019", ["TAS"])).toEqual(["/issues/ADR-019"]);
    expect(render("issue://ADR-019", ["TAS"])).toEqual(["/issues/ADR-019"]);
  });
});
