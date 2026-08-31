// 호출 전 검사 시험 — 막아야 할 것과 막으면 안 되는 것.
//
//   node scripts/check_gate.ts
//
// 게이트에서 가장 위험한 것은 **답할 수 있는 질문을 막는 것**이다. 고객은 이유도
// 모른 채 답을 못 받는다. 그래서 통과해야 할 질문을 막아야 할 질문보다 많이 넣는다.
//
// 규칙(정규식)은 dev-bot 에서 그대로 가져왔다. 답변 문구만 고객센터 말투로 바꿨으므로,
// **여기서 확인할 것은 말투를 바꾸면서 규칙을 건드리지 않았는가**다.

import fs from "node:fs";
import { checkBeforeCall } from "../app/src/lib/gate.ts";

type Case = { q: string; block: boolean; 왜: string };

const CASES: Case[] = [
  // ── 막아야 한다 (PRD 6절 비목표) ────────────────────────────
  { q: "제 있템이 지금 몇 개예요?", block: true, 왜: "평가 세트 C14 — 개인 데이터 조회" },
  { q: "내 위시 목록 보여줘", block: true, 왜: "개인 데이터 조회" },
  { q: "제 쓴템이 몇 건인지 알려줘", block: true, 왜: "개인 데이터 조회" },
  { q: "내 물건 중에 기한 지난 게 뭐가 있어?", block: true, 왜: "개인 데이터 조회" },
  { q: "비밀번호 재설정 메일 좀 보내줘", block: true, 왜: "평가 세트 C15 — 계정 대행" },
  { q: "닉네임 바꿔줘", block: true, 왜: "계정 대행" },
  { q: "내 위시에 있는 로션 있템으로 옮겨줘", block: true, 왜: "상태 변경 대행" },
  { q: "있템 전부 삭제해", block: true, 왜: "상태 변경 대행" },

  // ── 막으면 안 된다 (평가 세트 C01~C13) ──────────────────────
  { q: "위시에 담아둔 걸 샀는데 어떻게 있템으로 옮겨요?", block: false, 왜: "C01 — 방법을 묻는다" },
  { q: "다 쓴 물건은 어디서 볼 수 있어요?", block: false, 왜: "C02" },
  { q: "쓴템을 되돌리려면 어떻게 해요?", block: false, 왜: "C03 — 상태 변경이지만 방법 질문" },
  { q: "비밀번호를 잊었는데 어떻게 재설정해요?", block: false, 왜: "C04 — 계정 낱말 + 방법 질문. C15 와 낱말이 겹친다" },
  { q: "있템은 어떻게 등록해요?", block: false, 왜: "C05" },
  { q: "회원가입할 때 닉네임은 몇 글자까지예요?", block: false, 왜: "C06 — 닉네임이 나오지만 규칙 질문" },
  { q: "D-day 배지 색깔이 무슨 뜻이에요?", block: false, 왜: "C07" },
  { q: "유통기한 알림이 오나요?", block: false, 왜: "C08 — 없는 기능. 도움말을 근거로 없다고 답해야 한다" },
  { q: "카테고리는 꼭 넣어야 하나요? 위시에서 옮겨올 때도 그런가요?", block: false, 왜: "C09" },
  { q: "수량을 0으로 등록할 수 있나요? 위시에서 옮기면 수량은 어떻게 돼요?", block: false, 왜: "C10" },
  { q: "어제 본 D-day랑 숫자가 다른데 왜 그래요?", block: false, 왜: "C11" },
  { q: "내일 날씨 어때?", block: false, 왜: "C12 — 자료 밖이지만 개인 데이터가 아니다. 모델이 거절한다" },
  { q: "고객센터 전화번호가 어떻게 되나요?", block: false, 왜: "C13 — 자료 밖이지만 낱말로 막을 수 없다" },

  // ── 막으면 안 된다 (경계가 아슬아슬한 것) ────────────────────
  { q: "위시 항목을 있템으로 옮기는 방법 알려줘", block: false, 왜: "「알려줘」가 있지만 방법을 묻는다" },
  { q: "닉네임은 몇 자까지 되나요?", block: false, 왜: "계정 낱말 + 규칙 질문" },
  { q: "있템 목록은 어떤 순서로 보이나요?", block: false, 왜: "「목록」이 있지만 내 것이 아니다" },
  { q: "다 쓴 것도 보기 체크박스는 어디 있어요?", block: false, 왜: "「보기」가 있지만 화면 위치 질문" },
  { q: "위시에 담은 물건도 검색되나요?", block: false, 왜: "「위시」 + 「물건」 이지만 기능 질문" },
];

console.log(`${"질문".padEnd(50)} ${"기대".padEnd(6)} ${"실제".padEnd(6)} 걸린 규칙`);
console.log("-".repeat(112));

let 오탐 = 0, 미탐 = 0;
const rows: unknown[] = [];
for (const c of CASES) {
  const r = checkBeforeCall(c.q);
  const ok = r.blocked === c.block;
  if (!ok && r.blocked) 오탐++;
  if (!ok && !r.blocked) 미탐++;
  console.log(
    `${c.q.padEnd(50)} ${(c.block ? "막음" : "통과").padEnd(6)} ${(r.blocked ? "막음" : "통과").padEnd(6)} ${ok ? " " : "⚠️"} ${r.blocked ? r.rule : ""}`,
  );
  rows.push({ q: c.q, expect: c.block, actual: r.blocked, ok, rule: r.blocked ? r.rule : null, why: c.왜 });
}

const 막아야 = CASES.filter((c) => c.block).length;
console.log("-".repeat(112));
console.log(`통과해야 할 질문 ${CASES.length - 막아야}개 · 막아야 할 질문 ${막아야}개`);
console.log(`잘못 막음(오탐) ${오탐}건 · 놓침(미탐) ${미탐}건`);
console.log(오탐 === 0 && 미탐 === 0 ? "\n수용 기준 통과 — 오탐 0, 미탐 0" : "\n수용 기준 실패");

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/gate-result.json", JSON.stringify(rows, null, 2));
process.exit(오탐 === 0 && 미탐 === 0 ? 0 : 1);
