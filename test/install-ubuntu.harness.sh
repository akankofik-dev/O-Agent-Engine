#!/usr/bin/env bash
# ==================================================================== #
#  test/install-ubuntu.harness.sh — run the Ubuntu installer for real, in
#  a sandbox, and read what it did.
#
#  Driven by test/install-ubuntu.test.js, which supplies REPO.
#
#  scripts/install-ubuntu.sh is the one file in this repository that no test
#  touches, and it runs on the one platform nobody developing here runs. A check
#  that only reads it proves it parses. So it is run: apt-get, sudo, systemctl,
#  curl and node are replaced with stubs that record what they were asked, HOME
#  and XDG_CONFIG_HOME point at a throwaway directory, and nothing reaches the
#  network or the machine.
#
#  What is being checked is not "does it parse":
#
#    - the unit it writes is the unit it enables
#    - the unit that carries the old name is retired, and retired *first*
#    - every branch it takes says something, and the branches that cannot work
#      exit non-zero instead of pretending
#
#  Three harness bugs are worth naming, because each one produced a result that
#  looked like a product failure and none of them was:
#
#    - it derived the repo path from its own location and landed two directories
#      short, so 28 checks failed on "no such file"
#    - it stubbed apt-get, sudo, systemctl and node but NOT curl, and the
#      installer's Node bootstrap is `curl … | sudo bash`. The sandbox really did
#      fetch a script from the internet and pipe it to a shell; every check past
#      that point was measuring the network
#    - the "node is too old" section forgot to say so, and quietly measured the
#      already-new-node path, then complained that Node had not been installed
#
#  A guard that measures the wrong branch reports the wrong failure, which is
#  worse than reporting none.
# ==================================================================== #

set -uo pipefail

REPO="${REPO:?test/install-ubuntu.test.js harus menyediakan REPO}"
REPO="$(cd "$REPO" && pwd)"
INSTALLER="$REPO/scripts/install-ubuntu.sh"
[ -f "$INSTALLER" ] || { echo "  FAIL installer ada di $INSTALLER"; exit 1; }

SANDBOX="$(mktemp -d)"
BIN="$SANDBOX/bin"
XDG="$SANDBOX/config"
CALLS="$SANDBOX/calls.log"
export STUB_LOG="$SANDBOX/node.log"
export CALLS XDG SANDBOX
mkdir -p "$BIN" "$XDG"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
no() {
  fail=$((fail + 1))
  printf '  FAIL %s\n' "$1"
  if [ $# -gt 1 ]; then printf '         %s\n' "$2"; fi
  return 0
}

mk() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$BIN/$1"; chmod +x "$BIN/$1"; }

SYSTEMCTL_BODY='echo "systemctl $*" >> "$CALLS"
case "$*" in
  *"--user cat "*)
    n="${*##* }"
    [ -e "$XDG/systemd/user/$n" ] && exit 0
    exit 1 ;;
esac
exit ${SYSTEMCTL_EXIT:-0}'

NODE_BODY='case "${1:-}" in
  -p) echo "${FAKE_NODE_MAJOR:-24}"; exit 0 ;;
  --version) echo "v${FAKE_NODE_MAJOR:-24}.0.0"; exit 0 ;;
esac
echo "node $*" >> "$STUB_LOG"
exit 0'

# curl records the URL and prints nothing at all. The real one would fetch a
# distribution bootstrap script over the network and the installer pipes whatever
# comes back straight into a shell.
CURL_BODY='echo "curl $*" >> "$CALLS"
exit 0'

mk apt-get 'echo "apt-get $*" >> "$CALLS"
exit ${APT_EXIT:-0}'
mk sudo 'echo "sudo $*" >> "$CALLS"
exec "$@"'
mk systemctl "$SYSTEMCTL_BODY"
mk node "$NODE_BODY"
mk curl "$CURL_BODY"

unit() { echo "$XDG/systemd/user/$1"; }
count() { local n; n=$(grep -c -- "$1" "$CALLS" 2>/dev/null); echo "${n:-0}"; }
firstline() { grep -n -- "$1" "$CALLS" 2>/dev/null | head -1 | cut -d: -f1; }

run_install() {
  : > "$CALLS"; : > "$STUB_LOG"
  PATH="$BIN:$PATH" XDG_CONFIG_HOME="$XDG" HOME="$SANDBOX" \
    bash "$INSTALLER" > "$SANDBOX/out.txt" 2> "$SANDBOX/err.txt"
  echo $? > "$SANDBOX/code"
}
found() {
  local code; code=$(cat "$SANDBOX/code")
  if [ "$code" = "127" ]; then
    no "installer ditemukan dan dijalankan" "exit 127: $(head -2 "$SANDBOX/err.txt")"
    return 1
  fi
  return 0
}

