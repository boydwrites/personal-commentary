/** The deliberately narrow boundary between local studies and a reviewed research package. */
export interface ResearchSourceRights {
  sourceId: string;
  licenseUrl: string;
  attribution: string;
  provenanceUrl: string;
}

export interface ResearchCorpusApproval {
  expectedHash: string;
  reviewedPrivacy: boolean;
  reviewedQuality: boolean;
  reviewedRights: boolean;
  sourceRights: ResearchSourceRights[];
}

export interface ResearchCorpusData {
  passage: { canonicalRef: string; displayRef: string; startOrdinal: number; endOrdinal: number; translationId: string };
  runs: {
    id: string; depth: string; status: string; promptVersion: string;
    compatibilityKey: string; inputFingerprint: string; profileVersion: string;
    profile: {
      editorial: string; language: string; versification: string; retrieval: string; extractor: string; verifier: string; systemSha256: string;
      calls: { stage: string; model: string; effort: string; promptVersion: string; schemaSha256: string }[];
      datasets: { name: string; sha256: string | null }[];
      authors: { name: string; identity: string; tradition: string; preferred: boolean; rank: number | null }[];
    };
    startedAt: string | null; finishedAt: string | null;
    contextSummary: string | null; qualification: string | null;
    where: { book: string; section: string; flow: string; thisVerse: string } | null;
    christSummary: string | null;
  }[];
  artifacts: {
    id: string; runId: string; kind: string; section: string | null; group: string | null;
    title: string; displayBody: string; modelBody: string; contentSha256: string;
    relationship: string; authorName: string | null; limitation: string | null; disagreement: string | null;
    sourceStatus: string; quotationStatus: string;
    word: {
      strong: string; lemma: string; transliteration: string; gloss: string; partOfSpeech: string;
      definition: string; language: string; occurrenceCount: number;
      uses: { ref: string; text: string }[];
    } | null;
  }[];
  sources: {
    id: string; kind: string; url: string | null; title: string; authorName: string | null;
    work: string | null; locator: string | null; edition: string | null; language: string;
    rights: string; matchLevel: string; text: string | null; contentSha256: string | null; fetchedAt: string | null;
  }[];
  runSources: { runId: string; sourceId: string; stage: string }[];
  gaps: { runId: string; authorName: string; note: string }[];
  excerpts: {
    id: string; runId: string; sourceId: string; text: string; contentSha256: string;
    startOffset: number; endOffset: number; offsetEncoding: "UTF-16";
  }[];
  evidence: {
    id: string; artifactId: string; excerptId: string; use: string; quoteText: string | null;
    match: string | null; matchStart: number | null; matchEnd: number | null; offsetEncoding: "UTF-16";
  }[];
  modelCalls: {
    id: string; runId: string; stage: string; requestedModel: string; servedModel: string | null;
    effort: string; promptVersion: string; outcome: "completed" | "incomplete";
    inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
    cacheWriteTokens: number | null; webSearchRequests: number; latencyMs: number | null; createdAt: string;
  }[];
  costEvents: {
    id: string; runId: string; modelCallId: string | null; occurredAt: string;
    vendor: string; category: string; units: number; usdMicros: number; estimated: boolean;
  }[];
}

export interface ResearchCorpusInspection {
  hash: string;
  status: "blocked" | "needs_review" | "approved" | "revoked";
  blockers: { code: string; message: string }[];
  counts: { runs: number; artifacts: number; sources: number; excerpts: number; evidence: number; modelCalls: number; costEvents: number };
  preview: ResearchCorpusData | null;
  dependencies: {
    sourceId: string; title: string; rights: string; eligible: boolean;
    licenseUrl: string | null; attribution: string | null; provenanceUrl: string | null;
  }[];
  review: { id: string; decision: "approved" | "revoked"; createdAt: string } | null;
  cloudSyncEnabled: false;
}

export interface ResearchCorpusExport {
  format: "personal-commentary.research-corpus";
  version: 1;
  scope: "neutral";
  exportedAt: string;
  manifest: {
    dataSha256: string; reviewHash: string; reviewId: string; reviewedAt: string;
    totalCostMicros: number; costBasis: "unique-cost-events";
    sourceRights: ResearchSourceRights[];
    cloudSyncEnabled: false;
  };
  data: ResearchCorpusData;
}
