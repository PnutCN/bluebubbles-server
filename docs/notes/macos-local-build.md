# Building and running this fork on macOS

This covers a local build of the `feat/findmy-decrypt` branch, signing it so macOS
permissions stick, and supplying the Find My decryption keys.

## Prerequisites

- macOS 11+ (the decryption path targets 14.4+; older versions use the Private API path)
- Node.js 20.11.x and npm 10.x (`devEngines` in the root package.json pins this)
- Python 3.10+ (node-gyp builds the native modules: better-sqlite3, node-mac-contacts,
  node-mac-permissions)
- Xcode Command Line Tools

## Build

From the repo root:

```sh
npm install                 # also rebuilds native modules for Electron via postinstall
npm run build-ui            # React UI -> packages/server/dist
cd packages/server
npm run build               # webpack -> dist/main.js
../../node_modules/.bin/electron-builder build --mac --dir \
    --config ./scripts/electron-builder-config.js
# output: packages/server/releases/mac/BlueBubbles.app
```

The `--dir` target skips the DMG and just produces the .app, which is all a local
install needs.

## Signing: use a stable identity, not ad-hoc

Electron-builder skips signing when no Developer ID identity exists, and a plain
`codesign --sign -` (ad-hoc) produces a cdhash-based code requirement. macOS TCC
binds permission grants (Contacts, Accessibility, Apple Events automation, Focus) to
that requirement, so every rebuild silently detaches the grants and the app loses its
permissions. Symptoms look like a working app that reads zero contacts and can no
longer drive Messages/FaceTime.

Fix once per machine: create a self-signed code-signing identity and sign every build
with it. The requirement becomes identifier + certificate hash, which is stable across
rebuilds, so TCC grants survive.

```sh
# one-time: create and trust a self-signed identity
openssl req -x509 -newkey rsa:2048 -keyout bb-local.key -out bb-local.crt \
    -days 3650 -nodes -subj "/CN=BlueBubbles Local Code Signing" \
    -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=codeSigning"
openssl pkcs12 -export -legacy -out bb-local.p12 -inkey bb-local.key \
    -in bb-local.crt -passout pass:bb-local-tmp
security create-keychain -p bb-local ~/Library/Keychains/bb-local.keychain-db
security unlock-keychain -p bb-local ~/Library/Keychains/bb-local.keychain-db
security import bb-local.p12 -k ~/Library/Keychains/bb-local.keychain-db \
    -P bb-local-tmp -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: -k bb-local \
    ~/Library/Keychains/bb-local.keychain-db
sudo security add-trusted-cert -d -p codeSign -r trustRoot bb-local.crt
security list-keychains -d user -s ~/Library/Keychains/bb-local.keychain-db login.keychain-db
security find-identity -v -p codesigning    # note the identity hash

# every build: sign with the identity hash
security unlock-keychain -p bb-local ~/Library/Keychains/bb-local.keychain-db
codesign --force --deep -s <IDENTITY-HASH> /Applications/BlueBubbles.app
```

If the app previously ran with another signature, its existing TCC grants point at the
old requirement. Re-point them once (the grants stay valid for all future builds signed
with the identity above):

```sh
codesign -d -r /tmp/req.txt /Applications/BlueBubbles.app
grep "designated =>" /tmp/req.txt | sed "s/.*designated => //" > /tmp/designated.txt
/usr/bin/csreq -r /tmp/designated.txt -b /tmp/req.bin

# user grants (Contacts, AppleEvents, FocusStatus): user TCC db
python3 - <<'EOF'
import sqlite3
blob = open("/tmp/req.bin", "rb").read()
con = sqlite3.connect("/Users/<you>/Library/Application Support/com.apple.TCC/TCC.db")
con.execute("UPDATE access SET csreq=? WHERE client=?",
            (blob, "com.BlueBubbles.BlueBubbles-Server"))
con.commit(); con.close()
EOF

# Accessibility grant: system TCC db, needs root
sudo python3 - <<'EOF'
import sqlite3
blob = open("/tmp/req.bin", "rb").read()
con = sqlite3.connect("/Library/Application Support/com.apple.TCC/TCC.db")
con.execute("UPDATE access SET csreq=? WHERE client=?",
            (blob, "com.BlueBubbles.BlueBubbles-Server"))
con.commit(); con.close()
EOF

killall tccd   # flush the TCC cache
```

A fresh install that never had the grants can skip the sqlite part; the app will prompt
once per permission and the grants will stick across rebuilds from then on.

## Find My decryption keys

On macOS 14.4+ the server reads Find My data by decrypting the on-disk caches. Keys
live in `~/Library/Application Support/bluebubbles-server/FindMyKeys/`:

| File | What it unlocks |
|------|-----------------|
| `LocalStorage.key` | friend locations from LocalStorage.db (where the table exists) |
| `FMIPDataManager.bplist` | devices & items cache |
| `FMFDataManager.bplist` | friend display names |
| `SearchParty.key` | friend locations from the searchpartyd secure-location store (fallback when LocalStorage.db has no secureLocations table) |

The first three come from
[findmy-key-extractor](https://github.com/manonstreet/findmy-key-extractor) and import
via the Settings UI (folder picker). All four can also be dropped into the directory
by hand (raw bytes, mode 600).

`SearchParty.key` is the searchpartyd store-wide AES-256-GCM master key (32 raw
bytes). There is no extractor release for it; it was recovered by capturing the AES-GCM
operations of `searchpartyuseragent` with lldb. It appears keychain-persisted and
stable across reboots, but if friend locations stop updating, re-extract it.

### Environment variable instead of a file

The SearchParty key can be supplied as the `FINDMY_SEARCHPARTY_KEY` environment
variable (64 hex chars), which takes precedence over the file. For the packaged app,
set it in the LaunchAgent so it survives reboots:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>FINDMY_SEARCHPARTY_KEY</key>
    <string>...64 hex chars...</string>
</dict>
```

## Running

The app expects macOS to launch it (login item or a LaunchAgent running the binary
directly). Verify the friends endpoint after a refresh:

```sh
curl -X POST "http://localhost:1234/api/v1/icloud/findmy/friends/refresh?guid=<server-password>"
```

Each friend item carries `coordinates`, `last_updated`, `status` ("live" when
coordinates are fresh), and `avatar` (base64 contact photo, null when no matching
contact has an image). Avatars are resolved from Contacts by handle (exact email, or
phone digit-suffix), preferring image-bearing duplicates; the Contacts TCC grant must
be in place for this to work.