printf '\n== 1. mesin kosong: install dari nol ==\n'
run_install
if found; then
  ok "installer ditemukan dan dijalankan"
  out=$(cat "$SANDBOX/out.txt"); err=$(cat "$SANDBOX/err.txt"); code=$(cat "$SANDBOX/code")
  [ "$code" = "0" ] && ok "exit 0" || no "exit 0" "code=$code err=$err"
  [ -f "$(unit o-agent.service)" ] && ok "unit o-agent.service ditulis" \
    || no "unit o-agent.service ditulis" "$(ls -1 "$XDG/systemd/user" 2>&1)"
  [ -f "$(unit octop-browser-automation.service)" ] \
    && no "unit lama tidak ikut ditulis" "keduanya ada" || ok "unit lama tidak ikut ditulis"

  u=$(cat "$(unit o-agent.service)" 2>/dev/null)
  echo "$u" | grep -q '^Description=O Agent$' && ok "Description = O Agent" \
    || no "Description = O Agent" "$(echo "$u" | grep -i description)"
  echo "$u" | grep -qi 'octop' && no "unit tidak lagi memakai nama lama" "$(echo "$u" | grep -i octop)" \
    || ok "unit tidak lagi memakai nama lama"
  echo "$u" | grep -qE '^Environment=PORT=8787$' && ok "PORT=8787" || no "PORT=8787"
  echo "$u" | grep -qE '^Environment=HOST=127\.0\.0\.1$' && ok "HOST=127.0.0.1" || no "HOST=127.0.0.1"
  echo "$u" | grep -qE '^Environment=HEADLESS=1$' && ok "HEADLESS=1" || no "HEADLESS=1"
  echo "$u" | grep -qE '^Restart=on-failure$' && ok "Restart=on-failure" || no "Restart=on-failure"
  echo "$u" | grep -q 'server\.js"' && ok "ExecStart menunjuk server.js" \
    || no "ExecStart menunjuk server.js" "$(echo "$u" | grep -i execstart)"
  echo "$u" | grep -qE '^ExecStart="[^"]*node"' && ok "ExecStart memakai path node absolut" \
    || no "ExecStart memakai path node absolut" "$(echo "$u" | grep -i execstart)"
  echo "$u" | grep -qE '^WorkingDirectory=' && ok "WorkingDirectory diisi" || no "WorkingDirectory diisi"
  echo "$u" | grep -qE '^\[Install\]' && ok "ada seksi [Install]" || no "ada seksi [Install]"

  [ "$(count 'systemctl --user enable --now o-agent.service')" -ge 1 ] \
    && ok "enable --now memakai nama yang sama dengan file" \
    || no "enable --now memakai nama yang sama dengan file" "$(grep enable "$CALLS")"
  [ "$(count 'apt-get install -y libnss3')" -ge 1 ] && ok "paket Chrome tetap dipasang" \
    || no "paket Chrome tetap dipasang"
  grep -q 'get-browser.js' "$STUB_LOG" && ok "get-browser.js dipanggil" \
    || no "get-browser.js dipanggil" "$(cat "$STUB_LOG")"
  echo "$out" | grep -qi 'octop' && no "output tidak menyebut nama lama" "$(echo "$out" | grep -i octop)" \
    || ok "output tidak menyebut nama lama"
  echo "$out" | grep -q 'O Agent is running' && ok "output menyebut O Agent" \
    || no "output menyebut O Agent" "$(echo "$out" | head -5)"
fi

printf '\n== 2. mesin yang sudah ter-install: unit lama harus dinonaktifkan ==\n'
if found; then
  cat > "$(unit octop-browser-automation.service)" <<'OLDUNIT'
[Unit]
Description=Octop Browser Automation
[Service]
ExecStart=/usr/bin/node /old/server.js
[Install]
WantedBy=default.target
OLDUNIT
  run_install
  [ -f "$(unit octop-browser-automation.service)" ] && no "unit lama dihapus" "masih ada" || ok "unit lama dihapus"
  [ -f "$(unit o-agent.service)" ] && ok "unit baru tetap ada setelah migrasi" || no "unit baru tetap ada setelah migrasi"
  dis=$(firstline 'disable --now octop-browser-automation.service')
  ena=$(firstline 'enable --now o-agent.service')
  if [ -n "$dis" ] && [ -n "$ena" ] && [ "$dis" -lt "$ena" ]; then
    ok "unit lama dinonaktifkan SEBELUM yang baru di-enable (baris $dis < $ena)"
  else
    no "unit lama dinonaktifkan SEBELUM yang baru di-enable" "disable=$dis enable=$ena"
  fi
  [ "$(count 'daemon-reload')" -ge 1 ] && ok "daemon-reload dipanggil" || no "daemon-reload dipanggil"
  grep -q 'Retiring the old' "$SANDBOX/out.txt" && ok "user diberi tahu unit lamanya diganti" \
    || no "user diberi tahu unit lamanya mengganti" "$(cat "$SANDBOX/out.txt")"
