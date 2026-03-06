import type { DomainAdapter } from "../../../src/types";

export const adapterWithoutDefault: DomainAdapter = {
  id: "no-default",
  name: "No Default Export Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "synth",
      name: "Synth",
      role: "synthesiser",
      persona: "Summariser",
      systemPrompt: "Summarise content."
    }
  ],
  rounds: [
    {
      id: "round-1",
      name: "Round One",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Open positions",
          turnOrder: ["synth"]
        }
      ]
    }
  ]
};
