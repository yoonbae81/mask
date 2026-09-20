# Mask

민감정보 비식별화 LLM 리버스 프록시. 로컬에서만 동작하는 단일 사용자용 도구로,
Claude Code·OpenClaw·VS Code 확장 등이 외부 LLM API로 보내는 요청에서 민감한 용어를
`<PROJECT_1A>` 형태의 토큰으로 치환하고, 응답에 돌아온 토큰을 원문으로 복원한다.

Mask은 LLM 게이트웨이(사용량 관리·인증·과금)가 아니다. 경계선 하나만 담당한다.

## 왜 필요한가

Claude Code, OpenClaw 같은 도구는 민감한 정보가 담긴 문서·코드·대화 내용을 그대로 프롬프트에 담아
외부 LLM API로 보낸다. 조직명·프로젝트명·발주처명 같은 민감한 용어가 매 요청마다 그대로
노출되는데, 클라이언트를 하나하나 고치는 대신 **경로 중간에서 한 번만 걸러내는** 편이
안전하고 관리하기 쉽다. Mask은 클라이언트가 향하는 API 엔드포인트 자리에 대신 앉아서,
클라이언트 입장에서는 base URL 하나만 바꾸면 끝나는 투명한 프록시로 동작한다.

## 아키텍처

Mask은 HTTP 홉 위에 앉는다. 클라이언트가 CLI(claude, codex 등)를 실행하는 일에는 관여하지
않는다 — 그 CLI가 만든 HTTP 요청이 Mask을 거치도록 base URL만 바꾼다.

```text
① OpenClaw ─ custom/* (OpenAI-compatible) ──▶ Mask ─▶ api.example.com
     OpenClaw가 자기 도구 루프를 돌리는 경로. tools 배열이 HTTP로 흐른다.

② OpenClaw ─ anthropic/* (claude-cli 런타임)
              └─▶ [claude CLI] ─────────────▶ Mask ─▶ api.anthropic.com
     OpenClaw가 claude CLI를 띄우고, CLI가 자기 OAuth로 호출하는 경로.
     CLI가 도구로 읽은 로컬 파일 내용도 같은 HTTP 경로로 흐르므로 자동으로 마스킹된다.

③ VS Code Claude Extension ─────────────────▶ Mask ─▶ api.anthropic.com
```

Mask은 같은 dialect로 갈 때는 요청/응답의 **형식과 구조를 바꾸지 않는다.** JSON 안의
텍스트 값만 치환하므로 `tool_use`·`tool_result`·`tools` 정의가 그대로 보존되고, 에이전트
클라이언트가 아무 제약 없이 동작한다. 폴백 provider가 반대 dialect(Claude ↔ OpenAI)일 때만
형식을 자동 번역한다 — 아래 "크로스 다이얼렉트 폴백" 참조.

```text
클라이언트 요청
  │
  ├─ 1. 경로로 dialect 판정 (/v1/messages → Anthropic, /v1/chat/completions → OpenAI)
  ├─ 2. 요청 JSON을 재귀 순회하며 민감 용어를 토큰으로 치환
  ├─ 3. 직렬화된 본문을 한 번 더 스캔 — 활성 용어가 남아 있으면 502, 업스트림 호출 자체를 안 함
  ├─ 4. 선택된 provider의 실제 엔드포인트로 전달 (실패 시 fallback — dialect 이간 시 자동 번역)
  ├─ 5. 응답 수신 (스트리밍이면 SSE 이벤트 단위로 재조립·번역)
  └─ 6. 토큰을 원문으로 복원해 클라이언트에 반환
```

원문이 Mask 밖으로 나가는 지점은 4단계 하나뿐이고, 그 앞에서 치환과 재검사가 모두
끝난다.

## 빠른 시작

```bash
git clone <repo> mask && cd mask
npm install

cp .env.sample .env
cp config/terms.example.yaml config/terms.yaml
cp config/providers.example.yaml config/providers.yaml
# .env, config/terms.yaml, config/providers.yaml 을 실제 값으로 수정

npm start
```

기동에 성공하면 활성 보호 대상과 provider 상태를 요약한 배너가 출력된다(용어 원문은
찍히지 않는다):

