# filesystem

Filesystem tools for LM Studio.

This plugin adds a small set of practical filesystem tools to LM Studio chats.

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
- entries are sorted by most recently modified first

### `grep`

Search file contents with a regular expression.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `pattern` | string | - | Regular expression to search for |
| `path` | string | `~` | Absolute or home-relative path (e.g., `/Users/john`, `~/path/to/dir`) |
| `include` | string[] | - | Optional file patterns to include, such as `*.ts` or `*.md` |
| `exclude` | string[] | - | Optional file patterns to exclude, such as `*.test.ts` or `dist/**` |

Notes:

- searches everywhere under `path`
- matching files are ordered by most recently modified first
- matches are grouped by file path
- skips binary files
- skips the following special system paths:
  - `/dev`
  - `/proc`
  - `/sys`
  - `/run`
  - `/var/run`
  - `/private/var/run`
  - `/Volumes`

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

- parent directories are always created automatically for files
- parameters that don't apply to the chosen type are rejected if set to a non-default value
