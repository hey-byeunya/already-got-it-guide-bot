// 브라우저에서 질문을 768차원 벡터로 바꾼다.
//
// 문서 벡터를 만든 scripts/embed-docs-browser-path.mjs 와 **같은 경로**여야 한다 —
// 같은 모델 파일, 같은 실행(wasm), 같은 mean pooling, 같은 L2 정규화.
// 하나라도 다르면 두 벡터가 다른 공간에 놓여 코사인 점수가 뜻을 잃는다.
//
// pipeline() 을 그대로 부르지 않는 이유: 기본 q4/q8 경로가 WASM ONNX Runtime 의
// GatherBlockQuantized 연산을 지원하지 않아 실패한다. 토크나이저는 AutoTokenizer,
// 추론은 model_no_gather_q4.onnx 를 ort 세션에 직접 넘겨 역할을 나눈다.

import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const MODEL_URL = `${BASE}/onnx/model_no_gather_q4.onnx`;
const DATA_URL = `${BASE}/onnx/model_no_gather_q4.onnx_data`;
const CACHE_NAME = "already-got-it-guide-bot:models:v1";
export const DIM = 768;

export type Progress = { stage: string; detail?: string; cached?: boolean };

/**
 * 모델 파일을 받아 온다. Hugging Face 의 resolve 주소는 서명된 CDN 주소로
 * 리다이렉트되기 때문에 HTTP 캐시만으로는 적중이 불안정하다. 그래서 **원래 주소를
 * 키로 삼아** Cache Storage 에 직접 넣는다.
 *
 * Cache Storage 는 사생활 보호 모드나 저장 공간 부족으로 실패할 수 있다.
 * 한 번 다시 시도하고, 그래도 안 되면 캐시 없이 내려받기를 계속한다 —
 * 캐시는 빠르게 하려는 장치이지 없으면 못 쓰는 조건이 아니다.
 */
async function fetchCached(url: string, onProgress?: (p: Progress) => void): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.({ stage: "모델 불러오는 중", detail: "이미 받아 둔 것을 씁니다", cached: true });
        return await hit.arrayBuffer();
      }
      onProgress?.({ stage: "모델 내려받는 중", detail: "처음 한 번만 받습니다", cached: false });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      await cache.put(url, res.clone());
      return await res.arrayBuffer();
    } catch {
      if (attempt === 1) break;
    }
  }
  // 캐시 경로가 두 번 다 실패했다 — 캐시 없이 그냥 받는다
  onProgress?.({ stage: "모델 내려받는 중", detail: "캐시를 쓸 수 없어 매번 받습니다", cached: false });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`모델을 받지 못했습니다 (${res.status})`);
  return await res.arrayBuffer();
}

let ready: Promise<{ tokenizer: PreTrainedTokenizer; session: ort.InferenceSession }> | null = null;

export function loadEmbedder(onProgress?: (p: Progress) => void) {
  if (ready) return ready;
  ready = (async () => {
    onProgress?.({ stage: "토크나이저 준비 중" });
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

    const model = await fetchCached(MODEL_URL, onProgress);
    const data = await fetchCached(DATA_URL, onProgress);

    onProgress?.({ stage: "모델 여는 중", detail: "처음에는 몇 초 걸립니다" });
    const session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ["wasm"],
      externalData: [{ path: "model_no_gather_q4.onnx_data", data: new Uint8Array(data) }],
    });

    onProgress?.({ stage: "준비 끝" });
    return { tokenizer, session };
  })();
  return ready;
}

/** 문장 하나를 768차원 벡터로. mean pooling + L2 정규화. */
export async function embed(text: string, onProgress?: (p: Progress) => void): Promise<number[]> {
  const { tokenizer, session } = await loadEmbedder(onProgress);
  const enc = await tokenizer(text, { add_special_tokens: true });

  const ids = BigInt64Array.from(Array.from(enc.input_ids.data as ArrayLike<number | bigint>, (v) => BigInt(v)));
  const mask = BigInt64Array.from(Array.from(enc.attention_mask.data as ArrayLike<number | bigint>, (v) => BigInt(v)));
  const len = ids.length;

  const feeds: Record<string, ort.Tensor> = {};
  for (const name of session.inputNames) {
    if (name === "input_ids") feeds[name] = new ort.Tensor("int64", ids, [1, len]);
    else if (name === "attention_mask") feeds[name] = new ort.Tensor("int64", mask, [1, len]);
  }

  const out = await session.run(feeds);
  const hidden = out["last_hidden_state"];
  const [, seq, dim] = hidden.dims as number[];
  if (dim !== DIM) throw new Error(`차원이 ${dim} 입니다. ${DIM} 이어야 합니다`);

  // attention_mask 가 가리키는 실제 토큰만 평균 — 패딩이 문장 표현에 섞이지 않게
  const h = hidden.data as Float32Array;
  const v = new Float64Array(dim);
  let n = 0;
  for (let t = 0; t < seq; t++) {
    if (mask[t] === 0n) continue;
    n++;
    for (let d = 0; d < dim; d++) v[d] += h[t * dim + d];
  }
  for (let d = 0; d < dim; d++) v[d] /= n;

  // L2 정규화 — 정규화된 벡터끼리는 내적이 곧 코사인 유사도다
  let sum = 0;
  for (let d = 0; d < dim; d++) sum += v[d] * v[d];
  const norm = Math.sqrt(sum) || 1;
  return Array.from(v, (x) => x / norm);
}