```text
Mask 0.1.0

  TERMS      : config/terms.yaml (mtime 2026-09-16 13:40)
  PROVIDERS  : config/providers.yaml

  Recognizers
    INTERNAL   :  3 terms
    PROJECT    :  2 terms (1 commented out)
    CUSTOMER   :  2 terms
  Total protected terms: 7

  Providers  (active: anthropic)
  ▶ anthropic     passthrough
                    anthropic  https://api.anthropic.com
    openai        passthrough
                    openai     https://api.openai.com
    custom_llm    api_key(CUSTOM_LLM_KEY) OK
                    openai     https://api.example.com/v1
  fallback: (none)

  Listening on http://127.0.0.1:8787
```

`MASK_TERMS_FILE`/`MASK_PROVIDERS_FILE`이 가리키는 파일이 없으면 기동 자체가 실패한다
— 민감어 파일을 못 읽은 채 조용히 평문을 통과시키는 것이 최악의 실패 모드이기 때문에,
의도적으로 기본 경로 폴백을 두지 않았다.

## 설정

세 곳 모두 코드에 하드코딩된 경로 없이 전부 외부 파일과 환경변수로 관리한다.

### 환경변수 (`.env`)

```dotenv
# ── 필수 ────────────────────────────────────────────────
MASK_TERMS_FILE=/path/to/terms.yaml       # 파일 1개 또는 디렉터리(*.yaml 전부 병합)
MASK_PROVIDERS_FILE=/path/to/providers.yaml

# ── 서버 ────────────────────────────────────────────────
MASK_HOST=127.0.0.1
MASK_PORT=8787

# ── 동작 ────────────────────────────────────────────────
MASK_STREAMING_MODE=rolling       # rolling | buffer
MASK_FAIL_CLOSED=true
MASK_GUARD=on                     # 송신 직전 재스캔. 끄지 말 것
MASK_TERM_ESCAPE=off              # \용어 1회성 마스킹 우회 허용 (아래 terms.yaml 절 참고)
MASK_UPSTREAM_TIMEOUT=600         # 초 단위
MASK_MAX_BODY_BYTES=33554432      # 32MB, Fastify bodyLimit 으로 그대로 전달

# ── 로깅 ────────────────────────────────────────────────
MASK_LOG_LEVEL=info
MASK_ALLOW_UNSAFE_LOGGING=false   # 디버깅 전용. 운영 중 true 금지

# ── provider API 키 ─────────────────────────────────────
CUSTOM_LLM_KEY=
```

### `terms.yaml` — 무엇을 가릴지

```yaml
INTERNAL:
  - 알파테크
  - 알파
  - ALPHATECH

PROJECT:
  - Project 오로라
  # - 프로젝트 타이탄      ← 주석 처리 = 이번엔 마스킹하지 않고 그대로 노출
  - 프로젝트 네뷸라

CUSTOMER:
  - OMEGA
  - CORP
```

- **분류명은 대문자 한 단어**(`^[A-Z][A-Z0-9_]*$`). 위반 시 기동 실패.
- **항목을 주석 처리하면 그 용어는 마스킹하지 않는다** — 조사 목적의 일시적 노출용. 몇 개가
  주석 처리돼 있는지 기동 배너에 표시되므로 켜둔 채 잊어버릴 위험이 낮다.
- 2글자 이하 짧은 용어는 과탐(예: `알파`가 `글로벌알파`에도 걸림)이 늘어날 수 있는데, 이건
  의도된 동작이다 — 아래 "왜 과탐을 허용하는가" 참조. 특정 용어만 엄격하게 만들고 싶으면:

  ```yaml
  INTERNAL:
    - 알파테크
    - term: 알파
      boundary: strict      # 왼쪽에 한글이 붙으면 매칭하지 않음(미탐 위험을 감수하는 선언)
  ```

- 정규식 패턴도 임직원 이름도 같은 파일에서 지원하며, 한 분류에 용어와 패턴을 함께
  모을 수 있다:

  ```yaml
  PII:                   # 개인식별정보 — 이름(terms) + 형식 패턴(patterns)을 한 분류에 통합
    terms:               # 임직원 이름 — deny-list 로 확정 처리
      - 홍길동
      - 김철수
    patterns:            # 전화번호·주민번호·사업자번호·이메일·사번 등 — 체크섬 없이 형식만 본다
      - '\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b'
      - '\b\d{6}[-\s]?[1-4]\d{6}\b'
      - '\b\d{3}-\d{2}-\d{5}\b'
      - '\b[\w.+-]+@[\w-]+\.[\w.-]+\b'
      - '\b\d{6,10}\b'
  ```

  체크섬 검증을 일부러 붙이지 않았다 — 검증은 매칭을 *줄이는* 방향이라 미탐(유출) 위험을
  만든다. 형식만 맞으면 가린다.

