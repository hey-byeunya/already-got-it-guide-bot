// 호출 전 검사 시험 — 막아야 할 것과 막으면 안 되는 것.
//
//   node scripts/check_gate.ts
//
// 게이트에서 가장 위험한 것은 오탐이다. 답할 수 있는 질문을 막아 버리면
// 사용자는 이유도 모른 채 답을 못 받는다. 그래서 통과해야 할 질문을
// 막아야 할 질문보다 많이 넣었다.

import fs from "node:fs";
import { checkBeforeCall } from "../app/src/lib/gate.ts";

type Case = { q: string; block: boolean; 왜: string };

const CASES: Case[] = [
  // ── 막아야 한다 ─────────────────────────────────────────────
  { q: "제 있템이 지금 몇 개예요?", block: true, 왜: "수용 기준 3번 — G 에서 참·거짓·참으로 흔들렸다" },
  { q: "내 위시 목록 보여줘", block: true, 왜: "개인 데이터 조회" },
  { q: "제 쓴템이 몇 건인지 알려줘", block: true, 왜: "개인 데이터 조회" },
  { q: "내 물건 중에 기한 지난 게 뭐가 있어?", block: true, 왜: "개인 데이터 조회" },
  { q: "비밀번호 재설정 메일 좀 보내줘", block: true, 왜: "계정 대행" },
  { q: "닉네임 바꿔줘", block: true, 왜: "계정 대행" },
  { q: "내 위시에 있는 로션 있템으로 옮겨줘", block: true, 왜: "상태 변경 대행" },
  { q: "있템 전부 삭제해", block: true, 왜: "상태 변경 대행" },

  // ── 막으면 안 된다 (루브릭 Q1~Q9) ───────────────────────────
  { q: "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?", block: false, 왜: "Q1 — 방법을 묻는다" },
  { q: "다 쓴 물건은 어디서 볼 수 있어요?", block: false, 왜: "Q2" },
  { q: "회원가입할 때 닉네임은 몇 글자까지예요?", block: false, 왜: "Q3 — 닉네임이 나오지만 규칙 질문" },
  { q: "카테고리를 비워서 등록하면 위시에서 옮겨올 때도 비어 있나요?", block: false, 왜: "Q4" },
  { q: "수량을 0으로 등록할 수 있나요?", block: false, 왜: "Q5" },
  { q: "어제 본 D-day랑 숫자가 다른데 왜 그래요?", block: false, 왜: "Q6" },
  { q: "내일 날씨 어때?", block: false, 왜: "Q7 — 자료 밖이지만 개인 데이터가 아니다. 모델이 거부한다" },
  { q: "제 있템이 지금 몇 개예요?".replace("제 있템이 지금 몇 개예요?", "이 앱 월 구독료가 얼마예요?"), block: false, 왜: "Q9 — 자료 밖이지만 개인 데이터가 아니다" },

  // ── 막으면 안 된다 (경계가 아슬아슬한 것) ────────────────────
  { q: "비밀번호를 잊었는데 어떻게 재설정해요?", block: false, 왜: "계정 낱말이 있지만 방법을 묻는다" },
  { q: "위시 항목을 있템으로 옮기는 방법 알려줘", block: false, 왜: "「알려줘」가 있지만 방법을 묻는다" },
  { q: "쓴템을 되돌리려면 어떻게 해요?", block: false, 왜: "상태 변경이지만 방법 질문" },
  { q: "닉네임은 몇 자까지 되나요?", block: false, 왜: "계정 낱말 + 규칙 질문" },
  { q: "있템 목록은 어떤 순서로 보이나요?", block: false, 왜: "「목록」이 있지만 내 것이 아니다" },
];

console.log(`${"질문".padEnd(46)} ${"기대".padEnd(6)} ${"실제".padEnd(6)} 걸린 규칙`);
console.log("-".repeat(110));

let 오탐 = 0, 미탐 = 0;
const rows: any[] = [];
for (const c of CASES) {
  const r = checkBeforeCall(c.q);
  const ok = r.blocked === c.block;
  if (!ok && r.blocked) 오탐++;
  if (!ok && !r.blocked) 미탐++;
  const mark = ok ? " " : "⚠️";
  console.log(
    `${c.q.padEnd(46)} ${(c.block ? "막음" : "통과").padEnd(6)} ${(r.blocked ? "막음" : "통과").padEnd(6)} ${mark} ${r.blocked ? r.rule : ""}`,
  );
  rows.push({ q: c.q, expect: c.block, actual: r.blocked, ok, rule: r.blocked ? r.rule : null, why: c.왜 });
}

console.log("-".repeat(110));
const 막을것 = CASES.filter((c) => c.block).length;
const 통과할것 = CASES.length - 막을것;
console.log(`막아야 할 ${막을것}개 · 통과해야 할 ${통과할것}개`);
console.log(`⚠️ 오탐(답할 수 있는데 막음) : ${오탐}건   ← 가장 위험한 실패`);
console.log(`⚠️ 미탐(막아야 하는데 통과)   : ${미탐}건`);

fs.writeFileSync("data/gate-result.json", JSON.stringify(rows, null, 2) + "\n");
console.log(`\n기록: data/gate-result.json`);
process.exit(오탐 + 미탐 === 0 ? 0 : 1);
