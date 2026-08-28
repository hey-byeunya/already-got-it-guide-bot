// 프롬프트 조립.
//
// 순서를 고정한다 — 소개 → 근거 원칙 → (약한 근거일 때 보수화) → [ID] 표시 요구
// → KST 현재 시각 → [자료] → [질문].
// 자료를 먼저 두고 질문을 마지막에 두는 이유는, 모델이 질문을 읽는 시점에
// 근거가 이미 앞에 있어야 그 안에서 답을 찾기 때문이다.

import type { Hit } from "./search.ts";

/** 상대 표현("지금", "올해")을 해석할 기준 시각. */
export function kstNow(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "long",
    timeStyle: "short",
  }).format(now);
}

export function buildPrompt(hits: Hit[], question: string, weakEvidence: boolean, now?: Date): string {
  const lines: string[] = [];

  // 1. 소개 — 이 자료가 무엇인지
  lines.push(
    "다음 자료는 개인용 재고 관리 웹앱 '이미 있어'의 공개 문서에서 뽑은 조각입니다.",
  );

  // 2. 근거 원칙 — 자료 밖 질문 처리 기준(PRD 5절)을 그대로 옮긴다
  lines.push(
    "자료에 있는 내용만으로 답합니다. 자료에 없는 것은 그럴듯하게 넓혀 말하지 말고, 자료 범위 밖이라고 밝힌 뒤 답할 수 없다고 안내합니다.",
    "이 챗봇은 이용 방법을 안내합니다. 사용자 개인의 데이터(내 물건 개수 등)를 조회하거나, 값이 규칙을 통과하는지 판정하거나, 상태를 대신 바꾸지 않습니다. 그런 요청에는 범위 밖임을 밝히고 화면 경로만 안내합니다.",
    "규칙이 적힌 문장을 보여 줄 수는 있지만 \"그 값은 통과합니다 / 거부됩니다\"라고 판정해 말하지 않습니다.",
  );

  // 3. 약한 근거 — 0.55 미만일 때만 넣는다
  if (weakEvidence) {
    lines.push(
      "주의: 검색된 조각의 유사도가 낮습니다. 근거에 있는 내용만 짧게 답하고 자료에 없는 부분은 없다고 말합니다.",
    );
  }

  // 4. [ID] 표시 요구
  lines.push("근거가 된 조각의 [ID]를 답 안에서 표시합니다. 예: [AG-004]");

  // 5. 시간 맥락
  lines.push(`현재 시각은 ${kstNow(now)}입니다. '지금', '올해' 같은 상대 표현은 이 시각을 기준으로 해석합니다.`);

  // 6. 자료
  lines.push("", "[자료]");
  for (const h of hits) {
    lines.push(`[${h.chunk.id} | ${h.chunk.section}] ${h.chunk.text}`);
  }

  // 7. 질문
  lines.push("", "[질문]", question);

  return lines.join("\n");
}
