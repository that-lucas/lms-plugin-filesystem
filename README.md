# filesystem

Filesystem tools for LM Studio.

This plugin adds a small set of practical filesystem tools for reading files, browsing directories, searching paths, searching file contents, and making simple file edits.

For safer everyday use, consider using LM Studio's Permission system to leave the read tools (`read`, `list`, `glob`, `grep`) on Allow and the write tools (`create`, `edit`) on Ask. This is especially helpful with smaller or less capable local models. When the plugin is first installed, all tools default to Ask.

## Included Tools

- `read` — read text from a file
- `list` — browse files and directories
- `glob` — find paths by glob pattern
- `grep` — search text inside files with a regular expression
- `create` — create files and directories
- `edit` — edit existing text files with exact replacements

## Installing

Install from LM Studio here: `https://lmstudio.ai/that-lucas/filesystem`

Click the "Run in LM Studio" button to add the plugin.

## Requirements

- `glob` and `grep` require `rg` (ripgrep) to be installed on the machine

## Ignored Paths

Traversal tools (`list`, `glob`, and `grep`) respect the `LMS_FILESYSTEM_IGNORE_PATHS` environment variable.

If `LMS_FILESYSTEM_IGNORE_PATHS` is unset, the built-in ignored paths are:

- `.git`, `node_modules`, `dist`, `build`, `target`, `vendor`, `bin`, `obj`
- `.idea`, `.vscode`, `.zig-cache`, `zig-out`
- `.coverage`, `coverage`, `tmp`, `temp`, `.cache`, `cache`, `logs`
- `.venv`, `venv`, `env`

If `LMS_FILESYSTEM_IGNORE_PATHS` is set, it replaces the built-in list entirely.

- Format: semicolon-separated glob patterns, for example `dist;coverage;generated;generated/**`
- To ignore both a directory and everything below it, include both forms, for example `generated;generated/**`
- If set to an empty value, the built-in ignore list is disabled

## Notes

The plugin can be scoped to a base directory through its LM Studio configuration. If not set, the default base directory is the user's home directory (`~/`).

The detailed tool definitions and parameter docs are exposed directly to LM Studio through the tool schemas.
