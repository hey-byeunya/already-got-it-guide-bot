// 판정 리허설 — 전체 경로를 그대로 돌리고 기록을 남긴다.
//
//   node scripts/check_judge.ts
//
// 질문 → 검색 → 프롬프트 → 생성 → 판정을 브라우저와 같은 코드로 돈다.
// 질문 벡터는 embed-docs-browser-path.mjs 가 만든 것을 쓴다.

import fs from "node:fs";
import { buildBm25Index, hybridSearch, type Chunk } from "../app/src/lib/search.ts";
import { buildPrompt } from "../app/src/lib/prompt.ts";
import { streamChat } from "../app/src/lib/ollama.ts";
import { judge, parseVerdict } from "../app/src/lib/judge.ts";

const chunks: Chunk[] = JSON.parse(fs.readFileSync("app/public/already-got-it-docs.json", "utf8"));
const qvecs = new Map<string, number[]>(
  JSON.parse(fs.readFileSync(".sources/query-vectors.json", "utf8")).map((r: any) => [r.query, r.vector]),
);
const index = buildBm25Index(chunks);

// ── 1. 방어 로직부터 — 모델을 부르지 않고 확인할 수 있는 것 ─────────────
console.log("판정 응답을 읽는 방어 로직\n");
const guards: { 이름: string; 입력: string; 기대: string }[] = [
  { 이름: "정상 JSON", 입력: '{"grounded":true,"noHalluc":true,"cited":true,"refusal":false,"score":88,"comment":"좋음"}', 기대: "score 88" },
  { 이름: "5점 만점으로 답함", 입력: '{"grounded":true,"noHalluc":true,"cited":true,"refusal":false,"score":4,"comment":"좋음"}', 기대: "80 으로 환산" },
  { 이름: "코드펜스로 감쌈", 입력: '```json\n{"grounded":false,"noHalluc":true,"cited":false,"refusal":true,"score":50,"comment":"x"}\n```', 기대: "읽어냄" },
  { 이름: "JSON 이 아님", 입력: "판정 결과는 좋습니다.", 기대: "judgeError" },
  { 이름: "필드가 빠짐", 입력: '{"grounded":true,"score":90}', 기대: "judgeError" },
  { 이름: "score 가 숫자가 아님", 입력: '{"grounded":true,"noHalluc":true,"cited":true,"refusal":false,"score":"높음","comment":"x"}', 기대: "judgeError" },
];
for (const g of guards) {
  const r = parseVerdict(g.입력);
  const got = r.ok
    ? `score ${r.verdict.score}${r.verdict.rawScore !== undefined ? ` (원래 ${r.verdict.rawScore} 에서 환산)` : ""}`
    : `judgeError — ${r.reason}`;
  console.log(`  ${g.이름.padEnd(18)} 기대: ${g.기대.padEnd(14)} 실제: ${got}`);
}

// ── 2. 실제 경로 ────────────────────────────────────────────────────────
const CASES: { q: string; 왜: string; 기대: string }[] = [
  { q: "내일 날씨 어때?", 왜: "무근거 질문 리허설 — 과제가 지정한 문항", 기대: "refusal:true" },
  { q: "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?", 왜: "E 에서 답이 틀렸던 질문", 기대: "grounded:false 로 잡혀야 한다" },
  { q: "제 있템이 지금 몇 개예요?", 왜: "개인 데이터 — 수용 기준 3번", 기대: "refusal:true" },
];

const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;
console.log("\n" + "=".repeat(100));
console.log(`같은 문항을 ${RUNS}회 돌린다 — 한 번의 결과는 그 한 번의 결과일 뿐이다\n`);
const rows: any[] = [];

