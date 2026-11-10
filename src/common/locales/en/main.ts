/** 영어 번역(main). 열쇠는 tr()·msg()에 넘긴 한국어 원문 그대로, {변수}는 두 쪽이 같아야 한다. */
export const EN_MAIN: Record<string, string> = {
  // 창 제목
  '설명': 'Tooltip',
  'AI 사용량 설정': 'AI Usage settings',
  'AI 사용량 · 상세': 'AI Usage · Details',
  '도킹 미리보기': 'Dock preview',

  // 카드 우클릭 메뉴
  '집중 모드': 'Focus mode',
  'CLI 열기  (Ctrl+두 번 클릭)': 'Open CLI  (Ctrl+double-click)',
  '앱 열기  (Shift+두 번 클릭)': 'Open app  (Shift+double-click)',
  '이 서비스 통계': 'Stats for this service',
  '공식 사용량 페이지 열기': 'Open official usage page',
  '보여 줄 정보': 'Show on card',
  '쓴 양으로 표시': 'Show as used',
  '앞으로 옮기기': 'Move forward',
  '뒤로 옮기기': 'Move back',
  '작업 표시줄에서만 숨기기': 'Hide in taskbar only',
  '이 카드 숨기기': 'Hide this card',
  '서비스 설정…': 'Service settings…',

  // 단축키·트레이
  '창·작업 표시줄 독 보이기/숨기기': 'Show/hide window or taskbar dock',
  '클릭 통과 잠금': 'Click-through lock',
  '클릭 통과 잠금 ({key})': 'Click-through lock ({key})',
  '디자인 순환': 'Cycle design',
  '새 버전 {version} 설치하고 다시 시작': 'Install {version} and restart',
  '작업표시줄에서 창을 분리하지 못했습니다.': 'Couldn’t detach the window from the taskbar.',
  '직접 입력': 'Manual entry',

  // 설정 내보내기·불러오기
  '설정 내보내기': 'Export settings',
  '설정을 파일로 내보냈어요.': 'Settings exported to a file.',
  '설정 불러오기': 'Import settings',
  '읽을 수 없는 파일이에요.': 'Can’t read this file.',
  '이 앱에서 내보낸 설정 파일이 아니에요.': 'This isn’t a settings file exported from this app.',
  '불러오기': 'Import',
  '취소': 'Cancel',
  '이 파일의 설정으로 바꿀까요?': 'Replace your settings with this file?',
  '{time}에 내보낸 설정과 카드 {n}개로 지금 설정을 바꿔요.': 'Your settings will be replaced with the settings and {n} cards exported on {time}.',
  '{time}에 내보낸 설정으로 지금 설정을 바꿔요.': 'Your settings will be replaced with the settings exported on {time}.',
  '내보낸 설정과 카드 {n}개로 지금 설정을 바꿔요.': 'Your settings will be replaced with the exported settings and {n} cards.',
  '내보낸 설정으로 지금 설정을 바꿔요.': 'Your settings will be replaced with the exported settings.',
  '설정을 불러왔어요.': 'Settings imported.',

  // 파일·폴더 고르기, 다른 로그인 폴더
  '실행 파일': 'Executables',
  '프로그램·바로 가기': 'Programs & shortcuts',
  '모든 파일': 'All files',
  'Ctrl+두 번 클릭으로 실행할 CLI 고르기': 'Choose the CLI to run on Ctrl+double-click',
  'Shift+두 번 클릭으로 실행할 앱 고르기': 'Choose the app to run on Shift+double-click',
  '로그인 폴더 고르기': 'Choose login folder',
  '지원하지 않는 서비스예요.': 'This service isn’t supported.',
  '폴더를 찾을 수 없어요.': 'Folder not found.',
  'claude 로그인': 'claude sign-in',
  '이 폴더에 로그인 정보가 없어요. 터미널에서 {env}를 이 폴더로 두고 {cmd}을 먼저 해 주세요.': 'No sign-in found in this folder. In a terminal, set {env} to this folder and run {cmd} first.',
  "이미 '{name}' 카드로 추가돼 있어요.": "Already added as the '{name}' card.",
  "'{name}' 카드를 추가했어요.": "Added the '{name}' card.",

  // 크기 단계(Ctrl+1~5)
  '아주 작게': 'Extra small',
  '작게': 'Small',
  '보통': 'Medium',
  '크게': 'Large',
  '아주 크게': 'Extra large',

  // 알림
  '새 버전 {version}이 준비됐어요': 'Version {version} is ready',
  '창·위젯 제목줄의 ‘업데이트’를 누르면 설치하고 다시 시작해요.': 'Click ‘Update’ in the window or widget title bar to install and restart.',
  '{hour}시에 설치돼요. 제목줄의 ‘업데이트’로 지금 설치할 수도 있어요.': 'It will install at {hour}:00. Click ‘Update’ in the title bar to install now.',
  'Claude Code 5시간 한도 18% 남음': 'Claude Code 5-hour limit: 18% left',
  '리셋까지 2시간 41분 · 지금 속도면 1시간 5분 뒤 소진 예상 (테스트 알림)': 'Resets in 2h 41m · At this pace, runs out in 1h 5m (test notification)',

  // 업데이트·웹 페이지
  '인터넷에 연결할 수 없어요': 'Can’t connect to the internet',
  '업데이트를 확인하지 못했어요': 'Couldn’t check for updates',
  '포트 {port}번을 다른 프로그램이 쓰고 있어요. 다른 포트로 바꿔 주세요.': 'Port {port} is used by another program. Please choose a different port.',
  '웹 페이지를 열지 못했어요({reason}).': 'Couldn’t open the web page ({reason}).',
  '앱 설정에서 정한 접속 암호를 넣어 주세요.': 'Enter the access password set in the app settings.',
  '암호가 맞지 않아요.': 'Wrong password.',
  '접속 암호': 'Access password',
  '보기': 'View',

  // 앱 프로필 폴더
  '이 폴더에서 로그인된 앱 프로필을 찾지 못했어요. 그 프로필로 앱을 열어 로그인한 뒤 다시 골라 주세요.': 'No signed-in app profile found in this folder. Open the app with that profile, sign in, then choose it again.',
  '앱 프로필 {n}개를 찾았어요. 로그인한 계정이 카드로 나타나요.': 'Found {n} app profile(s). Signed-in accounts will show up as cards.',
  '미리보기에서는 찾지 않아요.': 'Not searched in preview.',
  '새 앱 프로필 {n}개를 찾았어요.': 'Found {n} new app profile(s).',
  '새로 찾은 앱 프로필이 없어요.': 'No new app profiles found.',
}
