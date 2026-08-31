// 프롬프트 조립 — 고객센터 상담 답변의 모양을 지시한다.
//
// 순서를 고정한다. 바꾸고 싶은 것은 opts 로 빼서 실험 단계에서만 건드린다 —
// 결과가 마음에 안 든다고 그 자리에서 손대면, 나중에 무엇이 무엇을 바꿨는지
// 알 수 없다.
//
//   소개 → 근거 원칙 → (약한 근거일 때 보수화) → 답변 형식 → 인용 요구
//   → KST 현재 시각 → [도움말] → [고객 질문]
//
// 자료를 먼저 두고 질문을 마지막에 두는 이유는, 모델이 질문을 읽는 시점에
// 근거가 이미 앞에 있어야 그 안에서 답을 찾기 때문이다.

import type { Hit } from "./search.ts";

/** 상대 표현("지금", "오늘")을 해석할 기준 시각. D-day 질문 때문에 필요하다. */
export function kstNow(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "long",
    timeStyle: "short",
  }).format(now);
}

/**
 * 근거 블록. 머리표를 **번호**로 단다.
 *
 * dev-bot 은 `[AG-004 | 주요 기능 — 위시]` 를 썼고, 모델이 답변에 그 표기를
 * 그대로 옮겨 적었다. 고객이 읽을 답변에 내부 식별자가 있으면 그것 자체가
 * 고객센터답지 않다. 번호는 고객이 봐도 되는 형태이고, 프로그램이 세기도 쉽다.
 */
export function evidenceBlock(hits: Hit[]): string {
  return hits
    .map((h, i) => `[${i + 1}] (${h.chunk.doc} · ${h.chunk.section})\n${h.chunk.text}`)
    .join("\n\n");
}

export type PromptOptions = {
  /** 고객센터 답변 형식 지시를 넣을지. 실험 S1 에서 끈다 */
  customerFormat?: boolean;
  /** 인용 요구를 프롬프트 맨 끝(질문 뒤)에 둘지. 실험 S3 */
  citationAtEnd?: boolean;
};

const FORMAT_RULES = [
  "답변은 고객센터 상담 답변처럼 씁니다. 아래 순서를 지킵니다.",
  "1. 첫 줄에 결론을 한 문장으로 답합니다. 인사말이나 사과로 시작하지 않습니다.",
  "2. 화면에서 누를 순서가 있으면 번호 목록으로 안내합니다. 화면과 버튼 이름은 도움말에 적힌 대로 씁니다.",
  "3. 주의할 점이나 예외가 도움말에 있으면 마지막에 덧붙입니다. 없으면 덧붙이지 않습니다.",
  "존댓말로 쓰고, 도움말에 없는 것을 '아마', '보통' 같은 말로 넓히지 않습니다.",
];

const CITATION_RULE = [
  "근거로 삼은 도움말의 번호를 문장 끝에 [1] 처럼 표시합니다. 여러 개면 [1][2] 로 씁니다.",
  "HELP-WISH-02 같은 내부 문서 번호를 답변에 쓰지 않습니다. 대괄호 안의 숫자만 씁니다.",
  "답변 끝에 참고 목록을 직접 만들지 않습니다. 그 목록은 따로 붙습니다.",
];

export function buildPrompt(
  hits: Hit[],
  question: string,
  weakEvidence: boolean,
  now?: Date,
  opts: PromptOptions = {},
): string {
  const { customerFormat = true, citationAtEnd = false } = opts;
  const lines: string[] = [];

  // 1. 소개 — 이 자료가 무엇인지
  lines.push(
    "당신은 개인용 재고 관리 앱 '이미 있어'의 고객센터 상담원입니다.",
    "아래 [도움말]은 이 앱의 공개 도움말 문서에서 가져온 조각입니다. 고객이 직접 열어 읽을 수 있는 문서입니다.",
  );

  // 2. 근거 원칙 — PRD 7절을 그대로 옮긴다
  lines.push(
    "도움말에 있는 내용만으로 답합니다. 도움말에 없는 것은 그럴듯하게 넓혀 말하지 말고, 도움말에서 확인되지 않는다고 밝힌 뒤 답할 수 없다고 안내합니다.",
    "고객 개인의 데이터(내 물건 개수 등)를 조회하거나, 계정·비밀번호를 대신 조작하거나, 데이터를 대신 바꾸지 않습니다. 그런 요청에는 범위 밖임을 밝히고 앱 화면 경로만 안내합니다.",
    "규칙이 적힌 문장을 보여 줄 수는 있지만 \"그 값은 통과합니다 / 거부됩니다\"라고 판정해 말하지 않습니다.",
    "도움말에 '없습니다'라고 적혀 있으면 없다고 답합니다. 이건 거절이 아니라 답입니다.",
  );

  // 3. 약한 근거 — 최고 유사도가 0.55 미만일 때만
  if (weakEvidence) {
    lines.push(
      "주의: 이 질문에 딱 맞는 도움말을 찾지 못했습니다. 아래 근거에 있는 내용만 짧게 답하고, 도움말에서 확인되지 않는 부분은 확인되지 않는다고 말합니다.",
    );
  }

  // 4. 답변 형식
  if (customerFormat) lines.push(...FORMAT_RULES);

  // 5. 인용 요구 (실험 S3 에서 맨 끝으로 옮긴다)
  if (!citationAtEnd) lines.push(...CITATION_RULE);

  // 6. 시간 맥락 — D-day 는 조회 시점에 계산되는 값이라 오늘이 언제인지가 필요하다
  lines.push(`현재 시각은 ${kstNow(now)}입니다. '오늘', '지금' 같은 상대 표현은 이 시각을 기준으로 해석합니다.`);

  // 7. 도움말
  lines.push("", "[도움말]", evidenceBlock(hits));

  // 8. 고객 질문
  lines.push("", "[고객 질문]", question);

  if (citationAtEnd) lines.push("", ...CITATION_RULE);

  return lines.join("\n");
}
