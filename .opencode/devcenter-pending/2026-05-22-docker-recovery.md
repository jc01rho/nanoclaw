# DevCenter 보고 대기: Docker 컨테이너 런타임 장애 복구 및 PATH 재발방지

## 대상 스토리
STORY-692

## 작업명
Docker 컨테이너 런타임 장애 복구 및 PATH 재발방지

## 공수
- difficulty: 3
- estimatedWorkload: 4시간
- actualWorkload: 4시간

## 상세 내용

### 1. Docker ETIMEDOUT 장애 원인 분석
- Docker Desktop이 30일 이상 장기 실행되며 응답 불가(ETIMEDOUT) 상태에 빠짐
- 컨테이너 스폰 실패 → Discord 응답 불가
- ensureContainerRuntimeRunning()의 5회 재시도 로직 동작 확인

### 2. 원격 NanoClaw 서비스 재시작
- 원격 macOS 서버(192.168.30.129)에서 서비스 재시작 완료
- Discord Gateway 재연결 확인 (infraClaw online)
- 대기 메시지 처리 복구 확인

### 3. PATH 재발방지 조치
- `.zshenv`에 하드코딩된 PATH 추가: `/Users/whrho/.npm-global/bin:/usr/local/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:/Users/whrho/.local/bin`
- 비대화형 SSH 세션에서도 pnpm/node 즉시 사용 가능하도록 영구 설정

## 변경 파일
없음 (코드 변경 없이 설정 및 운영 조치)

## 검증
- Docker 정상 응답 확인 ✅
- 서비스 재시작 후 Discord Gateway 연결 확인 ✅
- 컨테이너 정상 스폰 및 메시지 처리 확인 ✅
- SSH 비대화형 세션에서 pnpm/node 정상 실행 확인 ✅

## 발생일
2026-05-22 (금요일)