#### 1회성 우회 — `\용어` (기본 off)

등록된 용어를 딱 한 번만 마스킹 없이 보내고 싶을 때, 용어 앞에 백슬래시를 붙인다.
`MASK_TERM_ESCAPE=true` 로 켜야 동작한다 (기본 off — 보안 예외 기능이므로 명시적 opt-in).

```
MASK_TERM_ESCAPE=true 상태에서 요청:
  "\프로젝트 네뷸라 사업을 검토했다. 알파테크도 참여했다."
    → 업스트림 수신: "프로젝트 네뷸라 사업을 검토했다. <PROJECT_1A>도 참여했다."
      (\프로젝트 네뷸라 만 원문 통과, \ 는 제거, 나머지는 정상 마스킹)
```

규칙:

- `\` 뒤에 **등록된 용어가 실제 매칭될 때만** `\` 를 제거하고 그 occurrence 를 마스킹 건너뜀
- 매칭되지 않는 단어 앞의 `\` 는 원문 그대로 유지 (코드·경로 무영향)
- 리터럴 백슬래시 + 용어를 보내려면 `\\용어` — 첫 `\` 만 소비되고 `\용어` 가 남는다
- 우회된 occurrence 는 송신 직전 가드의 검사 대상에서 제외되며, activity log 에
  `bypassed: {분류: 횟수}` 로 기록된다 — 보안 예외는 반드시 감사 흔적을 남긴다

> 위험성 인지: 이 기능은 **의도적 유출 통로**다. 프롬프트에 마커를 넣을 수 있는 사람이라면
> 누구나 우회할 수 있으므로, 다수가 쓰는 게이트웨이에서는 off 를 유지하고 terms.yaml 주석이나
> 관리자 절차로 대체하는 편이 안전하다.

### `providers.yaml` — 어디로 보낼지

```yaml
active: anthropic          # 이 한 줄만 바꾸면 업스트림이 전환된다

fallback: []                # 한도 소진 등으로 실패하면 순서대로 시도. 예: [custom_llm]

providers:
  anthropic:                # claude CLI / VS Code 확장이 보낸 구독 자격증명을 그대로 전달
    type: api
    auth: passthrough
    forward_headers: [authorization, x-api-key, anthropic-version, anthropic-beta]
    endpoints:
      anthropic: https://api.anthropic.com

  openai:
    type: api
    auth: passthrough
    forward_headers: [authorization, openai-organization, openai-beta]
    endpoints:
      openai: https://api.openai.com

  custom_llm:                # Mask이 API 키를 주입
    type: api
    auth: api_key
    api_key_env: CUSTOM_LLM_KEY  # 키 '값'이 아니라 환경변수 '이름'
    endpoints:
      openai: https://api.example.com/v1

  remote_llm:                # OpenAI 호환 원격 provider (표준과 경로가 다를 때)
    type: api
    auth: api_key
    api_key_env: REMOTE_LLM_KEY
    paths:
      openai: /chat/completions   # Mask이 붙이는 /v1 접두사가 없는 엔드포인트용
    endpoints:
      openai: https://api.remote-llm.example/v4
    model_map:                 # 폴백 시 모델명 치환 (아래 "크로스 다이얼렉트 폴백")
      claude-sonnet-4-5: remote-top
