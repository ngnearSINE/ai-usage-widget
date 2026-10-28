## 설치 방법

PC에 맞는 파일 **하나**만 내려받으면 됩니다. 자세한 안내는 [README의 설치](https://github.com/ngnearSINE/ai-usage-widget#설치)와 [사용 설명서](https://github.com/ngnearSINE/ai-usage-widget/blob/main/docs/user-guide.md)에 있습니다.

### Windows (x64·arm64)

- **설치 파일(추천, 자동 업데이트)**: `AI-Usage-Widget-Setup-{version}.exe`를 실행하면 바로 설치되고 시작됩니다. x64·arm64가 한 파일에 들어 있습니다.
- **휴대용(zip)**: `AI-Usage-Widget-{version}-win-x64.zip`(ARM PC는 `-win-arm64.zip`)의 압축을 풀고 `AI Usage Widget.exe`를 실행합니다. 자동 업데이트는 되지 않습니다.
- 처음 실행할 때 "Windows의 PC 보호" 경고가 뜨면 **추가 정보 → 실행**을 누르세요(코드 서명 인증서가 없기 때문).

### Ubuntu (x64·arm64)

터미널에서 `uname -m`을 실행해 `x86_64`면 x64, `aarch64`면 arm64 파일을 고릅니다.

| 종류 | x64 | arm64 |
|---|---|---|
| **AppImage**(추천, 자동 업데이트) | `AI-Usage-Widget-{version}-linux-x86_64.AppImage` | `AI-Usage-Widget-{version}-linux-arm64.AppImage` |
| **deb**(apt로 설치, 자동 업데이트 없음) | `AI-Usage-Widget-{version}-linux-amd64.deb` | `AI-Usage-Widget-{version}-linux-arm64.deb` |

AppImage: 실행 권한을 주고 실행합니다. 자동 업데이트가 파일을 새 버전으로 바꾸므로 내 폴더 안(예: `~/Applications`)에 두세요. 실행되지 않으면 `libfuse2t64`(Ubuntu 22.04는 `libfuse2`)를 먼저 설치하세요.

```bash
chmod +x AI-Usage-Widget-{version}-linux-*.AppImage
./AI-Usage-Widget-{version}-linux-*.AppImage
```

deb: 설치하면 앱 목록에 **AI 사용량 위젯**이 생깁니다. 새 버전은 새 deb를 받아 같은 명령으로 설치합니다.

```bash
sudo apt install ./AI-Usage-Widget-{version}-linux-*.deb
```

Ubuntu에서는 작업 표시줄 독과 위젯 없이 **창과 트레이 아이콘**으로 씁니다.
