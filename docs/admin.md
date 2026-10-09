# Pete's controls: allowlist, limits, changes

Who can be called and the call limits are managed by Pete from the dashboard Calls page (Contacts / Limits / Changes
tabs). Nothing an agent can reach can change them: no MCP tool, and no agent, read or brain key. test/admin.test.ts has
a guard test that fails if any non-admin route or MCP tool can write `allowed`, `trusted`, `inbound_allowed` or a setting.

## The key

An **admin-scope** key (`aph_a_…`) made on the droplet: `node src/cli.ts key:create pete --scope admin` (printed once).
Pete pastes it into the dashboard (Settings → Phone admin key). It lives only in that browser's localStorage. The
dashboard sends it as `X-Phone-Admin`; the api-server proxy (deploy/api-server-phone-admin.diff) passes it on as the
Bearer and keeps nothing. Lost or leaked: `key:revoke <prefix>` (every change in the audit names the key prefix).

## Routes ({BASE_PATH}/admin/*, admin key only, 401 otherwise)

| Route | What |
|---|---|
| `GET /admin/contacts` | all contacts + `allowed_count`, `max_allowed` (25) |
| `POST /admin/contacts` `{phone, name, ...}` / `PATCH /admin/contacts/:phone` | add or change: `name notes tz allowed trusted inbound_allowed do_not_call:true` |
| `GET /admin/settings` / `PATCH /admin/settings` `{KEY: value \| null}` | limits; `null` = back to the env value. All or nothing |
| `GET /admin/audit?limit&before` | the Changes list, newest first |
| `GET /admin/whoami` | checks a pasted key |

## Rules

- **Allowed** = may be dialed at all. **Trusted** = dialed without Pete's confirm step. Both admin-only.
- At most 25 allowed contacts (code constant). No wildcards anywhere.
- Do-not-call can be **set** from the dashboard; **clearing** it is CLI-only: `contact:set <phone> do_not_call 0`.
- `DIALING_ENABLED` (the kill switch), secrets, CODE_PHRASE, voicemail action, cost rates and all timing stay env-only.
- Settings and their hard bounds (a save outside them is refused):

| Setting | Bounds |
|---|---|
| MAX_CALL_SECONDS | 30-600 |
| SPEND_CAP_DAY_USD | 0-20 |
| SPEND_CAP_MONTH_USD | 0-100 |
| CALL_HOURS_START / CALL_HOURS_END | 7-21 / 8-22, end after start |
| CONFIRM_TTL_MIN | 1-120 |
| VOICEMAIL_LINE | 1-200 chars, one line (used when VOICEMAIL_ACTION=message) |

  A saved value overrides the env right away (read per call, no restart). Precedence: dashboard → env → default.
- Every change is audited: `admin.contact.add`, `admin.contact.set` / `admin.setting.set` / `admin.setting.reset` with
  `{field, old, new}` and the key prefix as actor.

## Migration from ALLOWED_DESTINATIONS

On the first start after this change (deploy.sh runs `migrate`, which also does this), the old `ALLOWED_DESTINATIONS`
list is imported once into `contacts.allowed` (unset = Pete only, its old default; `*` and non-numbers are skipped and
logged). After that the env var is ignored (the server logs a warning while it is still set). Remove it from
/etc/agent-phone.env once the Contacts tab looks right.