```

`active`는 "어느 서비스를 쓸지"를, dialect(`/v1/messages` vs `/v1/chat/completions`)는
"어느 클라이언트가 말을 걸었는지"를 결정한다 — 두 축이 독립적이라 provider 하나가 여러
dialect 엔드포인트를 가질 수 있다. `auth: api_key`인 provider로 갈 때는 클라이언트가 보낸
인증 헤더를 **반드시 제거한 뒤** 키를 주입한다 — 그러지 않으면 다른 서비스에 이쪽 구독
자격증명을 그대로 흘려보내는 사고가 난다.

`fallback`이 설정돼 있으면, 클라이언트에 1바이트도 흘려보내기 전(HTTP 상태 코드만으로
판단 가능한 시점)에만 다음 provider로 전환한다. 스트리밍이 이미 시작된 뒤에는 전환하지
않는다 — 되감을 수 없기 때문이다. 전환이 일어나면 응답 헤더 `X-Mask-Provider-Used`로
알린다.

#### 크로스 다이얼렉트 폴백 — Claude ↔ OpenAI 자동 번역

폴백 provider가 들어온 요청과 **다른 API 유형**이어도 그대로 쓸 수 있다. Mask이
요청/응답을 자동 번역하기 때문이다. 예를 들어 Claude 형 요청(`​/v1/messages`)이
OpenAI 호환 provider로 폴백되면:

- 요청을 OpenAI 형식으로 번역해 전송 (system 위치, text/image/tool 블록 ↔ tool_calls,
  tool_result ↔ `role:"tool"` 메시지, tools 정의, max_tokens 기본 8192 보장, stop 매핑)
- 응답을 다시 Claude 형식으로 번역해 반환 — 토큰 복원 이후의 최종 응답은 원래 provider에서
  받았을 때와 같은 구조다
- 스트리밍도 양방향 번역한다: openai 청크 ↔ anthropic 이벤트(`message_start`·
  `content_block_delta`·`message_stop`…), tool_calls ↔ `input_json_delta` 포함
- `model_map`이 있으면 요청의 모델명을 업스트림 모델명으로 치환하고, 응답의 `model` 필드는
  클라이언트가 요청한 원래 모델명으로 되돌려준다

한계(의도된 단순화):

- anthropic 전용 필드(`thinking`, `top_k`, `cache_control`)와 openai 전용 필드
  (`frequency_penalty`, `response_format` 등)는 번역 시 버려진다
- 번역 경로에서 업스트림이 4xx 오류를 반환하면 본문은 벤더별 형식이 달라 번역 없이
  토큰만 복원해 전달한다
- 클라이언트가 `stream: true`를 요청했는데 번역 경로의 업스트림이 비SSE 본문을 반환하면
  JSON으로 응답한다

같은 dialect 폴백은 이전과 완전히 동일하게 동작한다 — 번역 없이 마스킹된 본문이 그대로
전달된다.

API 키는 YAML에 값을 직접 적지 않는다. `providers.yaml`은 `active`를 바꾸느라 편집
빈도가 높아 실수로 커밋될 위험이 크므로, 환경변수 이름만 적고 값은 `.env`(gitignore
대상)에 둔다.

## 클라이언트 연결

모든 클라이언트는 `http://127.0.0.1:8787` 하나만 가리키면 된다.

| 클라이언트 | 삽입점 |
|---|---|
| OpenClaw — 커스텀 OpenAI 호환 모델 | `openclaw.providers.json5`의 `baseUrl` |
| OpenClaw — `anthropic/*`(claude-cli 런타임) | claude CLI가 상속하는 `ANTHROPIC_BASE_URL` |
| VS Code Claude Extension | `ANTHROPIC_BASE_URL` |
| Codex / ChatGPT Desktop | 앱 설정의 custom endpoint (지원 여부는 클라이언트마다 다름) |

base URL 재정의를 지원하지 않는 클라이언트는 연결할 수 없다. Mask은 표준
Anthropic/OpenAI 엔드포인트를 그대로 흉내내므로, 연결 가능 여부는 순전히 클라이언트가
custom endpoint를 지원하느냐에 달려 있다.

## 동작 원리

### 매칭 — 왜 자체 구현이고 Presidio를 쓰지 않았나

가장 먼저 검토한 방식은 Microsoft Presidio였지만, **한국어 조사 결합 문제 때문에
채택하지 않았다.** Presidio를 비롯한 대부분의 deny-list 라이브러리는 `\b용어\b` 형태의
단어경계 정규식을 만드는데, 이 방식은 한국어에서 구조적으로 실패한다:

```text
/\b알파테크\b/.test("알파테크는")   → false     ← 조사가 붙으면 전부 실패
/\w/.test("크")                    → false     ← \w 자체가 ASCII 전용이라 한글은 대상이 아님
```

한글은 정규식의 `\w`(단어 문자) 범주에 들지 않기 때문에, 조사가 붙는 한국어 문장에서는
단어경계 매칭이 사실상 항상 실패한다. 이건 튜닝으로 고칠 수 있는 정확도 문제가 아니라
구조적 실패이고, 조사가 붙는 게 한국어의 기본이므로 이 방식으로는 대부분의 용어를
놓친다.

