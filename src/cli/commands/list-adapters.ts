import { listBuiltinAdapterIds } from "../../adapters/adapter-loader";

export function listAdaptersCommand(): number {
  const builtins = listBuiltinAdapterIds();
  if (builtins.length === 0) {
    console.log("No built-in adapters available.");
    return 0;
  }

  console.log("Built-in adapters:");
  for (const adapter of builtins) {
    console.log(`- ${adapter}`);
  }

  return 0;
}
