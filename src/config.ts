import { createConfigSchematics } from "@lmstudio/sdk"

export const configSchematics = createConfigSchematics()
  .field(
    "baseDir",
    "string",
    {
      displayName: "Base Directory",
      subtitle: "Optional override. Leave empty to use the user's home directory.",
      placeholder: "/Users/name/project",
      isParagraph: false,
    },
    "",
  )
  .build()