Presidio 자체의 구조도 이 프로젝트와 맞지 않는다. Presidio는 confidence score와 NER
모델을 중심으로 한 **확률적 PII 탐지**를 위해 설계됐다. Mask이 푸는 문제는 그것과
다르다 — `terms.yaml`에 있으면 가리고 없으면 안 가리는 **결정론적 용어 매칭**이라,
점수나 임계값이 개입할 자리가 없다. 오히려 "0.6 이상이면 가림" 같은 확률적 판정은 유출
경로를 하나 더 만든다.

그래서 매칭·가드는 외부 탐지 라이브러리 없이 전부 표준 정규식(`RegExp`)만으로 직접
구현했다. 핵심 규칙은 용어 **가장자리 문자의 문자종**으로 경계를 정하는 것이다:

| 가장자리 문자 | 경계 | 근거 |
|---|---|---|
| ASCII 영숫자 | 단어경계 요구 (`CORP` ≠ `CORPORATION`) | 영어에서는 경계가 정상 동작하고, 과탐 비용이 크다 |
| 한글·한자 | 경계 없음 | 조사·접미사를 그대로 삼킨다 |

핵심 판단 근거는 "과탐은 무손실이다, 미탐은 유출이다"라는 것이다. `글로벌알파`에서
`알파`를 잘못 잡아도 복원하면 정확히 `글로벌알파`로 돌아오지만(무손실), `주식회사알파테크`에서
`알파테크`를 놓치면 원문이 그대로 외부로 나간다(유출). 그래서 매칭 규칙은 의도적으로
과탐 쪽으로 기울어져 있다.

형태소 분석기(kiwi·mecab 계열)도 검토했지만 채택하지 않았다 — 미등록 고유명사를
잘못 쪼개면 미탐이 되고, 미탐은 곧 유출이라 실패 방향이 정반대다.

### 송신 직전 가드 — 안전 보장의 실체

매칭 규칙을 아무리 다듬어도 그것만으로 "절대 안 샌다"를 보장할 수 없다. 실제 유출은
대개 경계 판정이 아니라 요청 본문 순회 로직이 새 API 필드나 예상 밖의 중첩 구조를
놓치는 데서 생긴다.

그래서 직렬화된 요청 본문을 업스트림으로 보내기 직전에 **매칭 로직과 완전히 다른
경로로** 한 번 더 훑는다. literal 용어는 재검사 전용 정규식으로, `patterns:` 기반
분류(주민번호 등)는 각 패턴을 본문 전체에 다시 매칭해서 검사한다. 활성 용어가 하나라도
남아 있으면 업스트림 호출 자체를 하지 않고 502를 반환한다(fail-closed).

이 가드 덕분에 매칭 규칙 자체는 안전 임계(safety-critical) 지점이 아니게 된다 — 매칭
규칙은 "얼마나 깔끔하게 가리는가"만 책임지고, "절대 새지 않는가"는 가드가 책임진다.

### 토큰 매핑

토큰(`<INTERNAL_1A>` 등)은 **요청 1건 수명**으로만 존재한다. 세션 저장소나 TTL이 없고,
요청 JSON을 훑으며 등장한 용어에 순서대로 부여한다. 토큰은 클라이언트에 절대 노출되지
않는다 — 응답을 돌려주기 전에 전부 원문으로 복원되므로, 다음 턴에 클라이언트가 다시 보내는
대화 이력에는 원문이 그대로 들어 있다.

접미사 규칙(`MASK_TOKEN_FORMAT=<{type}_{n}>` 기준):

- terms.yaml에서 **같은 줄에 쉼표로 나열한 별칭들은 같은 그룹**으로 보고 `1A, 1B, 1C…`를,
  **별도 줄은 다음 그룹 번호** `2A…`, `3A…`를 받는다
  - 예: `한전기술, 한기, 한전E&C` → `<PARTNER_1A>`, `<PARTNER_1B>`, `<PARTNER_1C>`
- 토큰은 표기별로 개별 부여되고, 복원 시 **원문 표기를 그대로** 되돌린다 — `두산에너빌리티`가
  `두산`으로 줄어드는 정규화가 없다
- 응답 어디에서도 토큰이 복원되지 않고 남는 일은 없다 — 스트리밍 응답의 토큰이 여러 SSE
  델타에 걸쳐 갈라져 와도 아래 스트리밍 절의 재조립으로 처리한다

