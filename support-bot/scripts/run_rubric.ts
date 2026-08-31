// 실험 — 평가 세트 15개를 한 세팅으로 여러 번 돌려 기록한다.
//
//   node scripts/embed-docs-browser-path.mjs --prefix --queries data/eval-queries.json
//   node scripts/run_rubric.ts --setting S0 --runs 3
//
// 한 번에 넣는 것 하나만 바꾼다. 질문 세트와 순서는 세팅과 무관하게 항상 같다.
// 같은 질문의 답도 판정도 회차마다 흔들리므로 여러 번 돌려 **흔들림의 폭**을
// 함께 잰다. 그보다 작은 차이는 변화로 읽지 않는다.
//
// dev-bot 과 가장 크게 다른 점: 인용·절차형·내부 ID 노출을 **프로그램이** 센다.
// 판정 모델에게는 뜻을 읽어야 하는 셋만 남긴다.

import fs from "node:fs";
import { buildBm25Index, hybridSearch, type Chunk } from "../app/src/lib/search.ts";
import { buildPrompt } from "../app/src/lib/prompt.ts";
import { streamChat } from "../app/src/lib/ollama.ts";
import { judge } from "../app/src/lib/judge.ts";
import { checkBeforeCall } from "../app/src/lib/gate.ts";
import { checkCitations } from "../app/src/lib/citation.ts";

type Setting = {
  name: string;
  바꾼것: string;
  customerFormat?: boolean;
  citationAtEnd?: boolean;
  topK?: { vector?: number; bm25?: number };
};

const SETTINGS: Record<string, Setting> = {
  S0: { name: "S0", 바꾼것: "— (기준 행)" },
  S1: { name: "S1", 바꾼것: "고객센터 답변 형식 지시를 뺀다", customerFormat: false },
  S2: { name: "S2", 바꾼것: "근거 개수를 10+5 → 5+3 으로 줄인다", topK: { vector: 5, bm25: 3 } },
  S3: { name: "S3", 바꾼것: "인용 요구를 프롬프트 맨 끝(질문 뒤)으로 옮긴다", citationAtEnd: true },
};

const arg = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const setting = SETTINGS[arg("--setting") ?? "S0"];
if (!setting) {
  console.error(`모르는 세팅. 가능: ${Object.keys(SETTINGS).join(", ")}`);
  process.exit(1);
}
const RUNS = Number(arg("--runs")) || 3;

const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/help-docs.json", "utf8"));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/query-vectors.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
type Q = {
  id: string; kind: string; q: string; expectedDocs: string[];
  expect: { answerable: boolean; procedural: boolean; refusal: boolean; gated: boolean };
  왜: string;
};
const QUESTIONS: Q[] = JSON.parse(fs.readFileSync("data/eval-queries.json", "utf8"));
const index = buildBm25Index(chunks);

console.log(`세팅 ${setting.name} — 바꾼 것: ${setting.바꾼것}`);
console.log(`질문 ${QUESTIONS.length}개 × ${RUNS}회 = ${QUESTIONS.length * RUNS}번\n`);

const rows: any[] = [];
for (let run = 1; run <= RUNS; run++) {
  for (const Q of QUESTIONS) {
    const base = {
      setting: setting.name, run, id: Q.id, kind: Q.kind, question: Q.q,
      expect: Q.expect, expectedDocs: Q.expectedDocs,
    };

    // 호출 전 검사 — 막히면 모델도 검색도 부르지 않는다
    const g = checkBeforeCall(Q.q);
    if (g.blocked) {
      rows.push({
        ...base, gated: true, gateRule: g.rule,
        hits: 0, topScore: 0, weakEvidence: false, foundDocs: [],
        answer: g.answer, answerLen: g.answer.length,
        // 프로그램이 세는 것 — 게이트 답변은 인용하지 않는다(근거가 없으므로)
        citation: checkCitations(g.answer, 0),
        // 게이트가 막은 것은 정의상 정당한 거절이다. 모델을 부르지 않았다.
        verdict: { grounded: false, noHalluc: true, refusal: true, score: 0, comment: `호출 전 검사: ${g.rule}` },
        judgeError: null,
      });
      console.log(`  ${run}회 ${Q.id} ${Q.kind.padEnd(4)} 호출 전 검사에서 막음 — ${g.rule}`);
      continue;
    }

    const qv = qvecs.get(Q.q);
    if (!qv) { console.error(`질문 벡터 없음: ${Q.q}`); process.exit(1); }

    const res = hybridSearch(chunks, index, qv, Q.q, setting.topK ?? {});
    const prompt = buildPrompt(res.hits, Q.q, res.weakEvidence, undefined, {
      customerFormat: setting.customerFormat,
      citationAtEnd: setting.citationAtEnd,
    });

    let answer = "";
    const ctrl = new AbortController();
    for await (const piece of streamChat(prompt, ctrl.signal)) answer += piece;

    // 프로그램이 센다 — 판정 모델에게 묻지 않는다
    const citation = checkCitations(answer, res.hits.length);
    // 뜻을 읽어야 하는 것만 모델에게
    const outcome = await judge(Q.q, res.hits, answer, ctrl.signal);
    const v = outcome.ok ? outcome.verdict : null;

    // 인용한 번호가 기대한 도움말을 가리켰는가
    const citedDocs = citation.numbers
      .filter((n) => n >= 1 && n <= res.hits.length)
      .map((n) => res.hits[n - 1].chunk.id);
    const hitRight = Q.expectedDocs.length === 0
      ? null
      : Q.expectedDocs.every((d) => citedDocs.includes(d));

    rows.push({
      ...base, gated: false, gateRule: null,
      hits: res.hits.length, topScore: +res.topScore.toFixed(4), weakEvidence: res.weakEvidence,
      foundDocs: res.hits.slice(0, 5).map((h) => h.chunk.id),
      answer, answerLen: answer.length,
      citation, citedDocs, hitRight,
      verdict: v, judgeError: outcome.ok ? null : outcome.reason,
    });

    const badge = v
      ? `g=${v.grounded ? "T" : "F"} h=${v.noHalluc ? "T" : "F"} r=${v.refusal ? "T" : "F"} ${String(v.score).padStart(3)}점`
      : "judgeError    ";
    const cw = citation.cited ? `인용[${citation.numbers.join(",")}]` : "인용없음";
    const flags = [
      citation.outOfRange.length ? "지어낸번호" : "",
      citation.leakedIds.length ? "ID노출" : "",
      citation.procedural !== Q.expect.procedural ? "절차형어긋남" : "",
      hitRight === false ? "근거빗나감" : "",
    ].filter(Boolean).join(" ");
    console.log(`  ${run}회 ${Q.id} ${Q.kind.padEnd(4)} ${badge} ${cw.padEnd(14)} ${String(answer.length).padStart(4)}자 ${flags}`);
  }
}

fs.mkdirSync("data/rubric", { recursive: true });
fs.writeFileSync(`data/rubric/${setting.name}.json`, JSON.stringify(rows, null, 2) + "\n");
console.log(`\n기록: data/rubric/${setting.name}.json`);
