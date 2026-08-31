// 인용 계수 시험 — 프로그램이 제대로 세는가.
//
//   node scripts/check_citation.ts
//
// 이 검사가 필요한 이유. dev-bot 은 "출처를 밝혔는가" 를 판정 모델에게 물었고
// 실패 108건 중 42건이 그 판정의 실패였다. 그 일을 프로그램으로 옮겼으니,
// **옮겨 온 쪽이 맞는지는 이제 우리 책임이다.** 세는 법이 틀리면 모든 지표가 틀린다.

import fs from "node:fs";
import { checkCitations } from "../app/src/lib/citation.ts";

type Case = {
  이름: string;
  answer: string;
  hits: number;
  기대: { cited: boolean; numbers: number[]; outOfRange: number[]; leaked: number; procedural: boolean };
};

const CASES: Case[] = [
  { 이름: "한 개 인용", answer: "위시 목록에서 옮기실 수 있습니다 [1].", hits: 3,
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "붙여 쓴 여러 개", answer: "옮기실 수 있습니다 [1][2].", hits: 3,
    기대: { cited: true, numbers: [1, 2], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "쉼표로 묶은 것", answer: "그렇습니다 [1, 3].", hits: 3,
    기대: { cited: true, numbers: [1, 3], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "인용 없음", answer: "위시 목록에서 옮기시면 됩니다.", hits: 3,
    기대: { cited: false, numbers: [], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "지어낸 번호만", answer: "그렇습니다 [7].", hits: 3,
    기대: { cited: false, numbers: [7], outOfRange: [7], leaked: 0, procedural: false } },

  { 이름: "진짜 + 지어낸 것 섞임", answer: "옮기실 수 있습니다 [1]. 수량은 1이 됩니다 [9].", hits: 3,
    기대: { cited: true, numbers: [1, 9], outOfRange: [9], leaked: 0, procedural: false } },

  { 이름: "내부 ID 노출", answer: "HELP-WISH-02 에 따르면 옮기실 수 있습니다 [1].", hits: 3,
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 1, procedural: false } },

  { 이름: "절차형", hits: 3,
    answer: "위시 목록에서 옮기실 수 있습니다 [1].\n1. 위시 탭을 엽니다.\n2. 「샀어요 · 있템으로」를 누릅니다.",
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 0, procedural: true } },

  { 이름: "한 줄에 이어 쓴 단계 (실제로 본 것)", hits: 3,
    answer: "1. 우선 위시 목록을 엽니다. 2. 옮길 물건 카드에서 「샀어요 · 있템으로」를 누르세요.[1]",
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 0, procedural: true } },

  { 이름: "번호는 있는데 화면 이름이 없음", hits: 3,
    answer: "그렇습니다 [1].\n1. 첫째로 확인합니다.\n2. 둘째로 확인합니다.",
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "한 단계뿐 — 절차형 아님", hits: 3,
    answer: "위시 탭에서 하실 수 있습니다 [1].\n1. 「샀어요 · 있템으로」를 누릅니다.",
    기대: { cited: true, numbers: [1], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "마크다운 링크를 인용으로 세지 않는다", hits: 3,
    answer: "자세한 것은 [도움말](https://example.com)을 보세요.",
    기대: { cited: false, numbers: [], outOfRange: [], leaked: 0, procedural: false } },

  { 이름: "0 은 범위 밖", answer: "그렇습니다 [0].", hits: 3,
    기대: { cited: false, numbers: [0], outOfRange: [0], leaked: 0, procedural: false } },
];

const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

console.log(`${"경우".padEnd(34)} 결과`);
console.log("-".repeat(78));

let bad = 0;
const rows: unknown[] = [];
for (const c of CASES) {
  const r = checkCitations(c.answer, c.hits);
  const ok =
    r.cited === c.기대.cited &&
    eq(r.numbers, c.기대.numbers) &&
    eq(r.outOfRange, c.기대.outOfRange) &&
    r.leakedIds.length === c.기대.leaked &&
    r.procedural === c.기대.procedural;
  if (!ok) bad++;
  console.log(`${c.이름.padEnd(34)} ${ok ? "통과" : "실패 ⚠️"}`);
  if (!ok) {
    console.log(`    기대: cited=${c.기대.cited} numbers=[${c.기대.numbers}] 범위밖=[${c.기대.outOfRange}] 노출=${c.기대.leaked} 절차형=${c.기대.procedural}`);
    console.log(`    실제: cited=${r.cited} numbers=[${r.numbers}] 범위밖=[${r.outOfRange}] 노출=${r.leakedIds.length} 절차형=${r.procedural}`);
  }
  rows.push({ 이름: c.이름, ok, 기대: c.기대, 실제: r });
}

console.log("-".repeat(78));
console.log(`${CASES.length - bad}/${CASES.length} 통과${bad ? ` · ${bad}건 실패` : ""}`);
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/citation-check.json", JSON.stringify(rows, null, 2));
process.exit(bad === 0 ? 0 : 1);
