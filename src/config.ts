import { createConfigSchematics } from "@lmstudio/sdk"

export const configSchematics = createConfigSchematics()
  .field(
    "sandboxBaseDir",
    "string",
    {
      displayName: "Sandbox Base Directory",
      subtitle: "Optional sandbox root. Leave empty to use the user's home directory as the sandbox.",
      placeholder: "~/project",
      isParagraph: false,
    },
    "",
  )
  .build()
