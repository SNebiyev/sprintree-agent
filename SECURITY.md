# Security policy

## Reporting a vulnerability

Please report privately through GitHub Security Advisories: open the **Security** tab of this repository and
choose **Report a vulnerability**. Do not open a public issue for a vulnerability. Never paste a real token
into a report.

## Supported versions

The latest 0.x release. Fixes land there, there are no backports.

## Scope and handling of secrets

- `skills/sprintree/scripts/st.mjs` reads its token only from `SPRINTREE_TOKEN` and never prints it.
  Redaction decodes percent escapes and `\u` escapes (depth 5, like gitleaks) but not base64 or hex. Every token-shaped run (`itn_`, `itna_` or `itnr_` and at least 20 of `A-Za-z0-9_-`) is hidden wherever it sits, whatever stands before it: a word, a digit, a removed character or an escape sequence. This is stricter than the gitleaks rule, which skips a token glued to a word (`keyitn_...`); `st.mjs` hides that one too. The configured token (6 characters or more) must be letters, digits, `_` and `-` (a real token is), anything else is refused at load without being echoed; it is hidden as written and wherever the text reads as it after invisible characters are removed and escapes decoded, and its base64 or hex form is not hidden. A hidden run takes the token characters right behind it. Text is redacted before and after its control sequences, controls and invisible characters are removed: the first pass sees a token that is whole in the text as it came (a NUL is put between an escape prefix and a literal head right behind it, `ESC [ 1 itn_...`, so the sequence ends before the head and cannot take its `i`; the head is also read as escapes decode, `ESC %69tn_...`), the second one sees what the cleaning joined (`itn_`, ten characters, `ESC [ 0 m`, twenty more), and a mask the first pass wrote, followed by token characters, is one mask (a literal `[token]` in server text is left as it is; U+FDD0, the noncharacter the first pass writes in front of its masks as a sentinel, is printed as U+FFFD when the server sends it; U+E000 and other private-use characters print as they are). Not covered: (a) a malformed escape sequence that eats a character of a head (`itn ESC _...`), and (b) a head that is whole only after cleaning while an escape sequence before it takes its first character (`ESC [ 1 i U+0001 tn_...`). Controls and invisible characters never eat a character (they are removed alone, and `itn U+0001 _...`, `itn U+200B _...`, `itn U+009B _...` are hidden). The same applies to a configured token (real tokens always start with `itn_`, `itna_` or `itnr_`, so the head rules above are the ones that matter). Like base64 and hex, this takes someone who already has the token. Where gitleaks leaves all `%XX` of a line alone because one of them is a byte it cannot decode, `st.mjs` still decodes the others (stricter).
- The skill treats card text as untrusted data (see the README, "Auth").
- Never commit a token or put one in `.sprintree.json`. A leaked token: revoke it in Sprintree under
  Settings -> API & MCP -> Personal access tokens.
