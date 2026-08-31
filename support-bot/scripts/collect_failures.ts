// 실패한 답을 원자료에서 뽑아 **어느 단계가 원인인지**로 나눈다.
//
//   node scripts/collect_failures.ts
//
// 분류는 사람이 정한 규칙으로 한다. 자동 분류를 모델에게 맡기면 또 하나의
// 못 믿을 판정이 생긴다 — 판정 모델이 기계로 확인 가능한 항목에서도 틀리는 것을
// dev-bot 에서 봤다.
//
// 단계를 나누는 이유: "답이 틀렸다"는 고칠 수 없고, "검색이 엉뚱한 것을 올렸다"나
// "인용 번호를 아무렇게나 붙였다"는 고칠 수 있다.

import fs from "node:fs";
import path from "node:path";

type Row = any;
const dir = "data/rubric";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
const rows: Row[] = files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));

type Kind = { 단계: string; 유형: string; 누가잡나: string; test: (r: Row) => string | null };

const KINDS: Kind[] = [
  // ── 검색 단계 ────────────────────────────────────────────────
  { 단계: "검색", 유형: "기대한 도움말이 근거에 없음", 누가잡나: "프로그램",
    test: (r) => !r.gated && r.expectedDocs?.length && !r.expectedDocs.some((d: string) => r.foundDocs?.includes(d))
      ? `기대 ${r.expectedDocs.join(",")} · 올라온 것 ${(r.foundDocs ?? []).slice(0, 3).join(",")}` : null },

  // ── 생성 단계 ────────────────────────────────────────────────
  { 단계: "생성", 유형: "인용을 아예 하지 않음", 누가잡나: "프로그램",
    test: (r) => !r.gated && r.expect?.answerable && !r.citation?.cited ? `답 ${r.answerLen}자` : null },
  { 단계: "생성", 유형: "없는 번호를 인용 (지어낸 출처)", 누가잡나: "프로그램",
    test: (r) => r.citation?.outOfRange?.length ? `근거 ${r.hits}개인데 [${r.citation.outOfRange.join(",")}]` : null },
  { 단계: "생성", 유형: "근거는 올라왔는데 다른 것을 인용", 누가잡나: "프로그램",
    test: (r) => !r.gated && r.hitRight === false && r.expectedDocs?.some((d: string) => r.foundDocs?.includes(d))
      ? `기대 ${r.expectedDocs.join(",")} · 인용 ${(r.citedDocs ?? []).join(",")}` : null },
  { 단계: "생성", 유형: "내부 문서 ID 노출", 누가잡나: "프로그램",
    test: (r) => r.citation?.leakedIds?.length ? r.citation.leakedIds.join(",") : null },
  { 단계: "생성", 유형: "절차를 물었는데 절차형이 아님", 누가잡나: "프로그램",
    test: (r) => !r.gated && r.expect?.procedural && !r.citation?.procedural
      ? `${r.citation?.stepCount ?? 0}단계 · 답 ${r.answerLen}자` : null },

  // ── 거절 단계 ────────────────────────────────────────────────
  { 단계: "거절", 유형: "도움말 밖인데 답해 버림", 누가잡나: "판정",
    test: (r) => !r.gated && r.expect && !r.expect.answerable && r.verdict?.refusal === false
      ? `${r.verdict.score}점` : null },

  // ── 판정 단계 ────────────────────────────────────────────────
  { 단계: "판정", 유형: "배지와 점수가 다른 말", 누가잡나: "사람",
    test: (r) => r.verdict && r.verdict.noHalluc === false && r.verdict.score >= 80
      ? `noHalluc=false 인데 ${r.verdict.score}점` : null },
  { 단계: "판정", 유형: "형식이 깨진 응답", 누가잡나: "프로그램",
    test: (r) => r.judgeError ?? null },
];

console.log(`원자료 ${rows.length}건 · 세팅 ${files.length}개 (${files.map((f) => f.replace(".json", "")).join(", ")})\n`);
console.log(`${"단계".padEnd(6)} ${"유형".padEnd(34)} ${"건수".padStart(4)} ${"누가".padEnd(6)} 대표 사례`);
console.log("-".repeat(112));

const out: any[] = [];
for (const k of KINDS) {
  const hits = rows.map((r) => ({ r, why: k.test(r) })).filter((x) => x.why);
  const 대표 = hits.slice(0, 2).map((x) => `${x.r.setting}/${x.r.run}회/${x.r.id}`).join(", ");
  console.log(`${k.단계.padEnd(6)} ${k.유형.padEnd(34)} ${String(hits.length).padStart(4)} ${k.누가잡나.padEnd(6)} ${대표}`);
  out.push({
    단계: k.단계, 유형: k.유형, 누가잡나: k.누가잡나, 건수: hits.length,
    사례: hits.map((x) => ({ setting: x.r.setting, run: x.r.run, id: x.r.id, 왜: x.why })),
  });
}
console.log("-".repeat(112));
const 합 = out.reduce((s, o) => s + o.건수, 0);
const 프로그램 = out.filter((o) => o.누가잡나 === "프로그램").reduce((s, o) => s + o.건수, 0);
console.log(`합계 ${합}건 · 그중 ${프로그램}건(${((프로그램 / (합 || 1)) * 100).toFixed(0)}%)은 프로그램이 잡았다`);
console.log("한 답이 여러 유형에 걸릴 수 있어 합계가 원자료 건수보다 클 수 있다.");

fs.writeFileSync("data/failures.json", JSON.stringify(out, null, 2) + "\n");
console.log("\n기록: data/failures.json — 사례마다 세팅·회차·문항이 있어 원자료로 되짚을 수 있다");
