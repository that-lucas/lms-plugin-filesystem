import { PluginContext } from "@lmstudio/sdk"
import { configSchematics } from "./config"
import { toolsProvider } from "./toolsProvider"

export async function main(ctx: PluginContext) {
  ctx.withConfigSchematics(configSchematics)
  ctx.withToolsProvider(toolsProvider)
}
