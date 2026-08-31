// 사용자 컴퓨터의 Ollama 를 부른다.
//
// 이 페이지가 배포되어 있어도 답을 만드는 것은 서버가 아니다. 페이지를 연
// 사람의 브라우저가 그 사람 컴퓨터의 localhost:11434 를 직접 부른다.
// 그래서 Ollama 가 켜져 있어야 하고, OLLAMA_ORIGINS 에 이 페이지 주소가
// 허용되어 있어야 한다.

export const OLLAMA = "http://localhost:11434";
export const MODEL = "qwen3.5:2b";

export type Connection =
  | { state: "확인 중" }
  | { state: "연결됨"; models: string[]; hasModel: boolean }
  | { state: "연결 안 됨"; reason: string };

/** 채팅을 시작하기 전에 상태를 확인한다. 모델이 꺼진 상황을 생성 실패처럼 보이지 않게 하려는 것. */
export async function checkConnection(): Promise<Connection> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { cache: "no-store" });
    if (!res.ok) return { state: "연결 안 됨", reason: `Ollama 가 ${res.status} 로 답했습니다` };
    const data = await res.json();
    const models: string[] = (data.models ?? []).map((m: { name: string }) => m.name);
    return { state: "연결됨", models, hasModel: models.some((m) => m.startsWith(MODEL.split(":")[0])) };
  } catch {
    // fetch 자체가 실패한 경우다 — Ollama 가 꺼져 있거나 이 주소가 허용되지 않았다.
    // 브라우저는 둘을 구별해 알려 주지 않으므로 둘 다 안내한다.
    return {
      state: "연결 안 됨",
      reason: "브라우저가 이 컴퓨터의 Ollama 에 닿지 못했습니다. 꺼져 있거나, 이 페이지 주소가 허용 목록에 없습니다.",
    };
  }
}

/**
 * 답을 스트리밍으로 받는다. 응답은 줄바꿈으로 구분된 JSON 조각이라
 * ReadableStream 을 줄 단위로 잘라 읽는다.
 */
export async function* streamChat(
  prompt: string,
  signal: AbortSignal,
  /** G 의 실험용. 기본은 지정하지 않음 — 명세가 생성 온도를 정하지 않았다 */
  opts?: { temperature?: number },
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      think: false,
      ...(opts?.temperature !== undefined ? { options: { temperature: opts.temperature } } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama 가 ${res.status} 로 답했습니다`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const piece = obj?.message?.content;
        if (piece) yield piece;
        if (obj?.done) return;
      } catch {
        // 잘린 줄은 다음 덩어리와 이어 붙는다. 여기서 버리지 않는다.
      }
    }
  }
}

/** 판정용 한 번 호출 — 스트리밍하지 않고 JSON 만 받는다. F단계에서 쓴다. */
export async function chatJson(prompt: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      format: "json",
      options: { temperature: 0 },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`판정 호출이 ${res.status} 로 실패했습니다`);
  const data = await res.json();
  return data?.message?.content ?? "";
}