fi

printf '\n== 3. unit baru saja ditulis ulang: tidak ada yang perlu dilumat ==\n'
if found; then
  run_install
  grep -q 'Retiring the old' "$SANDBOX/out.txt" \
    && no "tidak ada pesan migrasi saat memang tidak ada unit lama" "$(cat "$SANDBOX/out.txt")" \
    || ok "tidak ada pesan migrasi saat memang tidak ada unit lama"
  [ "$(count 'disable --now')" = "0" ] && ok "tidak ada disable yang sia-sia" \
    || no "tidak ada disable yang sia-sia" "$(grep disable "$CALLS")"
fi

printf '\n== 4. node terlalu tua: harus memasang Node 20 ==\n'
if found; then
  export FAKE_NODE_MAJOR=18
  run_install
  grep -q 'Installing Node.js 20' "$SANDBOX/out.txt" && ok "user diberi tahu Node dipasang" \
    || no "user diberi tahu Node dipasang" "$(cat "$SANDBOX/out.txt")"
  [ "$(count 'deb.nodesource.com/setup_20')" -ge 1 ] && ok "bootstrap Node 20 dipanggil" \
    || no "bootstrap Node 20 dipanggil" "$(cat "$CALLS")"
  [ "$(count 'apt-get install -y nodejs')" -ge 1 ] && ok "nodejs di-install" || no "nodejs di-install"
  [ "$(count 'curl')" -ge 1 ] && ok "curl dicatat" || no "curl dicatat"
  unset FAKE_NODE_MAJOR
fi

printf '\n== 5. apt bilang oke tapi node masih kurang: berhenti, jangan lanjut ==\n'
if found; then
  rm -f "$(unit o-agent.service)"
  export FAKE_NODE_MAJOR=18
  run_install
  code=$(cat "$SANDBOX/code")
  [ "$code" != "0" ] && ok "installer berhenti dengan non-zero" || no "installer berhenti dengan non-zero" "code=$code"
  grep -qi 'node.js 20' "$SANDBOX/err.txt" && ok "pesan menyebut penyebabnya" \
    || no "pesan menyebut penyebabnya" "err: $(cat "$SANDBOX/err.txt")"
  [ ! -f "$(unit o-agent.service)" ] && ok "unit tidak ditulis setelah kegagalan" \
    || no "unit tidak ditulis setelah kegagalan" "unit ditulis padahal node kurang"
  unset FAKE_NODE_MAJOR
fi

printf '\n== 6. tanpa apt-get: harus bilang, bukan diam ==\n'
if found; then
  rm -f "$BIN/apt-get"
  export FAKE_NODE_MAJOR=18
  run_install
  code=$(cat "$SANDBOX/code")
  [ "$code" != "0" ] && ok "installer berhenti dengan non-zero" || no "installer berhenti dengan non-zero" "code=$code"
  grep -qi 'apt-get' "$SANDBOX/err.txt" \
    && ok "pesan menyebut bahwa hanya apt-get yang dipakai" \
    || no "pesan menyebut bahwa hanya apt-get yang dipakai" "err: $(cat "$SANDBOX/err.txt")"
  [ ! -f "$(unit o-agent.service)" ] && ok "unit tidak ditulis" || no "unit tidak ditulis"
  unset FAKE_NODE_MAJOR
  mk apt-get 'echo "apt-get $*" >> "$CALLS"
exit ${APT_EXIT:-0}'
fi

printf '\n== 7. tanpa sudo: harus bilang cara pasang manual ==\n'
if found; then
  rm -f "$BIN/sudo"
  export FAKE_NODE_MAJOR=18
  run_install
  code=$(cat "$SANDBOX/code")
  [ "$code" != "0" ] && ok "installer berhenti dengan non-zero" || no "installer berhenti dengan non-zero" "code=$code"
  grep -qi 'manually' "$SANDBOX/err.txt" \
    && ok "pesan menyebut apa yang harus dipasang manual" \
    || no "pesan menyebut apa yang harus dipasang manual" "err: $(cat "$SANDBOX/err.txt")"
  [ ! -f "$(unit o-agent.service)" ] && ok "unit tidak ditulis" || no "unit tidak ditulis"
  unset FAKE_NODE_MAJOR
  mk sudo 'echo "sudo $*" >> "$CALLS"