### 스트리밍

요청 경로(유출 위험이 있는 쪽)는 애초에 스트리밍이 아니다 — 클라이언트는 요청 본문을
완성된 JSON 한 덩어리로 보낸다. 응답 경로의 스트리밍 복원은 실패해도 화면에 토큰이 그대로
보이는 표시 결함일 뿐 유출이 아니므로, 실시간 스트리밍을 보안상의 이유로 미룰 이유가 없다.

복원은 SSE 이벤트 단위로 동작한다. 실제 provider는 1~3자 단위로 쪼개 스트리밍하기 때문에
`<COMPANY_1A>` 같은 토큰이 여러 델타에 걸쳐 갈라져 오고, 각 델타는 JSON 프레이밍 안에
싸여 있다. `SseDetokenizer`는 이벤트를 파싱해 JSON 문자열 값별로 미완성 토큰 꼬리를
홀딩했다가 완성되는 대로 복원하므로, 델타 경계와 무관하게 복원된다. 번역이 필요한
크로스 다이얼렉트 폴백에서는 형식 번역 후 같은 방식으로 복원한다.

## 관측 도구

"실제로 뭐가 걸리는지" 확인하려면 로그에 원문을 남기는 대신 다음 두 가지를 쓴다. 둘 다
용어 원문을 새로 노출하지 않는다.

**오프라인 검사** — 운영 중인 것과 동일한 매칭·가드 로직으로 직접 넣은 텍스트를 검사한다.
`terms.yaml`을 짤 때 이 용어가 실제로 잡히는지 바로 확인하는 용도다.

```bash
npm run inspect -- --text "알파테크는 Project 오로라를 검토했다"
npm run inspect -- --file transcript.txt
npm run inspect -- --payload test/fixtures/anthropic-messages.json
```

**실시간 활동 집계** — `GET /_mask/activity`. 로그와 같은 정보(provider, 분류별 치환
건수, 폴백 사용 여부, `\용어` 우회 건수, 타임스탬프)를 메모리 원형 버퍼(최근 200건,
재시작 시 소실)로 조회한다. 용어 원문은 구조적으로 담을 수 없다 — 건수만 기록한다.

**브라우저 미리보기** — `web/` (Vercel 분리 배포, `/mask/mask`·`/mask/restore`·`/mask/terms`).
게이트웨이와 같은 마스킹·복원 함수(`src/privacy`)를 브라우저에서 직접 실행하는 테스트용
페이지다. 서버로 문서를 전송하지 않으며, LLM endpoint 호출·API 키 입력 기능은 없다.
개인 사전은 브라우저 DB에만 저장된다.

## 개발

```bash
npm run typecheck   # tsc --noEmit
npm run test        # node:test — 유닛 테스트는 소스 옆에, 통합/보안/패리티 테스트는 test/ 에
npm run check        # 위 둘을 순서대로 — 이게 통과해야 변경이 완료된 것으로 친다

cd web && npm run check   # svelte-check (웹 UI)
cd web && npm run build   # Vite 빌드 → npm run scan 으로 산출물 문자열 스캔까지
```

테스트 중 가장 중요한 것은 `test/security/no-leak.test.ts`다. 이 프로젝트의 합격 기준은
"잘 가려지는가"가 아니라 **"원문이 절대 나가지 않는가"**이므로, 업스트림으로 실제 전송될
바이트열을 가로채 활성 용어의 부재를 직접 검증한다.

게이트웨이에는 빌드 스텝이 없다 — Node가 `.ts` 파일을 타입만 지운 채 직접 실행하므로
`node src/index.ts`가 곧 실행 명령이다. 타입 검사는 실행을 막지 않으므로 `npm run check`가
유일한 검증 게이트다. 빌드가 있는 유일한 곳은 `web/`(Vite 정적 빌드)뿐이다.

## 프로젝트 구조

