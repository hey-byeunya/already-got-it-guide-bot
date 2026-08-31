// 하이브리드 검색 — 코사인 상위 10 + 미중복 BM25 상위 5
//
// 의미 검색은 표현이 달라도 뜻이 가까운 조각을 잡지만, 고유명사·정확한 표기가
// 중요한 질문에서 필요한 조각을 충분히 높이 올리지 못한다. 그래서 낱말이 겹치는
// 조각을 BM25 로 보탠다.
//
// 규칙은 명세대로 고정한다 — 상위 10/5, BM25 는 그 검색의 최고 점수로 나눠 0~1,
// 반환값마다 chunk·score·method 보존, 최고 유사도 0.55 미만이면 결과를 버리지 않고
// 약한 근거 상태로 돌려준다. 이 숫자들을 여기서 고치지 않는다(실험은 G 에서).

export const VECTOR_TOP_K = 10;
export const BM25_TOP_K = 5;
export const WEAK_EVIDENCE_THRESHOLD = 0.55;

export type Chunk = {
  id: string;
  text: string;
  url: string;
  /** 「위시리스트」 — 화면에 보여 줄 사람이 읽는 이름표. 고객에게 id 를 보이지 않는다 */
  doc: string;
  section: string;
  vector: number[];
};

export type Hit = {
  chunk: Chunk;
  score: number;
  method: "vector" | "bm25";
};

export type SearchResult = {
  hits: Hit[];
  /** 코사인 최고 점수. 약한 근거 판단의 기준이다 */
  topScore: number;
  /** 최고 유사도가 0.55 미만 — 결과를 버리지 않고 이 표시만 올린다 */
  weakEvidence: boolean;
};

// ── 코사인 ──────────────────────────────────────────────────────────────
/** 문서·질문 벡터 모두 L2 정규화되어 있으므로 내적이 곧 코사인 유사도다. */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── 낱말 나누기 ─────────────────────────────────────────────────────────
// 한국어는 조사가 붙어 "수량을" 과 "수량" 이 다른 낱말이 된다. 브라우저에서
// 형태소 분석기를 쓸 수는 없으므로, 한글은 글자 2개씩(bigram) 으로 잘라
// 조사가 붙어도 겹치는 부분이 남게 한다. 영문·숫자는 낱말 그대로 둔다.
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+|[가-힣]+/g)) {
    const t = m[0];
    if (/^[가-힣]+$/.test(t)) {
      if (t.length === 1) out.push(t);
      for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
    } else {
      out.push(t);
    }
  }
  return out;
}

// ── BM25 ────────────────────────────────────────────────────────────────
const K1 = 1.2;
const B = 0.75;

export type Bm25Index = {
  docs: { id: string; tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avgLen: number;
  N: number;
};

export function buildBm25Index(chunks: Chunk[]): Bm25Index {
  const docs = chunks.map((c) => {
    const toks = tokenize(c.text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: c.id, tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  return { docs, df, avgLen, N: docs.length };
}

/** 문서 id → BM25 원점수. 정규화는 호출한 쪽에서 한다. */
export function bm25Scores(index: Bm25Index, query: string): Map<string, number> {
  const qToks = [...new Set(tokenize(query))];
  const scores = new Map<string, number>();
  for (const d of index.docs) {
    let s = 0;
    for (const t of qToks) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen))));
    }
    if (s > 0) scores.set(d.id, s);
  }
  return scores;
}

// ── 하이브리드 ──────────────────────────────────────────────────────────
export function hybridSearch(
  chunks: Chunk[],
  index: Bm25Index,
  queryVector: number[],
  queryText: string,
): SearchResult {
  // 1. 코사인 상위 10
  const byCos = chunks
    .map((c) => ({ chunk: c, score: cosine(queryVector, c.vector) }))
    .sort((a, b) => b.score - a.score);

  const topScore = byCos.length ? byCos[0].score : 0;
  const vectorHits: Hit[] = byCos
    .slice(0, VECTOR_TOP_K)
    .map((h) => ({ chunk: h.chunk, score: h.score, method: "vector" as const }));

  // 2. 중복되지 않은 BM25 상위 5
  const taken = new Set(vectorHits.map((h) => h.chunk.id));
  const raw = bm25Scores(index, queryText);
  const max = Math.max(0, ...raw.values());

  const byId = new Map(chunks.map((c) => [c.id, c]));
  const bm25Hits: Hit[] = [...raw.entries()]
    .filter(([id]) => !taken.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, BM25_TOP_K)
    // 3. 그 검색의 최고 점수로 나눠 0~1 로 맞춘다
    .map(([id, s]) => ({ chunk: byId.get(id)!, score: max > 0 ? s / max : 0, method: "bm25" as const }));

  // 4. 최고 유사도가 낮아도 결과를 버리지 않는다. 버리면 검색이 어떻게
  //    실패했는지 알 수 없고, 평소와 같은 자신감으로 답하면 약한 연관을
  //    사실처럼 말하게 된다. 표시만 올려 프롬프트와 화면이 보수적으로 바뀌게 한다.
  return {
    hits: [...vectorHits, ...bm25Hits],
    topScore,
    weakEvidence: topScore < WEAK_EVIDENCE_THRESHOLD,
  };
}

// ── 모델 없이 도는 검색 ─────────────────────────────────────────────────
/**
 * BM25 만으로 찾는다. **임베딩 모델이 필요 없다.**
 *
 * 왜 필요한가.
 * 배포 주소(HTTPS)에서는 브라우저가 로컬 Ollama 에 닿지 못해 답을 만들 수 없다.
 * 그렇다고 화면이 아무것도 못 하면, 링크만 열어 본 사람은 빈손으로 돌아간다.
 *
 * BM25 는 낱말이 겹치는 정도만 보므로 정적 JSON 과 브라우저 계산만으로 돈다 —
 * 195MB 를 받지 않고도 **"이 질문의 답은 이 도움말에 있습니다"** 까지는 준다.
 * 고객센터로서 이것도 유효한 응답이다.
 *
 * 한계를 숨기지 않는다: 표현이 다르면 못 찾는다. "다 쓴 물건" 과 "사용 완료" 처럼
 * 뜻은 같고 낱말이 다른 질문은 벡터 검색이라야 잡힌다.
 */
export function keywordOnlySearch(
  chunks: Chunk[],
  index: Bm25Index,
  queryText: string,
  topK = 5,
): Hit[] {
  const raw = bm25Scores(index, queryText);
  const max = Math.max(0, ...raw.values());
  const byId = new Map(chunks.map((c) => [c.id, c]));
  return [...raw.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, s]) => ({ chunk: byId.get(id)!, score: max > 0 ? s / max : 0, method: "bm25" as const }));
}