for (let run = 1; run <= RUNS; run++) {
for (const c of CASES) {
  const qv = qvecs.get(c.q);
  if (!qv) { console.log(`질문 벡터 없음: ${c.q}`); continue; }

  const res = hybridSearch(chunks, index, qv, c.q);
  const prompt = buildPrompt(res.hits, c.q, res.weakEvidence);

  let answer = "";
  const ctrl = new AbortController();
  for await (const piece of streamChat(prompt, ctrl.signal)) answer += piece;

  const outcome = await judge(c.q, res.hits, answer, ctrl.signal);

  console.log(`\n[${run}회차] ${c.q}`);
  console.log(`  왜 넣었나  : ${c.왜}`);
  console.log(`  근거       : ${res.hits.length}개 · 최고 유사도 ${res.topScore.toFixed(3)} · 약한 근거 ${res.weakEvidence ? "예" : "아니오"}`);
  console.log(`  답변 핵심  : ${answer.replace(/\s+/g, " ").slice(0, 160)}…`);
  console.log(`  답변 길이  : ${answer.length}자 · [ID] 표기 ${(answer.match(/\[AG-\d+/g) ?? []).length}회`);
  // cited 는 판정 필드 중 유일하게 모델 없이 확인할 수 있다.
  // 답변에 [AG-…] 표기가 있는지 세면 끝이다. 판정이 여기서 틀리면
  // 나머지 필드(grounded·noHalluc)도 그만큼 믿기 어렵다.
  const citedActual = /\[AG-\d+/.test(answer);

  if (outcome.ok) {
    const v = outcome.verdict;
    console.log(`  판정 배지  : grounded=${v.grounded} noHalluc=${v.noHalluc} cited=${v.cited} refusal=${v.refusal} score=${v.score}${v.rawScore !== undefined ? ` (원래 ${v.rawScore})` : ""}`);
    console.log(`  평어       : ${v.comment}`);
    console.log(`  기대       : ${c.기대}`);
    console.log(`  cited 대조 : 판정 ${v.cited} vs 실제 ${citedActual} → ${v.cited === citedActual ? "일치" : "⚠️ 판정이 틀렸다"}`);
  } else {
    console.log(`  판정       : judgeError — ${outcome.reason}`);
    if (outcome.raw) console.log(`  응답 원문  : ${outcome.raw}`);
  }

  rows.push({
    run, question: c.q, why: c.왜, expect: c.기대,
    hits: res.hits.length, topScore: +res.topScore.toFixed(4), weakEvidence: res.weakEvidence,
    answer, answerLen: answer.length,
    idMarks: (answer.match(/\[AG-\d+/g) ?? []).length,
    citedActual,
    verdict: outcome.ok ? outcome.verdict : null,
    citedAgrees: outcome.ok ? outcome.verdict.cited === citedActual : null,
    judgeError: outcome.ok ? null : outcome.reason,
  });
}
}

const judged = rows.filter((r) => r.verdict);
const agree = judged.filter((r) => r.citedAgrees).length;
console.log("\n" + "=".repeat(100));
console.log(`cited 대조 — 판정이 기계로 확인 가능한 항목에서 맞았는가 : ${agree}/${judged.length}`);
for (const r of judged.filter((r) => !r.citedAgrees)) {
  console.log(`  ⚠️ ${r.run}회차 "${r.question}" — 답변에 [AG-…] 표기가 ${r.idMarks}개인데 판정은 cited=${r.verdict.cited}`);
}

// 같은 질문을 여러 번 돌렸을 때 판정이 흔들리는가
console.log("\n문항별 흔들림 — 회차마다 판정이 같은가");
for (const c of CASES) {
  const mine = judged.filter((r) => r.question === c.q);
  const f = (k: string) => [...new Set(mine.map((r) => String(r.verdict[k])))].join("/");
  console.log(`  "${c.q.slice(0, 26)}"`);
  console.log(`    grounded ${f("grounded")} · noHalluc ${f("noHalluc")} · cited ${f("cited")} · refusal ${f("refusal")} · score ${[...new Set(mine.map((r) => r.verdict.score))].join("/")}`);
  console.log(`    답변 길이 ${mine.map((r) => r.answerLen).join(" / ")}자 · [AG-…] 표기 ${mine.map((r) => r.idMarks).join(" / ")}회`);
}

fs.writeFileSync("data/judge-result.json", JSON.stringify(rows, null, 2) + "\n");
console.log(`\n기록: data/judge-result.json`);
