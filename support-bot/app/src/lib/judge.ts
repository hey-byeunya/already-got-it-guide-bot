// 답변을 다시 읽는 두 번째 시선 — LLM-as-a-Judge.
//
// 답을 만든 것과 **같은** qwen3.5:2b 에게 질문·근거·답변을 다시 보내 판정한다.
// 그러므로 이것은 독립 심사가 아니다. 그 한계를 숨기지 않는다.
//
// **dev-bot 과 다른 점: cited 를 여기서 빼냈다.**
// "답변에 출처 표시가 있는가" 는 글자를 찾으면 끝나는 일인데 모델에게 물었고,
// 측정한 실패 108건 중 42건이 그 판정의 실패였다. 지금은 citation.ts 가 센다.
// 여기 남은 셋은 **뜻을 읽어야 하는 것**뿐이다.

import type { Hit } from "./search.ts";
import { evidenceBlock } from "./prompt.ts";
import { chatJson } from "./ollama.ts";

export type Verdict = {
  grounded: boolean;
  noHalluc: boolean;
  refusal: boolean;
  score: number;
  comment: string;
  /** 모델이 5점 만점으로 답해 환산한 경우 원래 값 */
  rawScore?: number;
};

export type JudgeOutcome =
  | { ok: true; verdict: Verdict }
  | { ok: false; reason: string; raw?: string };

export function buildJudgePrompt(question: string, hits: Hit[], answer: string): string {
  // 판정에 보여 주는 근거 표기도 생성 때와 같아야 한다.
  const evidence = evidenceBlock(hits);
  return [
    "당신은 RAG 챗봇 답변의 평가자입니다. 아래 [질문], [근거자료], [답변]을 읽고 다음 기준으로 JSON만 출력합니다.",
    "grounded: 답변 내용이 근거자료에서 나왔는가 (true/false)",
    "noHalluc: 근거에 없는 사실을 지어내지 않았는가 (true/false)",
    "refusal: 근거에 답이 없어서 '없다'고 답한 경우 true, 그 외 false",
    "score: 0-100 정수 (grounded·noHalluc 반영)",
    "comment: 한두 문장 평어 (한국어)",
    '출력 형식: {"grounded":bool,"noHalluc":bool,"refusal":bool,"score":int,"comment":"..."} — JSON 외 텍스트 금지.',
    "",
    `[질문] ${question}`,
    `[근거자료]`,
    evidence,
    `[답변] ${answer}`,
  ].join("\n");
}

/**
 * 모델이 돌려준 문자열을 판정으로 바꾼다.
 *
 * 모델은 간혹 5점 만점처럼 score 를 돌려준다. score 가 5 이하면
 * (score/5)×100 으로 환산하고, 환산했다는 사실을 rawScore 로 남긴다 —
 * 환산을 조용히 하면 나중에 "왜 20점이 400점이 됐나" 를 되짚을 수 없다.
 */
export function parseVerdict(raw: string): JudgeOutcome {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSON 으로 읽을 수 없는 응답", raw: text.slice(0, 200) };
  }
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, reason: "JSON 이지만 객체가 아님", raw: text.slice(0, 200) };
  }
  const o = obj as Record<string, unknown>;
  const need = ["grounded", "noHalluc", "refusal", "score"];
  const missing = need.filter((k) => !(k in o));
  if (missing.length) {
    return { ok: false, reason: `빠진 필드: ${missing.join(", ")}`, raw: text.slice(0, 200) };
  }

  const rawScore = Number(o.score);
  if (!Number.isFinite(rawScore)) {
    return { ok: false, reason: "score 가 숫자가 아님", raw: text.slice(0, 200) };
  }
  // 5점 만점 방어
  const converted = rawScore <= 5;
  const score = Math.round(Math.max(0, Math.min(100, converted ? (rawScore / 5) * 100 : rawScore)));

  return {
    ok: true,
    verdict: {
      grounded: Boolean(o.grounded),
      noHalluc: Boolean(o.noHalluc),
      refusal: Boolean(o.refusal),
      score,
      comment: typeof o.comment === "string" ? o.comment : "",
      ...(converted ? { rawScore } : {}),
    },
  };
}

export async function judge(
  question: string,
  hits: Hit[],
  answer: string,
  signal?: AbortSignal,
): Promise<JudgeOutcome> {
  try {
    const raw = await chatJson(buildJudgePrompt(question, hits, answer), signal);
    return parseVerdict(raw);
  } catch (e) {
    // 판정 호출이 실패해도 답변과 출처는 화면에 그대로 남는다.
    // 판정은 답변을 다시 읽게 돕는 보조 장치이지, 답변이 남을 조건이 아니다.
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