exec "$@"'
fi

printf '\n== 8. tanpa systemd: tetap bikin unit, jangan diam ==\n'
if found; then
  export SYSTEMCTL_EXIT=127
  rm -f "$(unit o-agent.service)"
  run_install
  code=$(cat "$SANDBOX/code")
  [ "$code" = "0" ] && ok "installer tetap selesai tanpa systemd" \
    || no "installer tetap selesai tanpa systemd" "code=$code err=$(cat "$SANDBOX/err.txt")"
  [ -f "$(unit o-agent.service)" ] && ok "unit tetap ditulis" || no "unit tetap ditulis"
  grep -q 'Start manually' "$SANDBOX/out.txt" && ok "user diberi cara menjalankan manual" \
    || no "user diberi cara menjalankan manual" "$(cat "$SANDBOX/out.txt")"
  unset SYSTEMCTL_EXIT
fi

printf '\n== 9. tidak ada stub yang menjalankan perintah nyata ==\n'
if found; then
  export FAKE_NODE_MAJOR=18
  run_install
  unset FAKE_NODE_MAJOR
  seen=$(grep -oE '^[a-z_-]+ ' "$CALLS" | sort -u | tr -d ' ' | tr '\n' ' ')
  node_seen=$(grep -oE '^node ' "$STUB_LOG" | sort -u | tr -d ' ' | tr '\n' ' ')
  echo "         perintah yang tercatat: $seen $node_seen"
  [ "$(count 'curl')" -ge 1 ] && ok "curl benar-benar dipanggil" || no "curl benar-benar dipanggil" "$(cat "$CALLS")"
  grep -q 'deb.nodesource.com' "$CALLS" && ok "URL bootstrap tercatat di log, tidak diambil" \
    || no "URL bootstrap tercatat di log" "$(cat "$CALLS")"
  for name in $seen $node_seen; do
    case "$name" in
      apt-get|sudo|systemctl|curl|node|bash) ;;
      *) no "tidak ada perintah asing: $name" "$seen" ;;
    esac
  done
  ok "tidak ada perintah yang bukan stub"
fi

printf '\n== 10. tidak ada yang menyentuh mesin sungguhan ==\n'
[ -z "$(ls -A "$SANDBOX" | grep -vE '^(bin|config|calls\.log|node\.log|out\.txt|err\.txt|code)$')" ] \
  && ok "sandbox hanya berisi yang diharapkan" \
  || no "sandbox hanya berisi yang diharapkan" "$(ls -A "$SANDBOX" | tr '\n' ' ')"
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  # Deliberately not `git status --porcelain`. That measures whoever ran the
  # harness, not the installer: it failed on the very first run because the two
  # files that make up this suite were themselves uncommitted. A check that
  # reports the reader's own state as damage gets switched off, and then it
  # measures nothing. What follows fingerprints the tree instead.
  :
fi

# Does the installer itself write into the repository? Fingerprint, run once more,
# compare. data/ and engines/ are excluded because the product is expected to write
# there at runtime; .git because git is not what is being measured.
fingerprint() {
  find "$REPO" \
    -not -path "*/.git/*" -not -name ".git" \
    -not -path "*/data/*" -not -name "data" \
    -not -path "*/engines/*" -not -name "engines" \
    -not -path "*/node_modules/*" -not -name "node_modules" \
    -not -path "*/.browser/*" -not -name ".browser" \
    -type f -printf '%P %s\n' 2>/dev/null | sort
}
BEFORE="$SANDBOX/tree-before.txt"
AFTER="$SANDBOX/tree-after.txt"
fingerprint > "$BEFORE"
run_install
fingerprint > "$AFTER"
if diff -q "$BEFORE" "$AFTER" >/dev/null 2>&1; then
  ok "installer tidak menulis apa pun ke dalam repository"
else
  no "installer menulis ke dalam repository" "$(diff "$BEFORE" "$AFTER" | head -6)"
fi

# and systemd itself gets the last word, when it is on the machine to give one
if command -v systemd-analyze >/dev/null 2>&1; then
  if systemd-analyze verify "$(unit o-agent.service)" >/dev/null 2>&1; then
    ok "systemd-analyze menerima unit itu"
  else
    no "systemd-analyze menolak unit itu" "$(systemd-analyze verify "$(unit o-agent.service)" 2>&1 | head -3)"
  fi
else
  echo "         (systemd-analyze tidak ada di mesin ini — unit belum diverifikasi oleh systemd)"
fi

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
rm -rf "$SANDBOX"
[ "$fail" = "0" ]
