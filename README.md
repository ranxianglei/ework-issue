# ework-issue

Command-line issue browser/editor for ework webs — **sync-directory mode**: issues materialize as files, viewing is `cat`, editing is editing files, `push` applies changes back.

## Setup
```bash
ework-issue init http://127.0.0.1:1196 dog/ework-aio
export EWORK_ISSUE_TOKEN=<personal access token>
ework-issue pull
ework-issue list
ework-issue open 1
```

## Layout
```
issues/0007-short-title/
  meta.json      # number/title/state/ai_status/model/...
  body.md
  comments/0001-author.md   # front-matter (id/author/model/created_at) + body
```

## Editing workflow
- New comment: create `comments/xxxx-yourname.md` with front-matter + body → `ework-issue push`
- Change state: edit `meta.json` `state` → `push` (close/reopen with conflict detection)
- Quick path: `ework-issue comment 7 -m "text" [--close]`

Exit codes: 0 ok · 1 usage · 2 conflict/unsupported · 3 network/auth.
