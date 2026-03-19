import { createConfigSchematics } from "@lmstudio/sdk"

export const configSchematics = createConfigSchematics()
  .field(
    "sandboxBaseDir",
    "string",
    {
      displayName: "Sandbox Base Directory",
      subtitle: "Tools will only be allowed to operate on files within this directory. Default: ~/",
      placeholder: "~/",
      isParagraph: false,
    },
    "",
  )
  .build()
