# filesystem

Filesystem tools for LM Studio.

This plugin adds a small set of practical filesystem tools to LM Studio chats.

## Response Format

Successful and error responses use a flat `#key:value` protocol.

- Scalar metadata is emitted as one field per line, for example `#path:/Users/john/file.txt`
- Multiline or raw payloads are framed with `*_bytes` fields whose values are UTF-8 byte counts for the payload that follows immediately after the metadata line
- After the payload bytes are consumed, parsing resumes at the next `#key:value` line
- Errors use flat scalar fields such as `#error`, `#message`, `#path`, and related metadata

## Ignored Paths

Traversal tools (`list`, `glob`, and `grep`) filter ignored paths before returning results.

- If `LMS_FILESYSTEM_IGNORE_PATHS` is unset, the default ignored path segments are:
  - `.git`
  - `node_modules`
  - `dist`
  - `build`
  - `target`
  - `vendor`
  - `bin`
  - `obj`
  - `.idea`
  - `.vscode`
  - `.zig-cache`
  - `zig-out`
  - `.coverage`
  - `coverage`
  - `tmp`
  - `temp`
  - `.cache`
  - `cache`
  - `logs`
  - `.venv`
  - `venv`
  - `env`
- If `LMS_FILESYSTEM_IGNORE_PATHS` is set, it overrides the built-in list entirely.
- Format: semicolon-separated glob patterns, for example `dist;coverage;generated/**`
- If `LMS_FILESYSTEM_IGNORE_PATHS` is present but empty, the built-in ignore list is disabled.

## Read-only

### `read`

Read a file.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `filePath` | string | - | Absolute or home-relative path (e.g., `/Users/john/file.ext`, `~/path/to/file.ext`) |
| `offset` | number | `1` | Starting line number (1-indexed) |
| `limit` | number | `2000` | Maximum number of lines to return |

Notes:

- file output is line-numbered
- binary files and directory paths are not supported

Success example:

```text
#path:/Users/john/file.txt
#type:file
#offset:10
#limit:2
#total:100
#has_more:true
#next_offset:12
#content_bytes:22
10: hello
11: world
```

Error example:

```text
#error:not_found
#message:File not found
#kind:file
#path:/Users/john/missing.txt
```

### `list`

List entries in a directory.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `~` | Absolute or home-relative path (e.g., `/Users/john`, `~/path/to/dir`) |
| `ignore` | string[] | - | Optional glob patterns to ignore |
| `recursive` | boolean | `false` | Recurse into subdirectories |
| `type` | `files` \| `directories` \| `all` | `all` | Which entry types to include |
| `offset` | number | `1` | Starting entry number (1-indexed) |
| `limit` | number | `100` | Maximum number of entries to return |

Notes:

- recursive mode returns a compact tree view
- ignored paths follow the rules in the `Ignored Paths` section

Success example:

```text
#path:/Users/john/project
#type:directory
#offset:1
#limit:2
#total:5
#has_more:true
#next_offset:3
#entries_bytes:30
/Users/john/project/
  src/
```

Error example:

```text
#error:not_found
#message:Directory not found
#kind:directory
#path:/Users/john/missing-dir
```

### `glob`

Match paths using a glob pattern.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `pattern` | string | - | Glob pattern to match |
| `path` | string | `~` | Absolute or home-relative path (e.g., `/Users/john`, `~/path/to/dir`) |
| `type` | `files` \| `directories` \| `all` | `files` | Which entry types to match |
| `include` | string[] | - | Optional file or directory patterns to include |
| `exclude` | string[] | - | Optional file or directory patterns to exclude |
| `offset` | number | `1` | Starting entry number (1-indexed) |
| `limit` | number | `100` | Maximum number of entries to return |

Notes:

- searches recursively
- `*.ts` only matches entries directly under the requested base path; use `**/*.ts` for nested matches
- entries are sorted by most recently modified first
- ignored paths follow the rules in the `Ignored Paths` section

Success example:

```text
#path:/Users/john/project
#type:files
#pattern:**/*.ts
#offset:1
#limit:2
#total:8
#has_more:true
#next_offset:3
#entries_bytes:63
/Users/john/project/src/index.ts
/Users/john/project/src/utils.ts
```

Error example:

```text
#error:not_found
#message:Directory not found
#kind:directory
#path:/Users/john/missing-dir
```

### `grep`

Search file contents with a regular expression.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `pattern` | string | - | Regular expression to search for |
| `path` | string | `~` | Absolute or home-relative path (e.g., `/Users/john`, `~/path/to/dir`) |
| `include` | string[] | - | Optional file patterns to include, such as `*.ts` or `*.md` |
| `exclude` | string[] | - | Optional file patterns to exclude, such as `*.test.ts` or `dist/**` |

Notes:

- searches everywhere under `path` after ignored-path filtering
- matching files are ordered by most recently modified first
- skips binary files
- ignored paths follow the rules in the `Ignored Paths` section
- skips the following special system paths:
  - `/dev`
  - `/proc`
  - `/sys`
  - `/run`
  - `/var/run`
  - `/private/var/run`
  - `/Volumes`

Success example:

```text
#path:/Users/john/project
#pattern:foo
#matches_total:2
#matches_files:1
#matches_0_path:/Users/john/project/src/index.ts
#matches_0_line:5
#matches_0_content_bytes:5
foo()
#matches_1_path:/Users/john/project/src/index.ts
#matches_1_line:9
#matches_1_content_bytes:8
foo(bar)
```

Error example:

```text
#error:invalid_pattern
#message:Invalid regular expression
#pattern:[invalid
#details:Invalid regular expression: /[invalid/u: Unterminated character class
```

## Write

### `create`

Create a new file or directory.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `file` \| `directory` | - | Whether to create a file or a directory |
| `path` | string | - | Absolute or home-relative path (e.g., `/Users/john/file.ext`, `~/path/to/dir`) |
| `content` | string | - | File content. Only used when type is `file`. |
| `overwrite` | boolean | `false` | Allow replacing an existing file. Only used when type is `file`. |
| `recursive` | boolean | `true` | Create parent directories. Only used when type is `directory`. |
| `encoding` | `utf8` \| `base64` | `utf8` | Content encoding. Only used when type is `file`. |

Notes:

- parameters that don't apply to the chosen type are rejected if set to a non-default value

Success example (file):

```text
#path:/Users/john/project/new.txt
#type:file
#status:created
#encoding:utf8
#overwritten:false
#lines:2
#bytes:12
```

Success example (directory):

```text
#path:/Users/john/project/new-dir
#type:directory
#status:created
#recursive:true
```

Error example:

```text
#error:already_exists
#message:File already exists
#kind:file
#path:/Users/john/project/existing.txt
```

### `edit`

Edit an existing file with exact text replacements.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | - | Absolute or home-relative path (e.g., `/Users/john/file.ext`, `~/path/to/file.ext`) |
| `edits` | `{ oldString, newString, replaceAll? }[]` | - | One or more exact text replacements to apply in order |
| `encoding` | `utf8` | `utf8` | File encoding |

Notes:

- edits only existing files
- edits run in order
- `replaceAll` is required when `oldString` matches more than once
- `newString` may be empty

Success example:

```text
#path:/Users/john/project/file.txt
#type:file
#status:edited
#encoding:utf8
#changes_requested:2
#changes_performed:2
```

Error example:

```text
#error:ambiguous_match
#message:oldString matched multiple times
#path:/Users/john/project/file.txt
#matches:3
#details:Use replaceAll to edit all matches
```