```text
mask/
├── src/
│   ├── index.ts, app.ts, settings.ts, logging.ts, errors.ts
│   ├── plugins/            # 설정·용어·provider 를 앱에 주입 (Fastify autoload)
│   ├── routes/              # 디렉터리 구조가 곧 URL 구조 (Fastify autoload)
│   │   ├── healthz.ts, _mask/{status,activity}.ts
│   │   └── v1/{messages,models,responses}.ts, v1/chat/completions.ts
│   ├── privacy/              # 핵심 파이프라인 — 순수 함수, 소스 옆에 테스트
│   │   ├── terms.ts, matcher.ts, patterns.ts, mapping.ts
│   │   ├── tokenizer.ts, detokenizer.ts, walker.ts, guard.ts
│   │   └── rules/{anthropic,openai}.ts
│   ├── providers/            # 업스트림 선택·인증·HTTP 호출·형식 번역
│   │   ├── registry.ts, schema.ts, auth.ts, http.ts
│   │   └── translate.ts      # 크로스 다이얼렉트 폴백용 요청/응답 번역
│   ├── streaming/            # SSE 파싱, 롤링/버퍼 복원
│   │   ├── rolling.ts, buffered.ts, sse.ts
│   │   ├── sse-detokenizer.ts    # SSE 이벤트 단위 토큰 복원 (델타 경계 무관)
│   │   └── sse-translate.ts      # Claude ↔ OpenAI SSE 양방향 번역
│   ├── observability/        # 활동 피드 (집계만)
│   └── tools/inspect.ts      # 오프라인 검사 CLI
├── config/{terms,providers}.example.yaml
├── test/{integration,security,parity}/   # parity: mask/restore 공유 검증 벡터
├── web/                       # 브라우저 미리보기 — 별도 Vercel 배포 (origin 공유 없음)
│   ├── src/pages/             # Mask·Restore·Terms 3페이지 (Svelte 5)
│   ├── src/lib/engine.ts      # src/privacy를 직접 import — 게이트웨이와 동일 엔진
│   └── public/                # 공개 예제 사전·안내 문서 (개인 사전은 IndexedDB에만)
├── .env.sample
└── package.json
```

## 기술 스택

| | 선택 | 이유 |
|---|---|---|
| 언어/런타임 | TypeScript, Node로 직접 실행 (빌드 스텝 없음) | 스트리밍(`TransformStream`)이 언어 1급 기능이고 JSON이 네이티브라 이 워크로드에 잘 맞는다 |
| 웹 프레임워크 | Fastify | `decorate()`로 의존성 주입, `@fastify/autoload`로 파일 트리가 곧 라우팅, `error.statusCode` 필드만으로 에러 응답 처리 |
| 런타임 검증 | Zod | `terms.yaml`/`providers.yaml`/환경변수만 엄격 검증한다. 요청 본문은 검증하지 않고 형식을 그대로 통과시킨다 — Anthropic/OpenAI API 전체 스키마를 재정의하면 업스트림이 필드를 추가할 때마다 깨지고, 정작 마스킹해야 할 `tool_use.input` 같은 자리는 애초에 정해진 타입이 없다 |
| HTTP 클라이언트 | undici | 프로덕션 Agent(타임아웃·연결 재사용)와 테스트용 MockAgent를 겸한다 |
| 로깅 | pino | 구조화 로그. 활성 용어가 포함된 로그 레코드는 방출 직전에 차단된다 |
| 테스트 | `node:test` + `fast-check` | 내장 테스트 러너 + property-based 테스트로 무작위 입력에 대한 왕복 무결성을 검증 |
| 웹 미리보기 | Svelte 5 + Vite + Tailwind 4 | `src/privacy` 엔진을 브라우저에서 직접 실행하는 정적 SPA. 서버 저장·API 호출·키 입력 없음 |

탐지 라이브러리 의존성은 없다 — 매칭·가드 전부 표준 정규식으로 구현했다.

## 제약 사항

- 단일 사용자, 로컬 전용(`127.0.0.1` 바인딩). 인증·RBAC·사용량 관리 없음.
- DB·Redis 없음. 토큰 매핑은 요청 단위로만 존재하고 세션 간 지속되지 않는다.
- HTTP 통로가 없는 업스트림(로컬 전용 CLI 구독 등)은 지원하지 않는다 — Mask은 HTTP 홉
  에만 앉고, 그런 업스트림을 붙이려면 별도 실행기가 필요하다.
- 불특정 외부 인명·지명(임직원이 아닌) 탐지는 지원하지 않는다 — 확률적 NER은 재현율이
  곧 유출률이 되므로 채택하지 않았다.

## 주의사항

- Mask은 보안 정책을 대체하지 않는다. 사용 전 소속 조직의 보안 정책을 확인하고, 반드시 이를 준수해야 한다.
